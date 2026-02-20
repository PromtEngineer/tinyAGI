import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { HARNESS_DIR, HarnessSettingsResolved, getHarnessSettings } from '../../lib/config';
import {
    appendBrowserAudit,
    createBrowserActionRequest,
    createBrowserApprovalRequest,
    listBrowserTabs,
    updateBrowserActionStatus,
    upsertBrowserSession,
    upsertBrowserTab,
} from '../repository';
import { BrowserLaunchProfile, BrowserSessionResult, ensureBrowserSession, resolveBrowserLaunchProfile } from './runtime';
import { RiskLevel } from '../types';

export interface BrowserActionStep {
    type: 'navigate' | 'click' | 'type' | 'fill' | 'wait_for' | 'press' | 'screenshot' | 'extract_text';
    selector?: string;
    value?: string;
    url?: string;
}

export interface BrowserPlan {
    url?: string;
    actions: BrowserActionStep[];
}

interface SelectorTraceEntry {
    timestamp: number;
    actionId: string;
    stepType: BrowserActionStep['type'];
    selector?: string;
    value?: string;
    url: string;
    attempt: number;
    outcome: 'success' | 'failure' | 'checkpoint';
    error?: string;
}

interface PageState {
    url: string;
    title: string;
    text: string;
}

interface JsonRpcMessage {
    jsonrpc: '2.0';
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: {
        code?: number;
        message?: string;
        [key: string]: unknown;
    };
}

export interface BrowserExecutionInput {
    runId: string;
    userId: string;
    objective: string;
    candidateOutput?: string;
    risk: RiskLevel;
}

export interface BrowserExecutionResult {
    status: 'completed' | 'needs_approval' | 'needs_input' | 'failed';
    message: string;
    requestId?: string;
    artifacts?: string[];
}

const MAX_RETRIES = 3;
const MCP_PROTOCOL_VERSION = '2024-11-05';

function extractUrl(text: string): string {
    const match = text.match(/https?:\/\/[^\s)]+/i);
    return match ? match[0] : '';
}

