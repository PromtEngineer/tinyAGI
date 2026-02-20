import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import { getHarnessSettings, HARNESS_DIR } from '../../lib/config';
import { appendBrowserAudit, listBrowserSessions, upsertBrowserSession } from '../repository';

const DEFAULT_DEBUGGER_PORTS = [9222, 9223, 9229, 9230, 9333, 9444, 9555, 9559];
const PROFILE_MIRROR_DIR = path.join(HARNESS_DIR, 'browser-profile-mirror');
const PROFILE_MIRROR_USER_DATA = path.join(PROFILE_MIRROR_DIR, 'User Data');
const PROFILE_MIRROR_META = path.join(PROFILE_MIRROR_DIR, 'meta.json');
const PROFILE_MIRROR_MAX_AGE_MS = 2 * 60 * 1000;
const MIRROR_EXCLUDED_DIRS = new Set([
    'Cache',
    'Code Cache',
    'GPUCache',
    'ShaderCache',
    'GrShaderCache',
    'DawnCache',
    'Media Cache',
]);

export interface BrowserLaunchProfile {
    userDataDir: string;
    profileDirectory: string;
    source: string;
    mirrored: boolean;
}

function defaultChromeProfilePath(): string {
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    }
    if (process.platform === 'win32') {
        return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
    }
    return path.join(os.homedir(), '.config', 'google-chrome');
}

function pathEntryExists(entryPath: string): boolean {
    try {
        fs.lstatSync(entryPath);
        return true;
    } catch {
        return false;
    }
}

function profileLocked(userDataDir: string): boolean {
    const lockFiles = [
        path.join(userDataDir, 'SingletonLock'),
        path.join(userDataDir, 'SingletonCookie'),
        path.join(userDataDir, 'SingletonSocket'),
    ];
    return lockFiles.some(pathEntryExists);
}

function looksLikeProfileDirectoryName(name: string): boolean {
    return name === 'Default'
        || /^Profile \d+$/i.test(name)
        || /^Guest Profile$/i.test(name)
        || /^System Profile$/i.test(name);
}

function normalizePath(raw: string): string {
    const expanded = raw.startsWith('~/')
        ? path.join(os.homedir(), raw.slice(2))
        : raw;
    return path.resolve(expanded);
}

function resolveConfiguredProfilePath(): { path: string; source: string } {
    const settings = getHarnessSettings();
    const envPath = process.env.TINYAGI_BROWSER_PROFILE_PATH?.trim();
    if (envPath) {
        return { path: normalizePath(envPath), source: 'env.TINYAGI_BROWSER_PROFILE_PATH' };
    }
    if (settings.browser.profile_path?.trim()) {
        return { path: normalizePath(settings.browser.profile_path), source: 'settings.browser.profile_path' };
    }
    return { path: defaultChromeProfilePath(), source: 'default_profile_path' };
}

function resolveConfiguredProfileDirectory(): { profileDirectory: string; source: string } {
    const settings = getHarnessSettings();
    const envDir = process.env.TINYAGI_BROWSER_PROFILE_DIRECTORY?.trim();
    if (envDir) {
        return { profileDirectory: envDir, source: 'env.TINYAGI_BROWSER_PROFILE_DIRECTORY' };
    }
    if (settings.browser.profile_directory?.trim()) {
        return { profileDirectory: settings.browser.profile_directory, source: 'settings.browser.profile_directory' };
    }
    return { profileDirectory: '', source: '' };
}

function detectLastUsedProfileDirectory(userDataDir: string): string {
    const localState = path.join(userDataDir, 'Local State');
    try {
        if (!fs.existsSync(localState)) return '';
        const raw = JSON.parse(fs.readFileSync(localState, 'utf8')) as {
            profile?: {
                last_used?: string;
                last_active_profiles?: string[];
            };
        };
        const lastUsed = String(raw.profile?.last_used || '').trim();
        if (lastUsed && looksLikeProfileDirectoryName(lastUsed)) {
            return lastUsed;
        }

        const lastActive = Array.isArray(raw.profile?.last_active_profiles)
            ? raw.profile?.last_active_profiles || []
            : [];
        for (const entry of lastActive) {
            const profileName = String(entry || '').trim();
            if (profileName && looksLikeProfileDirectoryName(profileName)) {
                return profileName;
            }
        }
    } catch {
        // Ignore invalid local state file and fall back.
    }
    return '';
}

