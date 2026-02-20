import fs from 'fs';
import path from 'path';
import { Settings, AgentConfig, TeamConfig, CLAUDE_MODEL_IDS, CODEX_MODEL_IDS } from './types';
import { resolveStateHome } from './state-home';

export const SCRIPT_DIR = path.resolve(__dirname, '../..');
const stateHomeInfo = resolveStateHome(SCRIPT_DIR);

export const TINYAGI_HOME = stateHomeInfo.home;
// Backward-compatible export name used throughout the existing codebase.
export const TINYCLAW_HOME = TINYAGI_HOME;
export const STATE_MIGRATED = stateHomeInfo.migrated;
export const STATE_MIGRATION_LOG = stateHomeInfo.migrationLog;

export const QUEUE_INCOMING = path.join(TINYAGI_HOME, 'queue/incoming');
export const QUEUE_OUTGOING = path.join(TINYAGI_HOME, 'queue/outgoing');
export const QUEUE_PROCESSING = path.join(TINYAGI_HOME, 'queue/processing');
export const LOG_FILE = path.join(TINYAGI_HOME, 'logs/queue.log');
export const SETTINGS_FILE = path.join(TINYAGI_HOME, 'settings.json');
export const EVENTS_DIR = path.join(TINYAGI_HOME, 'events');
export const CHATS_DIR = path.join(TINYAGI_HOME, 'chats');
export const FILES_DIR = path.join(TINYAGI_HOME, 'files');
export const HARNESS_DIR = path.join(TINYAGI_HOME, 'harness');
export const HARNESS_DB_FILE = path.join(HARNESS_DIR, 'state.db');
export const MEMORY_DIR = path.join(TINYAGI_HOME, 'memory');

export interface HarnessSettingsResolved {
    enabled: boolean;
    autonomy: 'low' | 'normal' | 'strict';
    quiet_hours: {
        start: string;
        end: string;
    };
    digest_time: string;
    browser: {
        enabled: boolean;
        provider: 'auto' | 'cdp' | 'chrome-devtools-mcp';
        profile_path: string;
        profile_directory: string;
        debugger_url: string;
        debugger_ports: number[];
        mcp_channel: 'stable' | 'canary' | 'beta' | 'dev';
        open_domain_access: boolean;
        hard_stop_payments: boolean;
        use_claude_chrome: boolean;
    };
}

function parseBrowserPorts(input: unknown): number[] {
    if (!Array.isArray(input)) return [];
    return input
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0 && value <= 65535);
}

function parseBrowserProvider(input: unknown): 'auto' | 'cdp' | 'chrome-devtools-mcp' {
    const normalized = String(input || '').trim().toLowerCase();
    if (normalized === 'cdp') return 'cdp';
    if (normalized === 'chrome-devtools-mcp' || normalized === 'chrome_devtools_mcp' || normalized === 'mcp') {
        return 'chrome-devtools-mcp';
    }
    return 'auto';
}

function parseMcpChannel(input: unknown): 'stable' | 'canary' | 'beta' | 'dev' {
    const normalized = String(input || '').trim().toLowerCase();
    if (normalized === 'canary') return 'canary';
    if (normalized === 'beta') return 'beta';
    if (normalized === 'dev') return 'dev';
    return 'stable';
}

export function getSettings(): Settings {
    try {
        const settingsData = fs.readFileSync(SETTINGS_FILE, 'utf8');
        const settings: Settings = JSON.parse(settingsData);

        // Auto-detect provider if not specified
        if (!settings?.models?.provider) {
            if (settings?.models?.openai) {
                if (!settings.models) settings.models = {};
                settings.models.provider = 'openai';
            } else if (settings?.models?.anthropic) {
                if (!settings.models) settings.models = {};
                settings.models.provider = 'anthropic';
            }
        }

        return settings;
    } catch {
        return {};
    }
}

export function saveSettings(next: Settings): void {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    const tmp = `${SETTINGS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, SETTINGS_FILE);
}

export function getHarnessSettings(settings?: Settings): HarnessSettingsResolved {
    const src = settings || getSettings();
    return {
        enabled: src.harness?.enabled ?? false,
        autonomy: src.harness?.autonomy ?? 'normal',
        quiet_hours: {
            start: src.harness?.quiet_hours?.start || '00:00',
            end: src.harness?.quiet_hours?.end || '06:30',
        },
        digest_time: src.harness?.digest_time || '08:30',
        browser: {
            enabled: src.harness?.browser?.enabled ?? true,
            provider: parseBrowserProvider(src.harness?.browser?.provider),
            profile_path: src.harness?.browser?.profile_path || '',
            profile_directory: src.harness?.browser?.profile_directory || '',
            debugger_url: src.harness?.browser?.debugger_url || '',
            debugger_ports: parseBrowserPorts(src.harness?.browser?.debugger_ports),
            mcp_channel: parseMcpChannel(src.harness?.browser?.mcp_channel),
            open_domain_access: src.harness?.browser?.open_domain_access ?? true,
            hard_stop_payments: src.harness?.browser?.hard_stop_payments ?? true,
            use_claude_chrome: src.harness?.browser?.use_claude_chrome ?? true,
        },
    };
}

export function setHarnessEnabled(enabled: boolean): void {
    const settings = getSettings();
    if (!settings.harness) settings.harness = {};
    settings.harness.enabled = enabled;
    saveSettings(settings);
}

/**
 * Build the default agent config from the legacy models section.
 * Used when no agents are configured, for backwards compatibility.
 */
export function getDefaultAgentFromModels(settings: Settings): AgentConfig {
    const provider = settings?.models?.provider || 'anthropic';
    let model = '';
    if (provider === 'openai') {
        model = settings?.models?.openai?.model || 'gpt-5-codex';
    } else {
        model = settings?.models?.anthropic?.model || 'claude-opus-4-6';
    }

    // Get workspace path from settings or use default
    const workspacePath = settings?.workspace?.path || path.join(require('os').homedir(), 'tinyagi-workspace');
    const defaultAgentDir = path.join(workspacePath, 'default');

    return {
        name: 'Default',
        provider,
        model,
        working_directory: defaultAgentDir,
    };
}

/**
 * Get all configured agents. Falls back to a single "default" agent
 * derived from the legacy models section if no agents are configured.
 */
export function getAgents(settings: Settings): Record<string, AgentConfig> {
    if (settings.agents && Object.keys(settings.agents).length > 0) {
        return settings.agents;
    }
    // Fall back to default agent from models section
    return { default: getDefaultAgentFromModels(settings) };
}

/**
 * Get all configured teams.
 */
export function getTeams(settings: Settings): Record<string, TeamConfig> {
    return settings.teams || {};
}

/**
 * Resolve the model ID for Claude (Anthropic).
 */
export function resolveClaudeModel(model: string): string {
    return CLAUDE_MODEL_IDS[model] || model || '';
}

/**
 * Resolve the model ID for Codex (OpenAI).
 */
export function resolveCodexModel(model: string): string {
    return CODEX_MODEL_IDS[model] || model || '';
}
