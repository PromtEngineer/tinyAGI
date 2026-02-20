import crypto from 'crypto';
import { spawn } from 'child_process';
import {
    appendToolEvent,
    getToolByName,
    hasActivePermission,
    incrementMetric,
    upsertPermission,
    upsertTool,
} from '../repository';

export interface ToolExecutionInput {
    runId: string;
    userId: string;
    objective: string;
    candidateOutput?: string;
    workspacePath: string;
}

export interface ToolExecutionResult {
    status: 'completed' | 'needs_approval' | 'needs_input' | 'failed';
    message: string;
    requestId?: string;
    toolName?: string;
    command?: string;
    outputSnippet?: string;
}

const ALLOWED_TOOLS = ['npm', 'npx', 'pip', 'pip3', 'brew', 'git', 'docker', 'pnpm', 'yarn'];
const MAX_OUTPUT_BYTES = 24 * 1024;
const DEFAULT_TIMEOUT_MS = 120000;

function toolIdFromName(name: string): string {
    return `tool_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
}

function classifyTrust(source: string): 'curated' | 'mainstream' | 'unknown' {
    const normalized = source.toLowerCase();
    if (/(github|npm|pypi|homebrew|docker|git)/.test(normalized)) {
        return 'mainstream';
    }
    if (/(internal|local|curated)/.test(normalized)) {
        return 'curated';
    }
    return 'unknown';
}

function stripLinePrefix(line: string): string {
    return line
        .replace(/^[-*]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .trim();
}

function extractCommandCandidate(blob: string): string {
    const lines = blob
        .split('\n')
        .map(stripLinePrefix)
        .filter(Boolean);

    for (const line of lines) {
        for (const tool of ALLOWED_TOOLS) {
            if (line.toLowerCase().startsWith(`${tool} `) || line.toLowerCase() === tool) {
                return line;
            }
        }
    }

    for (const tool of ALLOWED_TOOLS) {
        const match = blob.match(new RegExp(`\\b(${tool})\\s+[^\\n]+`, 'i'));
        if (match) return match[0].trim();
    }

    return '';
}

function tokenizeCommand(command: string): string[] {
    const tokens: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(command)) !== null) {
        tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
    }
    return tokens.filter(Boolean);
}

function sanitizeCommand(command: string): { ok: boolean; reason?: string } {
    if (!command.trim()) {
        return { ok: false, reason: 'No executable tool command found.' };
    }

    if (/[;&|`]/.test(command)) {
        return { ok: false, reason: 'Command chaining/pipes are blocked in harness tooling mode.' };
    }

    if (/\bsudo\b/i.test(command)) {
        return { ok: false, reason: 'sudo is blocked in harness tooling mode.' };
    }

    if (/\brm\s+-rf\b/i.test(command)) {
        return { ok: false, reason: 'Destructive rm -rf command blocked.' };
    }

    const tokens = tokenizeCommand(command);
    if (tokens.length === 0) {
        return { ok: false, reason: 'Command parser could not extract executable tokens.' };
    }

    const tool = tokens[0]!.toLowerCase();
    if (!ALLOWED_TOOLS.includes(tool)) {
        return { ok: false, reason: `Tool '${tool}' is not in allowed harness tool list.` };
    }

    return { ok: true };
}

function executeCommand(command: string, cwd: string): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
        const tokens = tokenizeCommand(command);
        const [bin, ...args] = tokens;
        if (!bin) {
            resolve({ code: 1, output: 'Command parse failed.' });
            return;
        }

        const child = spawn(bin, args, {
            cwd,
            env: process.env,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        const startedAt = Date.now();

        const appendBounded = (prev: string, nextChunk: string): string => {
            const merged = prev + nextChunk;
            if (merged.length <= MAX_OUTPUT_BYTES) return merged;
            return merged.slice(merged.length - MAX_OUTPUT_BYTES);
        };

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', (chunk: string) => {
            stdout = appendBounded(stdout, chunk);
        });

        child.stderr.on('data', (chunk: string) => {
            stderr = appendBounded(stderr, chunk);
        });

        const timer = setTimeout(() => {
            child.kill('SIGTERM');
        }, DEFAULT_TIMEOUT_MS);

        child.on('error', (error) => {
            clearTimeout(timer);
            resolve({ code: 1, output: `Failed to run command: ${(error as Error).message}` });
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            const elapsedMs = Date.now() - startedAt;
            const output = [
                `Exit code: ${code ?? 1}`,
                `Duration: ${elapsedMs}ms`,
                stdout.trim() ? `stdout:\n${stdout.trim()}` : '',
                stderr.trim() ? `stderr:\n${stderr.trim()}` : '',
            ].filter(Boolean).join('\n\n');
            resolve({ code: typeof code === 'number' ? code : 1, output });
        });
    });
}

export async function executeToolingTask(input: ToolExecutionInput): Promise<ToolExecutionResult> {
    const sourceText = [input.objective, input.candidateOutput || ''].filter(Boolean).join('\n');
    const command = extractCommandCandidate(sourceText);

    const validated = sanitizeCommand(command);
    if (!validated.ok) {
        incrementMetric('tooling_needs_input_count', 1, { runId: input.runId });
        return {
            status: 'needs_input',
            message: validated.reason || 'Could not build an executable tool command.',
        };
    }

    const tokens = tokenizeCommand(command);
    const toolName = (tokens[0] || '').toLowerCase();
    const toolId = toolIdFromName(toolName);

    if (!getToolByName(toolName)) {
        upsertTool(toolId, toolName, 'runtime', classifyTrust(toolName), 'pending', {
            discoveredBy: 'harness_runtime',
            runId: input.runId,
        });
    }

    if (!hasActivePermission(input.userId, toolName, 'execute')) {
        const requestId = `perm_${crypto.randomUUID()}`;
        upsertPermission(requestId, input.userId, toolName, 'execute', 'tool', 'pending');
        appendToolEvent(toolId, 'approval_required', {
            runId: input.runId,
            userId: input.userId,
            command,
            requestId,
        });
        incrementMetric('tooling_approval_required_count', 1, { toolName, runId: input.runId });
        return {
            status: 'needs_approval',
            requestId,
            toolName,
            command,
            message: `Tool execution requires approval for '${toolName}'. Reply with /approve ${requestId} or /deny ${requestId}.`,
        };
    }

    upsertTool(toolId, toolName, 'runtime', classifyTrust(toolName), 'approved', {
        executedBy: input.userId,
        lastRunId: input.runId,
    });
    appendToolEvent(toolId, 'execute_start', {
        runId: input.runId,
        userId: input.userId,
        command,
    });

    const result = await executeCommand(command, input.workspacePath);
    if (result.code !== 0) {
        appendToolEvent(toolId, 'execute_failed', {
            runId: input.runId,
            command,
            output: result.output,
        });
        incrementMetric('tooling_failed_count', 1, { toolName, runId: input.runId });
        return {
            status: 'failed',
            toolName,
            command,
            outputSnippet: result.output.slice(0, 8000),
            message: `Tool command failed for '${toolName}'.`,
        };
    }

    appendToolEvent(toolId, 'execute_success', {
        runId: input.runId,
        command,
        output: result.output,
    });
    incrementMetric('tooling_success_count', 1, { toolName, runId: input.runId });

    return {
        status: 'completed',
        toolName,
        command,
        outputSnippet: result.output.slice(0, 8000),
        message: `Tool command completed: ${command}`,
    };
}