function detectExistingProfileDirectory(userDataDir: string): string {
    if (pathEntryExists(path.join(userDataDir, 'Default'))) {
        return 'Default';
    }

    try {
        const entries = fs.readdirSync(userDataDir, { withFileTypes: true });
        const candidate = entries.find((entry) => entry.isDirectory() && looksLikeProfileDirectoryName(entry.name));
        return candidate?.name || '';
    } catch {
        return '';
    }
}

function profileExists(userDataDir: string, profileDirectory: string): boolean {
    return profileDirectory.trim().length > 0
        && pathEntryExists(path.join(userDataDir, profileDirectory));
}

function computeBaseLaunchProfile(): BrowserLaunchProfile {
    const configuredPath = resolveConfiguredProfilePath();
    const configuredProfileDir = resolveConfiguredProfileDirectory();

    let userDataDir = configuredPath.path;
    let profileDirectory = '';
    let source = configuredPath.source;

    const basename = path.basename(configuredPath.path);
    const parent = path.dirname(configuredPath.path);
    if (looksLikeProfileDirectoryName(basename) && pathEntryExists(path.join(parent, 'Local State'))) {
        userDataDir = parent;
        profileDirectory = basename;
        source = `${configuredPath.source}:profile_dir_path`;
    }

    if (!profileDirectory && configuredProfileDir.profileDirectory) {
        profileDirectory = configuredProfileDir.profileDirectory;
        source = configuredProfileDir.source;
    }

    if (!profileDirectory) {
        profileDirectory = detectLastUsedProfileDirectory(userDataDir) || detectExistingProfileDirectory(userDataDir) || 'Default';
        source = `${source}:auto_last_used`;
    }

    if (!profileExists(userDataDir, profileDirectory)) {
        const fallback = detectExistingProfileDirectory(userDataDir);
        if (fallback) {
            profileDirectory = fallback;
            source = `${source}:fallback_existing`;
        }
    }

    return {
        userDataDir,
        profileDirectory,
        source,
        mirrored: false,
    };
}

function ensureProfileMirror(profile: BrowserLaunchProfile): BrowserLaunchProfile | null {
    const sourceProfilePath = path.join(profile.userDataDir, profile.profileDirectory);
    if (!pathEntryExists(profile.userDataDir) || !pathEntryExists(sourceProfilePath)) {
        return null;
    }

    let refreshMirror = true;
    try {
        if (pathEntryExists(PROFILE_MIRROR_META) && pathEntryExists(path.join(PROFILE_MIRROR_USER_DATA, profile.profileDirectory))) {
            const raw = JSON.parse(fs.readFileSync(PROFILE_MIRROR_META, 'utf8')) as {
                sourceUserDataDir?: string;
                profileDirectory?: string;
                preparedAt?: number;
            };
            if (raw.sourceUserDataDir === profile.userDataDir && raw.profileDirectory === profile.profileDirectory) {
                const preparedAt = Number(raw.preparedAt || 0);
                if (preparedAt > 0 && Date.now() - preparedAt < PROFILE_MIRROR_MAX_AGE_MS) {
                    refreshMirror = false;
                }
            }
        }
    } catch {
        refreshMirror = true;
    }

    if (refreshMirror) {
        fs.rmSync(PROFILE_MIRROR_USER_DATA, { recursive: true, force: true });
        fs.mkdirSync(PROFILE_MIRROR_USER_DATA, { recursive: true });

        const sourceLocalState = path.join(profile.userDataDir, 'Local State');
        if (pathEntryExists(sourceLocalState)) {
            fs.copyFileSync(sourceLocalState, path.join(PROFILE_MIRROR_USER_DATA, 'Local State'));
        }

        fs.cpSync(sourceProfilePath, path.join(PROFILE_MIRROR_USER_DATA, profile.profileDirectory), {
            recursive: true,
            force: true,
            dereference: false,
            filter: (srcPath: string) => {
                const base = path.basename(srcPath);
                return !MIRROR_EXCLUDED_DIRS.has(base);
            },
        });

        fs.mkdirSync(PROFILE_MIRROR_DIR, { recursive: true });
        fs.writeFileSync(PROFILE_MIRROR_META, JSON.stringify({
            sourceUserDataDir: profile.userDataDir,
            profileDirectory: profile.profileDirectory,
            preparedAt: Date.now(),
        }, null, 2));
    }

    return {
        userDataDir: PROFILE_MIRROR_USER_DATA,
        profileDirectory: profile.profileDirectory,
        source: `${profile.source}:mirror`,
        mirrored: true,
    };
}

