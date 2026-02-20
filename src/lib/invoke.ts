import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AgentConfig, TeamConfig } from './types';
import { SCRIPT_DIR, resolveClaudeModel, resolveCodexModel } from './config';
import { log } from './logging';
import { ensureAgentDirectory, updateAgentTeammates } from './agent-setup';

export interface InvokeAgentOptions {
    enableChrome?: boolean;
}

export async function runCommand(command: string, args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: cwd || SCRIPT_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });

        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });

        child.on('error', (error) => {
            reject(error);
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
                return;
            }

            const errorMessage = stderr.trim() || `Command exited with code ${code}`;
            reject(new Error(errorMessage));
        });
    });
}

export function resolveClaudeCommand(): string {
    const configured = process.env.CLAUDE_BIN?.trim();
    if (configured && fs.existsSync(configured)) {
        return configured;
    }

    const localClaude = path.join(os.homedir(), '.claude', 'local', 'claude');
    if (fs.existsSync(localClaude)) {
        return localClaude;
    }

    return 'claude';
}

function parseCodexResponse(codexOutput: string): string {
    let response = '';
    const errors: string[] = [];
    const lines = codexOutput.trim().split('\n');
    for (const line of lines) {
        try {
            const json = JSON.parse(line);

            // Current Codex CLI JSON shape.
            if (json.msg?.type === 'agent_message') {
                const text = typeof json.msg.message === 'string'
                    ? json.msg.message
                    : (typeof json.msg.text === 'string' ? json.msg.text : '');
                if (text.trim()) {
                    response = text.trim();
                }
                continue;
            }
            if (json.msg?.type === 'error') {
                const text = typeof json.msg.message === 'string' ? json.msg.message.trim() : '';
                if (text) {
                    errors.push(text);
                }
                continue;
            }

            // Legacy JSON shape.
            if (json.type === 'item.completed' && json.item?.type === 'agent_message') {
                const text = typeof json.item.text === 'string'
                    ? json.item.text
                    : (typeof json.item.message === 'string' ? json.item.message : '');
                if (text.trim()) {
                    response = text.trim();
                }
                continue;
            }
            if (json.type === 'error') {
                const text = typeof json.message === 'string' ? json.message.trim() : '';
                if (text) {
                    errors.push(text);
                }
            }
        } catch {
            // Ignore lines that aren't valid JSON.
        }
    }

    if (response) {
        return response;
    }
    if (errors.length > 0) {
        throw new Error(errors[errors.length - 1]);
    }
    throw new Error('Codex returned no agent response.');
}

function codexResumeMissingSessionError(message: string): boolean {
    return /(resume|--last)/i.test(message)
        && /(no previous|no prior|not found|could not find|session)/i.test(message);
}

function codexModelUnavailableError(message: string): boolean {
    return /(model|access)/i.test(message)
        && /(does not exist|do not have access|invalid model)/i.test(message);
}

function buildCodexArgs(message: string, modelId: string, resume: boolean): string[] {
    const args = ['exec'];
    if (resume) {
        args.push('resume', '--last');
    }
    // Guard against incompatible local ~/.codex/config.toml values.
    args.push('-c', 'model_reasoning_effort="high"');
    if (modelId) {
        args.push('--model', modelId);
    }
    args.push('--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', message);
    return args;
}

/**
 * Run a stateless one-shot prompt via Claude CLI. Used for verification and other
 * lightweight LLM calls that don't need agent workspace or conversation state.
 */
export async function runOneShotPrompt(prompt: string, model?: string): Promise<string> {
    const claudeArgs = ['--dangerously-skip-permissions'];
    if (model) {
        claudeArgs.push('--model', model);
    }
    claudeArgs.push('-p', prompt);
    return await runCommand(resolveClaudeCommand(), claudeArgs);
}

/**
 * Invoke a single agent with a message. Contains all Claude/Codex invocation logic.
 * Returns the raw response text.
 */
export async function invokeAgent(
    agent: AgentConfig,
    agentId: string,
    message: string,
    workspacePath: string,
    shouldReset: boolean,
    agents: Record<string, AgentConfig> = {},
    teams: Record<string, TeamConfig> = {},
    options: InvokeAgentOptions = {}
): Promise<string> {
    // Ensure agent directory exists with config files
    const agentDir = path.join(workspacePath, agentId);
    const isNewAgent = !fs.existsSync(agentDir);
    ensureAgentDirectory(agentDir);
    if (isNewAgent) {
        log('INFO', `Initialized agent directory with config files: ${agentDir}`);
    }

    // Update AGENTS.md with current teammate info
    updateAgentTeammates(agentDir, agentId, agents, teams);

    // Resolve working directory
    const workingDir = agent.working_directory
        ? (path.isAbsolute(agent.working_directory)
            ? agent.working_directory
            : path.join(workspacePath, agent.working_directory))
        : agentDir;

    const provider = agent.provider || 'anthropic';

    if (provider === 'openai') {
        log('INFO', `Using Codex CLI (agent: ${agentId})`);

        const shouldResume = !shouldReset;

        if (shouldReset) {
            log('INFO', `🔄 Resetting Codex conversation for agent: ${agentId}`);
        }

        const primaryModelId = resolveCodexModel(agent.model);
        const fallbackModelId = primaryModelId === 'gpt-5.3-codex' ? 'gpt-5-codex' : '';

        const executeCodex = async (modelId: string): Promise<string> => {
            let codexOutput = '';

            if (shouldResume) {
                try {
                    codexOutput = await runCommand('codex', buildCodexArgs(message, modelId, true), workingDir);
                } catch (error) {
                    const err = (error as Error).message || '';
                    if (!codexResumeMissingSessionError(err)) {
                        throw error;
                    }
                    log('WARN', `Codex resume unavailable for agent ${agentId}; falling back to fresh session.`);
                    codexOutput = await runCommand('codex', buildCodexArgs(message, modelId, false), workingDir);
                }
            } else {
                codexOutput = await runCommand('codex', buildCodexArgs(message, modelId, false), workingDir);
            }

            return parseCodexResponse(codexOutput);
        };

        try {
            return await executeCodex(primaryModelId);
        } catch (error) {
            const err = (error as Error).message || '';
            if (!fallbackModelId || !codexModelUnavailableError(err)) {
                throw error;
            }

            log('WARN', `Codex model ${primaryModelId} unavailable for agent ${agentId}; retrying with ${fallbackModelId}.`);
            return executeCodex(fallbackModelId);
        }
    } else {
        // Default to Claude (Anthropic)
        log('INFO', `Using Claude provider (agent: ${agentId})`);

        const continueConversation = !shouldReset;

        if (shouldReset) {
            log('INFO', `🔄 Resetting conversation for agent: ${agentId}`);
        }

        const modelId = resolveClaudeModel(agent.model);
        const claudeArgs = ['--dangerously-skip-permissions'];
        if (options.enableChrome) {
            claudeArgs.push('--chrome');
        }
        if (modelId) {
            claudeArgs.push('--model', modelId);
        }
        if (continueConversation) {
            claudeArgs.push('-c');
        }
        claudeArgs.push('-p', message);

        return await runCommand(resolveClaudeCommand(), claudeArgs, workingDir);
    }
}