function cleanToken(raw: string): string {
    return raw.trim().replace(/^['"`]/, '').replace(/['"`]$/, '').trim();
}

function normalizeSelector(raw: string): string {
    const cleaned = cleanToken(raw);
    if (!cleaned) return '';

    if (/^(text=|xpath=|css=)/i.test(cleaned)) return cleaned;
    if (/^[#.\[]/.test(cleaned)) return cleaned;
    if (/\s/.test(cleaned)) return `text=${cleaned}`;
    if (/^[a-zA-Z][\w-]*$/.test(cleaned)) return cleaned;
    return `text=${cleaned}`;
}

function parseBrowserPlan(objective: string, candidateOutput = ''): BrowserPlan {
    const source = `${objective}\n${candidateOutput}`;
    const lines = source
        .split(/\n|;/)
        .map(l => l.trim())
        .filter(Boolean);

    const actions: BrowserActionStep[] = [];
    const url = extractUrl(source);
    if (url) {
        actions.push({ type: 'navigate', url });
    }

    for (const line of lines) {
        let m: RegExpMatchArray | null;

        m = line.match(/^click\s+(.+)$/i);
        if (m) {
            actions.push({ type: 'click', selector: normalizeSelector(m[1]) });
            continue;
        }

        m = line.match(/^type\s+['"`](.+)['"`]\s+into\s+(.+)$/i);
        if (m) {
            actions.push({ type: 'type', value: cleanToken(m[1]), selector: normalizeSelector(m[2]) });
            continue;
        }

        m = line.match(/^fill\s+(.+?)\s+with\s+['"`](.+)['"`]$/i);
        if (m) {
            actions.push({ type: 'fill', selector: normalizeSelector(m[1]), value: cleanToken(m[2]) });
            continue;
        }

        m = line.match(/^wait\s+for\s+(.+)$/i);
        if (m) {
            actions.push({ type: 'wait_for', selector: normalizeSelector(m[1]) });
            continue;
        }

        m = line.match(/^press\s+([a-z0-9_+.-]+)$/i);
        if (m) {
            actions.push({ type: 'press', value: m[1].toUpperCase() });
            continue;
        }

        m = line.match(/^(capture|take)?\s*screenshot$/i);
        if (m) {
            actions.push({ type: 'screenshot' });
            continue;
        }

        m = line.match(/^extract\s+(?:text|content)\s+from\s+(.+)$/i);
        if (m) {
            actions.push({ type: 'extract_text', selector: normalizeSelector(m[1]) });
            continue;
        }
    }

    if (actions.length === 0 && url) {
        actions.push({ type: 'screenshot' });
    }

    return {
        url: url || undefined,
        actions,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isPaymentStep(step: BrowserActionStep): boolean {
    const blob = [step.selector || '', step.value || '', step.url || ''].join(' ').toLowerCase();
    return /(pay|payment|checkout|purchase|buy now|confirm order|wallet|transfer|card number|cvv)/.test(blob);
}

function detectHumanCheckpointFromBlob(blobInput: string): { kind: string; details: string } | null {
    const blob = (blobInput || '').toLowerCase();

    if (/(captcha|recaptcha|hcaptcha|verify you are human|cf-challenge|cloudflare challenge)/.test(blob)) {
        return { kind: 'captcha', details: 'CAPTCHA or anti-bot challenge detected.' };
    }

    if (/(two-factor|2fa|one-time code|otp|verification code)/.test(blob)) {
        return { kind: '2fa', details: 'Two-factor authentication checkpoint detected.' };
    }

    if (/(session expired|login expired|sign in again|please log in)/.test(blob)) {
        return { kind: 'session_expired', details: 'Session/login expired checkpoint detected.' };
    }

    return null;
}

async function detectHumanCheckpoint(page: any): Promise<{ kind: string; details: string } | null> {
    const url = (page.url() || '').toLowerCase();
    const content = ((await page.content()) || '').toLowerCase();
    return detectHumanCheckpointFromBlob(`${url}\n${content}`);
}

async function captureScreenshot(page: any, filePath: string): Promise<string> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
}

async function runStep(page: any, step: BrowserActionStep): Promise<{ value?: string }> {
    switch (step.type) {
        case 'navigate':
            if (!step.url) throw new Error('navigate step missing url');
            await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            return {};

        case 'click':
            if (!step.selector) throw new Error('click step missing selector');
            await page.waitForSelector(step.selector, { timeout: 15000 });
            await page.click(step.selector, { timeout: 15000 });
            return {};

        case 'type':
        case 'fill':
            if (!step.selector) throw new Error(`${step.type} step missing selector`);
            await page.waitForSelector(step.selector, { timeout: 15000 });
            await page.fill(step.selector, step.value || '', { timeout: 15000 });
            return {};

        case 'wait_for':
            if (!step.selector) throw new Error('wait_for step missing selector');
            await page.waitForSelector(step.selector, { timeout: 20000 });
            return {};

        case 'press':
            if (!step.value) throw new Error('press step missing key');
            await page.keyboard.press(step.value);
            return {};

        case 'extract_text':
            if (!step.selector) throw new Error('extract_text step missing selector');
            await page.waitForSelector(step.selector, { timeout: 15000 });
            const txt = await page.textContent(step.selector, { timeout: 10000 });
            return { value: (txt || '').trim() };

        case 'screenshot':
            return {};

        default:
            throw new Error(`Unsupported browser step ${(step as BrowserActionStep).type}`);
    }
}

function stripForId(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
}

function extractToolText(result: any): string {
    if (!result || !Array.isArray(result.content)) return '';
    const lines = result.content
        .filter((item: any) => item && item.type === 'text' && typeof item.text === 'string')
        .map((item: any) => item.text.trim())
        .filter(Boolean);
    return lines.join('\n');
}

function tryParseJson(raw: string): unknown | null {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function parseEvaluateResult(toolText: string): unknown {
    const fenced = toolText.match(/```json\s*([\s\S]*?)\s*```/i);
    if (fenced) {
        const parsed = tryParseJson(fenced[1]);
        if (parsed !== null) return parsed;
    }

    const trimmed = toolText.trim();
    const direct = tryParseJson(trimmed);
    if (direct !== null) return direct;

    const objectStart = trimmed.indexOf('{');
    const objectEnd = trimmed.lastIndexOf('}');
    if (objectStart !== -1 && objectEnd > objectStart) {
        const objectCandidate = trimmed.slice(objectStart, objectEnd + 1);
        const parsed = tryParseJson(objectCandidate);
        if (parsed !== null) return parsed;
    }

    const arrayStart = trimmed.indexOf('[');
    const arrayEnd = trimmed.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
        const arrayCandidate = trimmed.slice(arrayStart, arrayEnd + 1);
        const parsed = tryParseJson(arrayCandidate);
        if (parsed !== null) return parsed;
    }

    throw new Error(`Unable to parse evaluate_script response: ${trimmed.slice(0, 300)}`);
}

class ChromeDevtoolsMcpClient {
    private child: ChildProcessWithoutNullStreams | null = null;

    private buffer = '';

    private nextId = 1;

    private pending = new Map<number, {
        method: string;
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
    }>();

    private stderrTail: string[] = [];

    constructor(
        private readonly channel: 'stable' | 'canary' | 'beta' | 'dev',
        private readonly launchProfile: BrowserLaunchProfile | null = null
    ) {}

    async start(): Promise<void> {
        if (this.child) return;

        const args = [
            '-y',
            'chrome-devtools-mcp@latest',
            '--channel',
            this.channel,
            '--no-usage-statistics',
            '--no-performance-crux',
        ];

        if (this.launchProfile?.userDataDir) {
            args.push('--userDataDir', this.launchProfile.userDataDir);
        }
        if (this.launchProfile?.profileDirectory) {
            args.push('--chromeArg', `--profile-directory=${this.launchProfile.profileDirectory}`);
        }

        this.child = spawn('npx', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
            },
        });

        this.child.stdout.setEncoding('utf8');
        this.child.stderr.setEncoding('utf8');

        this.child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
        this.child.stderr.on('data', (chunk: string) => this.handleStderr(chunk));
        this.child.on('error', (error) => {
            this.rejectAll(`chrome-devtools-mcp process error: ${(error as Error).message}`);
        });
        this.child.on('exit', (code, signal) => {
            this.rejectAll(`chrome-devtools-mcp exited (code=${code ?? 'null'} signal=${signal ?? 'null'}). ${this.stderrSummary()}`);
            this.child = null;
        });

        const init = await this.call('initialize', {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
                name: 'tinyagi',
                version: '0.0.4',
            },
        }, 30000);

        if (!init || typeof init !== 'object') {
            throw new Error('chrome-devtools-mcp initialize returned an invalid payload.');
        }

        this.notify('notifications/initialized', {});
        await this.call('tools/list', {}, 30000);
    }

    async close(): Promise<void> {
        if (!this.child) return;
        const child = this.child;
        this.child = null;

        child.kill('SIGINT');
        await new Promise(resolve => setTimeout(resolve, 300));
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
        }
    }

    async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60000): Promise<any> {
        const result = await this.call('tools/call', { name, arguments: args }, timeoutMs);
        if (result && typeof result === 'object' && (result as any).isError) {
            const text = extractToolText(result);
            throw new Error(text || `MCP tool '${name}' failed.`);
        }
        return result;
    }

    private notify(method: string, params: Record<string, unknown>): void {
        this.send({
            jsonrpc: '2.0',
            method,
            params,
        });
    }

    private call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
        if (!this.child) {
            return Promise.reject(new Error('chrome-devtools-mcp process is not running.'));
        }

        const id = this.nextId;
        this.nextId += 1;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timed out waiting for MCP response (${method}). ${this.stderrSummary()}`));
            }, timeoutMs);

            this.pending.set(id, { method, resolve, reject, timer });
            this.send({
                jsonrpc: '2.0',
                id,
                method,
                params,
            });
        });
    }

    private send(message: JsonRpcMessage): void {
        if (!this.child) {
            throw new Error('chrome-devtools-mcp process is not running.');
        }
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    private handleStdout(chunk: string): void {
        this.buffer += chunk;

        while (true) {
            const nlIndex = this.buffer.indexOf('\n');
            if (nlIndex === -1) break;

            const line = this.buffer.slice(0, nlIndex).replace(/\r$/, '').trim();
            this.buffer = this.buffer.slice(nlIndex + 1);
            if (!line) continue;

            let message: JsonRpcMessage;
            try {
                message = JSON.parse(line) as JsonRpcMessage;
            } catch {
                continue;
            }

            if (typeof message.id === 'number' && this.pending.has(message.id)) {
                const pending = this.pending.get(message.id)!;
                this.pending.delete(message.id);
                clearTimeout(pending.timer);

                if (message.error) {
                    pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
                } else {
                    pending.resolve(message.result);
                }
            }
        }
    }

    private handleStderr(chunk: string): void {
        const lines = chunk
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);
        for (const line of lines) {
            this.stderrTail.push(line);
            if (this.stderrTail.length > 40) {
                this.stderrTail.shift();
            }
        }
    }

    private stderrSummary(): string {
        if (this.stderrTail.length === 0) return '';
        const tail = this.stderrTail.slice(-5).join(' | ');
        return `stderr tail: ${tail}`;
    }

    private rejectAll(reason: string): void {
        for (const [id, pending] of this.pending.entries()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
            this.pending.delete(id);
        }
    }
}

function buildSelectorActionFunction(
    selector: string,
    mode: 'click' | 'fill' | 'extract' | 'exists',
    value = ''
): string {
    const selectorLiteral = JSON.stringify(selector || '');
    const valueLiteral = JSON.stringify(value || '');

    const action = mode === 'click'
        ? `
            if (typeof el.click === 'function') {
                el.click();
            } else {
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }
            return { ok: true, url: location.href };
        `
        : mode === 'fill'
            ? `
                if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
                    el.focus();
                    el.value = String(value || '');
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return { ok: true, url: location.href };
                }
                if (el instanceof HTMLElement && el.isContentEditable) {
                    el.focus();
                    el.textContent = String(value || '');
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    return { ok: true, url: location.href };
                }
                return { ok: false, error: 'not_fillable' };
            `
            : mode === 'extract'
                ? `
                    return {
                        ok: true,
                        value: (el.textContent || '').trim(),
                        url: location.href,
                    };
                `
                : `
                    return { ok: true, url: location.href };
                `;

    return `() => {
        const selector = ${selectorLiteral};
        const value = ${valueLiteral};

        const byText = (needle) => {
            const text = String(needle || '').trim();
            if (!text) return null;
            const root = document.body || document.documentElement;
            if (!root) return null;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const node = walker.currentNode;
                const nodeValue = (node.nodeValue || '').trim();
                if (!nodeValue) continue;
                if (nodeValue.toLowerCase().includes(text.toLowerCase())) {
                    return node.parentElement;
                }
            }
            return null;
        };

        const resolveElement = () => {
            if (!selector) return null;

            if (selector.startsWith('text=')) {
                return byText(selector.slice(5));
            }

            if (selector.startsWith('xpath=')) {
                try {
                    const result = document.evaluate(
                        selector.slice(6),
                        document,
                        null,
                        XPathResult.FIRST_ORDERED_NODE_TYPE,
                        null,
                    );
                    const node = result.singleNodeValue;
                    return node instanceof Element ? node : null;
                } catch {
                    return null;
                }
            }

            const cssSelector = selector.startsWith('css=') ? selector.slice(4) : selector;
            try {
                const direct = document.querySelector(cssSelector);
                if (direct) return direct;
            } catch {
                // Ignore invalid selector syntax and try text fallback.
            }

            return byText(cssSelector);
        };

        const el = resolveElement();
        if (!el) {
            return { ok: false, error: 'not_found' };
        }

        if (el instanceof HTMLElement) {
            el.scrollIntoView({ block: 'center', inline: 'center' });
        }

        ${action}
    }`;
}

async function evaluateViaMcp(client: ChromeDevtoolsMcpClient, fn: string, timeoutMs = 45000): Promise<any> {
    const result = await client.callTool('evaluate_script', { function: fn }, timeoutMs);
    const text = extractToolText(result);
    return parseEvaluateResult(text);
}

async function captureMcpScreenshot(client: ChromeDevtoolsMcpClient, filePath: string): Promise<string> {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await client.callTool('take_screenshot', { fullPage: true, filePath }, 60000);
    return filePath;
}

async function readPageStateViaMcp(client: ChromeDevtoolsMcpClient): Promise<PageState> {
    try {
        const result = await evaluateViaMcp(client, `() => ({
            url: location.href || '',
            title: document.title || '',
            text: ((document.body && document.body.innerText) || '').slice(0, 25000),
        })`, 20000);

        const payload = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
        return {
            url: typeof payload.url === 'string' ? payload.url : '',
            title: typeof payload.title === 'string' ? payload.title : '',
            text: typeof payload.text === 'string' ? payload.text : '',
        };
    } catch {
        return {
            url: '',
            title: '',
            text: '',
        };
    }
}

async function runStepViaMcp(client: ChromeDevtoolsMcpClient, step: BrowserActionStep): Promise<{ value?: string }> {
    switch (step.type) {
        case 'navigate':
            if (!step.url) throw new Error('navigate step missing url');
            await client.callTool('navigate_page', {
                type: 'url',
                url: step.url,
                timeout: 30000,
            }, 90000);
            return {};

        case 'click': {
            if (!step.selector) throw new Error('click step missing selector');
            const result = await evaluateViaMcp(client, buildSelectorActionFunction(step.selector, 'click'));
            const payload = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
            if (!payload.ok) {
                throw new Error(`click step failed: ${String(payload.error || 'selector not found')}`);
            }
            return {};
        }

        case 'type':
        case 'fill': {
            if (!step.selector) throw new Error(`${step.type} step missing selector`);
            const result = await evaluateViaMcp(client, buildSelectorActionFunction(step.selector, 'fill', step.value || ''));
            const payload = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
            if (!payload.ok) {
                throw new Error(`${step.type} step failed: ${String(payload.error || 'selector not fillable')}`);
            }
            return {};
        }

        case 'wait_for': {
            if (!step.selector) throw new Error('wait_for step missing selector');

            if (step.selector.startsWith('text=')) {
                await client.callTool('wait_for', {
                    text: step.selector.slice(5),
                    timeout: 20000,
                }, 30000);
                return {};
            }

            const start = Date.now();
            while (Date.now() - start < 20000) {
                const result = await evaluateViaMcp(client, buildSelectorActionFunction(step.selector, 'exists'));
                const payload = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
                if (payload.ok === true) {
                    return {};
                }
                await sleep(400);
            }
            throw new Error(`wait_for selector timed out: ${step.selector}`);
        }

        case 'press':
            if (!step.value) throw new Error('press step missing key');
            await client.callTool('press_key', { key: step.value }, 20000);
            return {};

        case 'extract_text': {
            if (!step.selector) throw new Error('extract_text step missing selector');
            const result = await evaluateViaMcp(client, buildSelectorActionFunction(step.selector, 'extract'));
            const payload = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
            if (!payload.ok) {
                throw new Error(`extract_text step failed: ${String(payload.error || 'selector not found')}`);
            }
            const value = payload.value;
            return {
                value: typeof value === 'string' ? value : '',
            };
        }

        case 'screenshot':
            return {};

        default:
            throw new Error(`Unsupported browser step ${(step as BrowserActionStep).type}`);
    }
}

async function executeBrowserTaskViaCdp(
    input: BrowserExecutionInput,
    plan: BrowserPlan,
    settings: HarnessSettingsResolved,
    session: BrowserSessionResult,
): Promise<BrowserExecutionResult> {
    if (!session.ok || !session.sessionId || !session.debuggerUrl) {
        return {
            status: 'failed',
            message: `Browser session unavailable: ${session.message}`,
        };
    }

    const { chromium } = await import('playwright-core');
    const browser = await chromium.connectOverCDP(session.debuggerUrl);

    let tabId = `tab_${stripForId(input.runId)}_${crypto.randomUUID().slice(0, 8)}`;
    const selectorTrace: SelectorTraceEntry[] = [];
    const artifacts: string[] = [];
    const extracted: string[] = [];

    try {
        const context = browser.contexts()[0] || await browser.newContext();
        const page = await context.newPage();

        const runAuditDir = path.join(HARNESS_DIR, 'browser-audit', input.runId, tabId);
        fs.mkdirSync(runAuditDir, { recursive: true });

        upsertBrowserTab({
            tabId,
            sessionId: session.sessionId,
            runId: input.runId,
            owner: input.userId,
            status: 'active',
            url: page.url(),
            selectorTraceJson: JSON.stringify(selectorTrace),
        });

        for (let i = 0; i < plan.actions.length; i += 1) {
            const step = plan.actions[i];
            const actionId = `ba_${crypto.randomUUID()}`;
            const requiresApproval = settings.browser.hard_stop_payments && isPaymentStep(step);
            const stepLabel = `${i + 1}_${step.type}`;

            createBrowserActionRequest({
                actionId,
                runId: input.runId,
                sessionId: session.sessionId,
                url: step.url || page.url(),
                action: step.type,
                selector: step.selector,
                risk: requiresApproval ? 'critical' : input.risk,
                requiresApproval,
            });

            if (requiresApproval) {
                const requestId = `br_${crypto.randomUUID()}`;
                createBrowserApprovalRequest({
                    requestId,
                    actionId,
                    userId: input.userId,
                    reason: `Payment-related action '${step.type}' requires explicit approval.`,
                });
                appendBrowserAudit({
                    actionId,
                    runId: input.runId,
                    step: 'approval_required',
                    url: step.url || page.url(),
                    selectorTrace: JSON.stringify(selectorTrace),
                    details: { step, requestId },
                });
                upsertBrowserTab({
                    tabId,
                    sessionId: session.sessionId,
                    runId: input.runId,
                    owner: input.userId,
                    status: 'active',
                    url: page.url(),
                    selectorTraceJson: JSON.stringify(selectorTrace),
                });
                await page.close({ runBeforeUnload: false }).catch(() => {});
                await browser.close();
                return {
                    status: 'needs_approval',
                    requestId,
                    message: `Payment action blocked pending approval. Reply with /approve ${requestId} or /deny ${requestId}.`,
                };
            }

            let success = false;
            let lastError = '';
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
                const beforePath = path.join(runAuditDir, `${stepLabel}_attempt${attempt}_before.png`);
                const afterPath = path.join(runAuditDir, `${stepLabel}_attempt${attempt}_after.png`);
                try {
                    await captureScreenshot(page, beforePath);
                    artifacts.push(beforePath);

                    const result = await runStep(page, step);
                    if (result.value) {
                        extracted.push(`${step.selector || step.type}: ${result.value}`);
                    }

                    await captureScreenshot(page, afterPath);
                    artifacts.push(afterPath);

                    const checkpoint = await detectHumanCheckpoint(page);
                    const trace: SelectorTraceEntry = {
                        timestamp: Date.now(),
                        actionId,
                        stepType: step.type,
                        selector: step.selector,
                        value: step.value,
                        url: page.url(),
                        attempt,
                        outcome: checkpoint ? 'checkpoint' : 'success',
                        error: checkpoint?.details,
                    };
                    selectorTrace.push(trace);

                    appendBrowserAudit({
                        actionId,
                        runId: input.runId,
                        step: step.type,
                        url: page.url(),
                        screenshotBefore: beforePath,
                        screenshotAfter: afterPath,
                        selectorTrace: JSON.stringify(selectorTrace),
                        details: {
                            step,
                            attempt,
                            checkpoint,
                        },
                    });

                    upsertBrowserTab({
                        tabId,
                        sessionId: session.sessionId,
                        runId: input.runId,
                        owner: input.userId,
                        status: checkpoint ? 'error' : 'active',
                        url: page.url(),
                        selectorTraceJson: JSON.stringify(selectorTrace),
                    });

                    if (checkpoint) {
                        updateBrowserActionStatus(actionId, 'failed');
                        await page.close({ runBeforeUnload: false }).catch(() => {});
                        await browser.close();
                        return {
                            status: 'needs_input',
                            message: `${checkpoint.kind.toUpperCase()} checkpoint: ${checkpoint.details} Please continue manually then ask me to resume.`,
                            artifacts,
                        };
                    }

                    updateBrowserActionStatus(actionId, 'executed');
                    success = true;
                    break;
                } catch (error) {
                    lastError = (error as Error).message;
                    selectorTrace.push({
                        timestamp: Date.now(),
                        actionId,
                        stepType: step.type,
                        selector: step.selector,
                        value: step.value,
                        url: page.url(),
                        attempt,
                        outcome: 'failure',
                        error: lastError,
                    });

                    appendBrowserAudit({
                        actionId,
                        runId: input.runId,
                        step: `${step.type}_error`,
                        url: page.url(),
                        screenshotBefore: fs.existsSync(beforePath) ? beforePath : '',
                        selectorTrace: JSON.stringify(selectorTrace),
                        details: {
                            step,
                            attempt,
                            error: lastError,
                        },
                    });

                    if (attempt < MAX_RETRIES) {
                        await sleep(350 * Math.pow(2, attempt - 1));
                    }
                }
            }

            if (!success) {
                updateBrowserActionStatus(actionId, 'failed');
                upsertBrowserTab({
                    tabId,
                    sessionId: session.sessionId,
                    runId: input.runId,
                    owner: input.userId,
                    status: 'error',
                    url: page.url(),
                    selectorTraceJson: JSON.stringify(selectorTrace),
                });
                await page.close({ runBeforeUnload: false }).catch(() => {});
                await browser.close();
                return {
                    status: 'failed',
                    message: `Browser action failed after retries (${step.type}): ${lastError || 'unknown error'}`,
                    artifacts,
                };
            }
        }

        upsertBrowserTab({
            tabId,
            sessionId: session.sessionId,
            runId: input.runId,
            owner: input.userId,
            status: 'released',
            url: page.url(),
            selectorTraceJson: JSON.stringify(selectorTrace),
        });

        const title = await page.title().catch(() => '');
        await page.close({ runBeforeUnload: false }).catch(() => {});
        await browser.close();

        const extractedSummary = extracted.length > 0
            ? `\nExtracted:\n${extracted.slice(0, 5).map(v => `- ${v}`).join('\n')}`
            : '';

        return {
            status: 'completed',
            message: `Browser automation completed in tab ${tabId}.${title ? ` Page title: ${title}.` : ''}${extractedSummary}`,
            artifacts,
        };
    } catch (error) {
        upsertBrowserTab({
            tabId,
            sessionId: session.sessionId,
            runId: input.runId,
            owner: input.userId,
            status: 'error',
            url: '',
            selectorTraceJson: JSON.stringify(selectorTrace),
        });
        await browser.close().catch(() => {});
        return {
            status: 'failed',
            message: `Browser execution failed: ${(error as Error).message}`,
        };
    }
}

async function executeBrowserTaskViaMcp(
    input: BrowserExecutionInput,
    plan: BrowserPlan,
    settings: HarnessSettingsResolved,
): Promise<BrowserExecutionResult> {
    const launchProfile = resolveBrowserLaunchProfile(true);
    const launchProfilePath = path.join(launchProfile.userDataDir, launchProfile.profileDirectory);
    const sessionId = `session_mcp_${stripForId(input.runId)}_${crypto.randomUUID().slice(0, 6)}`;
    const sessionCreatedAt = Date.now();
    const tabId = `tab_${stripForId(input.runId)}_${crypto.randomUUID().slice(0, 8)}`;
    const runAuditDir = path.join(HARNESS_DIR, 'browser-audit', input.runId, tabId);
    const selectorTrace: SelectorTraceEntry[] = [];
    const artifacts: string[] = [];
    const extracted: string[] = [];

    const mcpClient = new ChromeDevtoolsMcpClient(settings.browser.mcp_channel, launchProfile);

    fs.mkdirSync(runAuditDir, { recursive: true });

    upsertBrowserSession({
        session_id: sessionId,
        profile_path: launchProfilePath,
        debugger_url: 'mcp://chrome-devtools',
        chrome_pid: 0,
        status: 'active',
        created_at: sessionCreatedAt,
        updated_at: Date.now(),
    });

    let lastKnownState: PageState = {
        url: 'about:blank',
        title: '',
        text: '',
    };

    try {
        await mcpClient.start();
        await mcpClient.callTool('new_page', {
            url: 'about:blank',
            timeout: 15000,
        }, 60000);

        lastKnownState = await readPageStateViaMcp(mcpClient);
        upsertBrowserTab({
            tabId,
            sessionId,
            runId: input.runId,
            owner: input.userId,
            status: 'active',
            url: lastKnownState.url || 'about:blank',
            selectorTraceJson: JSON.stringify(selectorTrace),
        });

        for (let i = 0; i < plan.actions.length; i += 1) {
            const step = plan.actions[i];
            const actionId = `ba_${crypto.randomUUID()}`;
            const requiresApproval = settings.browser.hard_stop_payments && isPaymentStep(step);
            const stepLabel = `${i + 1}_${step.type}`;

            createBrowserActionRequest({
                actionId,
                runId: input.runId,
                sessionId,
                url: step.url || lastKnownState.url || '',
                action: step.type,
                selector: step.selector,
                risk: requiresApproval ? 'critical' : input.risk,
                requiresApproval,
            });

            if (requiresApproval) {
                const requestId = `br_${crypto.randomUUID()}`;
                createBrowserApprovalRequest({
                    requestId,
                    actionId,
                    userId: input.userId,
                    reason: `Payment-related action '${step.type}' requires explicit approval.`,
                });
                appendBrowserAudit({
                    actionId,
                    runId: input.runId,
                    step: 'approval_required',
                    url: step.url || lastKnownState.url || '',
                    selectorTrace: JSON.stringify(selectorTrace),
                    details: { step, requestId },
                });
                upsertBrowserTab({
                    tabId,
                    sessionId,
                    runId: input.runId,
                    owner: input.userId,
                    status: 'active',
                    url: lastKnownState.url || '',
                    selectorTraceJson: JSON.stringify(selectorTrace),
                });
                return {
                    status: 'needs_approval',
                    requestId,
                    message: `Payment action blocked pending approval. Reply with /approve ${requestId} or /deny ${requestId}.`,
                };
            }

            let success = false;
            let lastError = '';

            for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
                const beforePath = path.join(runAuditDir, `${stepLabel}_attempt${attempt}_before.png`);
                const afterPath = path.join(runAuditDir, `${stepLabel}_attempt${attempt}_after.png`);

                try {
                    await captureMcpScreenshot(mcpClient, beforePath);
                    artifacts.push(beforePath);

                    const result = await runStepViaMcp(mcpClient, step);
                    if (result.value) {
                        extracted.push(`${step.selector || step.type}: ${result.value}`);
                    }

                    await captureMcpScreenshot(mcpClient, afterPath);
                    artifacts.push(afterPath);

                    lastKnownState = await readPageStateViaMcp(mcpClient);
                    const checkpoint = detectHumanCheckpointFromBlob(`${lastKnownState.url}\n${lastKnownState.text}`);

                    selectorTrace.push({
                        timestamp: Date.now(),
                        actionId,
                        stepType: step.type,
                        selector: step.selector,
                        value: step.value,
                        url: lastKnownState.url || step.url || '',
                        attempt,
                        outcome: checkpoint ? 'checkpoint' : 'success',
                        error: checkpoint?.details,
                    });

                    appendBrowserAudit({
                        actionId,
                        runId: input.runId,
                        step: step.type,
                        url: lastKnownState.url || step.url || '',
                        screenshotBefore: beforePath,
                        screenshotAfter: afterPath,
                        selectorTrace: JSON.stringify(selectorTrace),
                        details: {
                            step,
                            attempt,
                            checkpoint,
                        },
                    });

                    upsertBrowserTab({
                        tabId,
                        sessionId,
                        runId: input.runId,
                        owner: input.userId,
                        status: checkpoint ? 'error' : 'active',
                        url: lastKnownState.url || '',
                        selectorTraceJson: JSON.stringify(selectorTrace),
                    });

                    if (checkpoint) {
                        updateBrowserActionStatus(actionId, 'failed');
                        return {
                            status: 'needs_input',
                            message: `${checkpoint.kind.toUpperCase()} checkpoint: ${checkpoint.details} Please continue manually then ask me to resume.`,
                            artifacts,
                        };
                    }

                    updateBrowserActionStatus(actionId, 'executed');
                    success = true;
                    break;
                } catch (error) {
                    lastError = (error as Error).message;
                    lastKnownState = await readPageStateViaMcp(mcpClient);

                    selectorTrace.push({
                        timestamp: Date.now(),
                        actionId,
                        stepType: step.type,
                        selector: step.selector,
                        value: step.value,
                        url: lastKnownState.url || step.url || '',
                        attempt,
                        outcome: 'failure',
                        error: lastError,
                    });

                    appendBrowserAudit({
                        actionId,
                        runId: input.runId,
                        step: `${step.type}_error`,
                        url: lastKnownState.url || step.url || '',
                        screenshotBefore: fs.existsSync(beforePath) ? beforePath : '',
                        selectorTrace: JSON.stringify(selectorTrace),
                        details: {
                            step,
                            attempt,
                            error: lastError,
                        },
                    });

                    if (attempt < MAX_RETRIES) {
                        await sleep(350 * Math.pow(2, attempt - 1));
                    }
                }
            }

            if (!success) {
                updateBrowserActionStatus(actionId, 'failed');
                upsertBrowserTab({
                    tabId,
                    sessionId,
                    runId: input.runId,
                    owner: input.userId,
                    status: 'error',
                    url: lastKnownState.url || '',
                    selectorTraceJson: JSON.stringify(selectorTrace),
                });
                return {
                    status: 'failed',
                    message: `Browser action failed after retries (${step.type}): ${lastError || 'unknown error'}`,
                    artifacts,
                };
            }
        }

        upsertBrowserTab({
            tabId,
            sessionId,
            runId: input.runId,
            owner: input.userId,
            status: 'released',
            url: lastKnownState.url || '',
            selectorTraceJson: JSON.stringify(selectorTrace),
        });

        const extractedSummary = extracted.length > 0
            ? `\nExtracted:\n${extracted.slice(0, 5).map(v => `- ${v}`).join('\n')}`
            : '';

        return {
            status: 'completed',
            message: `Browser automation completed in tab ${tabId}.${lastKnownState.title ? ` Page title: ${lastKnownState.title}.` : ''}${extractedSummary}`,
            artifacts,
        };
    } catch (error) {
        upsertBrowserTab({
            tabId,
            sessionId,
            runId: input.runId,
            owner: input.userId,
            status: 'error',
            url: lastKnownState.url || '',
            selectorTraceJson: JSON.stringify(selectorTrace),
        });
        return {
            status: 'failed',
            message: `MCP browser execution failed: ${(error as Error).message}`,
            artifacts,
        };
    } finally {
        await mcpClient.close().catch(() => {});
        upsertBrowserSession({
            session_id: sessionId,
            profile_path: launchProfilePath,
            debugger_url: 'mcp://chrome-devtools',
            chrome_pid: 0,
            status: 'stopped',
            created_at: sessionCreatedAt,
            updated_at: Date.now(),
        });
    }
}

function shouldUseMcpFallback(sessionMessage: string): boolean {
    return /(no reachable debugger endpoint|will not relaunch chrome|profile lock|debugger did not become ready)/i.test(sessionMessage);
}

async function executeBrowserTaskWithPlan(
    input: BrowserExecutionInput,
    plan: BrowserPlan,
    settings: HarnessSettingsResolved,
): Promise<BrowserExecutionResult> {
    if (settings.browser.provider === 'chrome-devtools-mcp') {
        return executeBrowserTaskViaMcp(input, plan, settings);
    }

    if (settings.browser.provider === 'cdp') {
        const session = await ensureBrowserSession();
        if (!session.ok || !session.sessionId || !session.debuggerUrl) {
            return {
                status: 'failed',
                message: `Browser session unavailable: ${session.message}`,
            };
        }
        return executeBrowserTaskViaCdp(input, plan, settings, session);
    }

    const cdpSession = await ensureBrowserSession();
    if (cdpSession.ok && cdpSession.sessionId && cdpSession.debuggerUrl) {
        return executeBrowserTaskViaCdp(input, plan, settings, cdpSession);
    }

    if (shouldUseMcpFallback(cdpSession.message)) {
        const mcpResult = await executeBrowserTaskViaMcp(input, plan, settings);
        if (mcpResult.status !== 'failed') {
            return mcpResult;
        }
        return {
            status: 'failed',
            message: `Browser session unavailable: ${cdpSession.message} MCP fallback failed: ${mcpResult.message}`,
            artifacts: mcpResult.artifacts,
        };
    }

    return {
        status: 'failed',
        message: `Browser session unavailable: ${cdpSession.message}`,
    };
}

function parseSelectorTrace(raw: string): SelectorTraceEntry[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const allowedStepTypes: BrowserActionStep['type'][] = ['navigate', 'click', 'type', 'fill', 'wait_for', 'press', 'screenshot', 'extract_text'];
        return parsed
            .filter((entry): entry is SelectorTraceEntry => {
                if (!entry || typeof entry !== 'object') return false;
                const stepType = String((entry as any).stepType || '');
                return (allowedStepTypes as string[]).includes(stepType);
            })
            .map((entry) => ({
                timestamp: Number(entry.timestamp) || 0,
                actionId: String(entry.actionId || ''),
                stepType: entry.stepType as BrowserActionStep['type'],
                selector: entry.selector ? String(entry.selector) : undefined,
                value: entry.value ? String(entry.value) : undefined,
                url: String(entry.url || ''),
                attempt: Number(entry.attempt) || 1,
                outcome: entry.outcome === 'checkpoint' ? 'checkpoint' : entry.outcome === 'failure' ? 'failure' : 'success',
                error: entry.error ? String(entry.error) : undefined,
            }));
    } catch {
        return [];
    }
}

function buildReplayPlan(runId: string): BrowserPlan | null {
    const tabs = listBrowserTabs(runId)
        .sort((a, b) => b.updated_at - a.updated_at);
    if (tabs.length === 0) return null;

    const tab = tabs.find(row => !!row.selector_trace_json && row.selector_trace_json !== '[]') || tabs[0];
    const trace = parseSelectorTrace(tab.selector_trace_json || '');
    if (trace.length === 0) return null;

    const actions: BrowserActionStep[] = [];
    const seenActions = new Set<string>();
    const baseUrl = tab.url || trace[0]?.url || '';
    if (baseUrl) {
        actions.push({ type: 'navigate', url: baseUrl });
    }

    for (const entry of trace) {
        if (!entry.actionId || seenActions.has(entry.actionId)) continue;
        if (entry.outcome !== 'success' && entry.outcome !== 'checkpoint') continue;
        seenActions.add(entry.actionId);

        const stepType = entry.stepType;
        const step: BrowserActionStep = {
            type: stepType,
            selector: entry.selector,
            value: entry.value,
            url: entry.url,
        };

        if (step.type === 'navigate' && !step.url) continue;
        if ((step.type === 'click' || step.type === 'type' || step.type === 'fill' || step.type === 'wait_for' || step.type === 'extract_text') && !step.selector) {
            continue;
        }
        if (step.type === 'press' && !step.value) continue;

        actions.push(step);
    }

    if (actions.length === 0) return null;
    return {
        url: baseUrl || undefined,
        actions,
    };
}

export async function replayBrowserRun(input: {
    runId: string;
    userId: string;
    risk?: RiskLevel;
}): Promise<BrowserExecutionResult> {
    const plan = buildReplayPlan(input.runId);
    if (!plan) {
        return {
            status: 'needs_input',
            message: `No replayable browser trace found for run ${input.runId}.`,
        };
    }

    const replayRunId = `replay_${stripForId(input.runId)}_${Date.now()}`;
    const settings = getHarnessSettings();
    return executeBrowserTaskWithPlan({
        runId: replayRunId,
        userId: input.userId,
        objective: `Replay browser run ${input.runId}`,
        candidateOutput: '',
        risk: input.risk || 'medium',
    }, plan, settings);
}

export async function executeBrowserTask(input: BrowserExecutionInput): Promise<BrowserExecutionResult> {
    const settings = getHarnessSettings();

    const plan = parseBrowserPlan(input.objective, input.candidateOutput || '');
    if (plan.actions.length === 0) {
        return {
            status: 'needs_input',
            message: 'No executable browser actions found. Please include a URL and explicit actions (click/type/wait/extract).',
        };
    }

    return executeBrowserTaskWithPlan(input, plan, settings);
}