function launchProfilePath(profile: BrowserLaunchProfile): string {
    return path.join(profile.userDataDir, profile.profileDirectory);
}

export function resolveBrowserLaunchProfile(preferMirrorWhenLocked = false): BrowserLaunchProfile {
    const base = computeBaseLaunchProfile();
    if (!preferMirrorWhenLocked) {
        return base;
    }
    const mirrored = ensureProfileMirror(base);
    return mirrored || base;
}

interface DebuggerTarget {
    source: string;
    connectUrl: string;
    host: string;
    port: number;
    secure: boolean;
}

function parsePortToken(value: string): number {
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return 0;
    return parsed;
}

function parsePortsFromEnv(): number[] {
    const raw = process.env.TINYAGI_BROWSER_DEBUGGER_PORTS || '';
    if (!raw.trim()) return [];
    return raw.split(',').map(parsePortToken).filter(Boolean);
}

function parseDebuggerTarget(raw: string, source: string): DebuggerTarget | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    if (/^\d+$/.test(trimmed)) {
        const port = parsePortToken(trimmed);
        if (!port) return null;
        return {
            source,
            connectUrl: `http://127.0.0.1:${port}`,
            host: '127.0.0.1',
            port,
            secure: false,
        };
    }

    let normalized = trimmed;
    if (!/^[a-z]+:\/\//i.test(normalized)) {
        normalized = `http://${normalized}`;
    }

    try {
        const url = new URL(normalized);
        const isWs = url.protocol === 'ws:' || url.protocol === 'wss:';
        const secure = url.protocol === 'https:' || url.protocol === 'wss:';
        const fallbackPort = secure ? 443 : 80;
        const port = parsePortToken(url.port || `${fallbackPort}`);
        if (!port) return null;
        const connectUrl = isWs
            ? normalized.replace(/\/+$/, '')
            : `${url.protocol}//${url.hostname}:${port}`;
        return {
            source,
            connectUrl,
            host: url.hostname || '127.0.0.1',
            port,
            secure,
        };
    } catch {
        return null;
    }
}

function localPortTarget(port: number, source: string): DebuggerTarget | null {
    const safePort = parsePortToken(String(port));
    if (!safePort) return null;
    return {
        source,
        connectUrl: `http://127.0.0.1:${safePort}`,
        host: '127.0.0.1',
        port: safePort,
        secure: false,
    };
}

function runProcessCheck(command: string, args: string[]): boolean {
    try {
        const result = spawnSync(command, args, { stdio: 'ignore' });
        return result.status === 0;
    } catch {
        return false;
    }
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function isChromeProcessRunning(): boolean {
    if (process.platform === 'darwin') {
        return runProcessCheck('pgrep', ['-x', 'Google Chrome'])
            || runProcessCheck('pgrep', ['-f', 'Google Chrome.app/Contents/MacOS/Google Chrome']);
    }
    if (process.platform === 'linux') {
        return runProcessCheck('pgrep', ['-x', 'google-chrome'])
            || runProcessCheck('pgrep', ['-x', 'chrome'])
            || runProcessCheck('pgrep', ['-x', 'chromium']);
    }
    if (process.platform === 'win32') {
        return runProcessCheck('cmd', ['/c', 'tasklist | findstr /I "chrome.exe"']);
    }
    return false;
}

function normalizeForCompare(rawPath: string): string {
    if (!rawPath) return '';
    try {
        return normalizePath(rawPath);
    } catch {
        return rawPath;
    }
}

function collectDebuggerTargets(preferredProfile: BrowserLaunchProfile): DebuggerTarget[] {
    const settings = getHarnessSettings();
    const targets: DebuggerTarget[] = [];

    const addTarget = (target: DebuggerTarget | null): void => {
        if (!target) return;
        const key = `${target.host}:${target.port}:${target.connectUrl}`;
        if (targets.some(existing => `${existing.host}:${existing.port}:${existing.connectUrl}` === key)) {
            return;
        }
        targets.push(target);
    };

    addTarget(parseDebuggerTarget(settings.browser.debugger_url || '', 'settings.debugger_url'));
    addTarget(parseDebuggerTarget(process.env.TINYAGI_BROWSER_DEBUGGER_URL || '', 'env.TINYAGI_BROWSER_DEBUGGER_URL'));

    for (const port of settings.browser.debugger_ports || []) {
        addTarget(localPortTarget(port, 'settings.debugger_ports'));
    }
    for (const port of parsePortsFromEnv()) {
        addTarget(localPortTarget(port, 'env.TINYAGI_BROWSER_DEBUGGER_PORTS'));
    }

    const preferredProfilePath = normalizeForCompare(launchProfilePath(preferredProfile));
    const preferredUserDataDir = normalizeForCompare(preferredProfile.userDataDir);

    for (const row of listBrowserSessions()) {
        if (row.status !== 'active') continue;
        if (!isProcessAlive(Number(row.chrome_pid || 0))) continue;
        const rowProfilePath = normalizeForCompare(row.profile_path || '');
        if (preferredProfilePath && rowProfilePath && rowProfilePath !== preferredProfilePath) {
            // Ignore known sessions from a different profile to avoid attaching
            // to stale or unrelated debuggers.
            if (!rowProfilePath.startsWith(`${preferredUserDataDir}${path.sep}`)) {
                continue;
            }
        }
        addTarget(parseDebuggerTarget(row.debugger_url || '', 'known_session'));
    }

    return targets;
}

function isDebuggerAlive(target: DebuggerTarget): Promise<boolean> {
    const client = target.secure ? https : http;
    return new Promise((resolve) => {
        const req = client.get({
            host: target.host,
            port: target.port,
            path: '/json/version',
            timeout: 800,
        }, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}

function getChromeBinaryCandidates(): string[] {
    if (process.platform === 'darwin') {
        return [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
            'google-chrome',
            'chrome',
            'chromium',
        ];
    }
    if (process.platform === 'win32') {
        return [
            path.join(process.env['PROGRAMFILES'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            'chrome.exe',
        ];
    }
    return ['google-chrome', 'chromium-browser', 'chromium', 'chrome'];
}

function findChromeBinary(): string {
    const candidates = getChromeBinaryCandidates();
    for (const c of candidates) {
        if (c.includes(path.sep)) {
            if (fs.existsSync(c)) return c;
            continue;
        }
        return c;
    }
    return 'google-chrome';
}

async function waitForDebugger(port: number, ms: number): Promise<boolean> {
    const target = localPortTarget(port, 'spawn');
    if (!target) return false;
    const start = Date.now();
    while (Date.now() - start < ms) {
        // eslint-disable-next-line no-await-in-loop
        if (await isDebuggerAlive(target)) return true;
        // eslint-disable-next-line no-await-in-loop
        await new Promise(r => setTimeout(r, 250));
    }
    return false;
}

function randomPort(): number {
    return 9222 + Math.floor(Math.random() * 400);
}

export interface BrowserSessionResult {
    ok: boolean;
    sessionId?: string;
    debuggerUrl?: string;
    profilePath?: string;
    message: string;
}

async function findLiveDebuggerTarget(preferredProfile: BrowserLaunchProfile): Promise<DebuggerTarget | null> {
    const targets = collectDebuggerTargets(preferredProfile);
    for (const target of targets) {
        // eslint-disable-next-line no-await-in-loop
        if (await isDebuggerAlive(target)) {
            return target;
        }
    }
    return null;
}

function buildSessionIdFromTarget(target: DebuggerTarget): string {
    const hostSafe = target.host.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `session_${hostSafe}_${target.port}`;
}

export async function ensureBrowserSession(): Promise<BrowserSessionResult> {
    const settings = getHarnessSettings();
    if (!settings.browser.enabled) {
        return {
            ok: false,
            message: 'Browser runtime is disabled in harness settings.',
        };
    }

    if (settings.browser.provider === 'chrome-devtools-mcp') {
        const sessionId = 'session_chrome_devtools_mcp';
        const profile = resolveBrowserLaunchProfile(true);
        upsertBrowserSession({
            session_id: sessionId,
            profile_path: launchProfilePath(profile),
            debugger_url: 'mcp://chrome-devtools',
            chrome_pid: 0,
            status: 'active',
            created_at: Date.now(),
            updated_at: Date.now(),
        });
        return {
            ok: true,
            sessionId,
            debuggerUrl: 'mcp://chrome-devtools',
            profilePath: launchProfilePath(profile),
            message: 'Browser provider is chrome-devtools-mcp; CDP attach skipped.',
        };
    }

    const baseProfile = resolveBrowserLaunchProfile(false);
    const liveTarget = await findLiveDebuggerTarget(baseProfile);
    if (liveTarget) {
        const sessionId = buildSessionIdFromTarget(liveTarget);
        upsertBrowserSession({
            session_id: sessionId,
            profile_path: launchProfilePath(baseProfile),
            debugger_url: liveTarget.connectUrl,
            chrome_pid: 0,
            status: 'active',
            created_at: Date.now(),
            updated_at: Date.now(),
        });
        return {
            ok: true,
            sessionId,
            debuggerUrl: liveTarget.connectUrl,
            profilePath: launchProfilePath(baseProfile),
            message: `Attached to existing Chrome debugger at ${liveTarget.connectUrl} (${liveTarget.source}).`,
        };
    }

    const locked = profileLocked(baseProfile.userDataDir);
    const chromeRunning = isChromeProcessRunning();
    let launchProfile = baseProfile;
    if (locked || chromeRunning) {
        const mirrored = resolveBrowserLaunchProfile(true);
        if (!mirrored.mirrored) {
            return {
                ok: false,
                message: `Chrome is already running (profile lock=${locked ? 'yes' : 'no'}) but no reachable debugger endpoint was found. tinyAGI could not prepare a mirrored profile from ${launchProfilePath(baseProfile)}. Configure harness.browser.debugger_url or harness.browser.debugger_ports to an existing DevTools endpoint and retry.`,
                profilePath: launchProfilePath(baseProfile),
            };
        }
        launchProfile = mirrored;
    }

    if (!profileExists(launchProfile.userDataDir, launchProfile.profileDirectory)) {
        return {
            ok: false,
            message: `Chrome profile directory not found: ${launchProfilePath(launchProfile)}. Set harness.browser.profile_path/profile_directory and retry.`,
            profilePath: launchProfilePath(launchProfile),
        };
    }

    const chromeBin = findChromeBinary();
    const port = randomPort();

    const args = [
        `--remote-debugging-port=${port}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-popup-blocking',
        '--disable-background-networking',
        `--user-data-dir=${launchProfile.userDataDir}`,
        `--profile-directory=${launchProfile.profileDirectory}`,
    ];

    let child: ChildProcess;
    try {
        child = spawn(chromeBin, args, {
            detached: true,
            stdio: 'ignore',
        });
    } catch (error) {
        return {
            ok: false,
            profilePath: launchProfilePath(launchProfile),
            message: `Failed to launch Chrome binary '${chromeBin}': ${(error as Error).message}`,
        };
    }
    child.unref();

    const ready = await waitForDebugger(port, 12000);
    const sessionId = `session_${port}`;
    const debuggerUrl = `http://127.0.0.1:${port}`;

    upsertBrowserSession({
        session_id: sessionId,
        profile_path: launchProfilePath(launchProfile),
        debugger_url: debuggerUrl,
        chrome_pid: child.pid || 0,
        status: ready ? 'active' : 'error',
        created_at: Date.now(),
        updated_at: Date.now(),
    });

    const auditDir = path.join(HARNESS_DIR, 'browser-audit', sessionId);
    fs.mkdirSync(auditDir, { recursive: true });
    appendBrowserAudit({
        actionId: `session_boot_${sessionId}`,
        runId: 'system',
        step: 'session_start',
        url: debuggerUrl,
        details: {
            profilePath: launchProfilePath(launchProfile),
            profileDirectory: launchProfile.profileDirectory,
            mirrored: launchProfile.mirrored,
            source: launchProfile.source,
            chromeBin,
            port,
            ready,
        },
    });

    if (!ready) {
        return {
            ok: false,
            sessionId,
            debuggerUrl,
            profilePath: launchProfilePath(launchProfile),
            message: 'Chrome started but debugger did not become ready in time.',
        };
    }

    return {
        ok: true,
        sessionId,
        debuggerUrl,
        profilePath: launchProfilePath(launchProfile),
        message: `Chrome automation session ready on ${debuggerUrl} using profile ${launchProfile.profileDirectory}${launchProfile.mirrored ? ' (mirrored snapshot)' : ''}.`,
    };
}

export function renderBrowserSessions(): string {
    const rows = listBrowserSessions();
    if (rows.length === 0) {
        return 'No browser sessions found.';
    }

    const lines = ['Browser sessions:'];
    for (const row of rows) {
        lines.push(`- ${row.session_id} status=${row.status} debugger=${row.debugger_url} profile=${row.profile_path}`);
    }

    return lines.join('\n');
}
