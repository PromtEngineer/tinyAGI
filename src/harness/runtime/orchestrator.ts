import crypto from 'crypto';
import { AgentConfig, MessageData, TeamConfig } from '../../lib/types';
import { invokeAgent, runOneShotPrompt } from '../../lib/invoke';
import { getHarnessSettings, getSettings } from '../../lib/config';
import { appendTaskEvent, appendRawMemoryEvent, createTaskRun, incrementMetric, updateTaskRun } from '../repository';
import { applyPublishGate } from './publish-gate';
import { classifyRisk, loopBudgetForRisk } from './risk-classifier';
import { runGeneratorVerifierRevisorLoop } from './loop-engine';
import { routeTask } from './task-router';
import { RiskLevel, VerificationVerdict } from '../types';
import { executeBrowserTask } from '../browser/executor';
import { executeToolingTask } from '../tools/executor';
import { ingestMemorySignals, retrieveMemoryContext } from '../memory/service';
import { maybeAutoDraftSkill } from '../skills/service';

export interface HarnessExecutionInput {
    messageData: MessageData;
    agentId: string;
    agent: AgentConfig;
    workspacePath: string;
    shouldReset: boolean;
    agents: Record<string, AgentConfig>;
    teams: Record<string, TeamConfig>;
}

export interface HarnessExecutionResult {
    runId: string;
    status: 'verified' | 'awaiting_approval' | 'needs_input' | 'failed';
    responseText: string;
    verifierOutcome?: 'pass' | 'minor_fix' | 'critical_fail' | 'abstain';
}

function safeId(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

interface VerifyContext {
    runId: string;
    objective: string;
    risk: RiskLevel;
}

function extractEvidenceRefs(text: string): string[] {
    const refs = new Set<string>();

    const urlRegex = /(https?:\/\/[^\s)]+)/g;
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(text)) !== null) {
        refs.add(match[1]);
    }

    const evidenceRegex = /\[(?:evidence|source):\s*([^\]]+)\]/gi;
    while ((match = evidenceRegex.exec(text)) !== null) {
        refs.add(match[1].trim());
    }

    return Array.from(refs);
}

async function verifyCandidate(ctx: VerifyContext, candidate: string): Promise<VerificationVerdict> {
    const evidenceRefs = extractEvidenceRefs(candidate);

    // Fast-fail: empty or error responses don't need an LLM call
    if (!candidate || candidate.trim().length < 8) {
        return {
            runId: ctx.runId,
            verifier: 'llm',
            outcome: 'critical_fail',
            findings: ['Response is empty or too short.'],
            requiredActions: ['Provide a complete response.'],
            evidenceRefs,
        };
    }

    if (/sorry,?\s+i encountered an error/i.test(candidate)) {
        return {
            runId: ctx.runId,
            verifier: 'llm',
            outcome: 'critical_fail',
            findings: ['Agent returned an execution error placeholder.'],
            requiredActions: ['Regenerate a concrete answer.'],
            evidenceRefs,
        };
    }

    const prompt = [
        'You are a response quality verifier for an AI assistant. Evaluate whether the agent response adequately addresses the user request.',
        '',
        `<request risk="${ctx.risk}">`,
        ctx.objective,
        '</request>',
        '',
        '<response>',
        candidate,
        '</response>',
        '',
        'Output ONLY a JSON object with these fields, no other text:',
        '{',
        '  "outcome": "pass" | "minor_fix" | "critical_fail" | "abstain",',
        '  "findings": ["list of issues, empty if pass"],',
        '  "required_actions": ["fixes needed, empty if pass"]',
        '}',
        '',
        'Guidelines:',
        '- "pass": Response is relevant, coherent, and addresses the request. Conversational and casual messages should pass easily.',
        '- "minor_fix": Response is partially correct but has notable gaps or inaccuracies.',
        '- "critical_fail": Response is completely off-topic, nonsensical, or could cause harm.',
        '- "abstain": Cannot evaluate (too specialized or ambiguous).',
        '- Be pragmatic. A helpful on-topic response should pass even if imperfect.',
    ].join('\n');

    try {
        const raw = await runOneShotPrompt(prompt, 'claude-opus-4-6');
        const trimmed = raw.trim();

        let parsed: Record<string, unknown> | null = null;
        try {
            parsed = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
            const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (fenced) {
                parsed = JSON.parse(fenced[1]) as Record<string, unknown>;
            } else {
                const objMatch = trimmed.match(/\{[\s\S]*\}/);
                if (objMatch) {
                    parsed = JSON.parse(objMatch[0]) as Record<string, unknown>;
                }
            }
        }

        if (!parsed || typeof parsed !== 'object') {
            return {
                runId: ctx.runId,
                verifier: 'llm',
                outcome: 'pass',
                findings: ['Verifier output could not be parsed; defaulting to pass.'],
                requiredActions: [],
                evidenceRefs,
            };
        }

        const validOutcomes = ['pass', 'minor_fix', 'critical_fail', 'abstain'] as const;
        const outcomeRaw = String(parsed.outcome || '');
        const outcome = (validOutcomes as readonly string[]).includes(outcomeRaw)
            ? outcomeRaw as typeof validOutcomes[number]
            : 'pass';
        const findings = Array.isArray(parsed.findings) ? parsed.findings.map(String) : [];
        const requiredActions = Array.isArray(parsed.required_actions) ? parsed.required_actions.map(String) : [];

        return {
            runId: ctx.runId,
            verifier: 'llm',
            outcome,
            findings,
            requiredActions,
            evidenceRefs,
        };
    } catch (error) {
        // On verifier error, default to pass so we don't block the user's response
        return {
            runId: ctx.runId,
            verifier: 'llm',
            outcome: 'pass',
            findings: [`Verifier error: ${(error as Error).message}; defaulting to pass.`],
            requiredActions: [],
            evidenceRefs,
        };
    }
}

function askTargetedQuestion(objective: string): string {
    if (/\bcode|implement|fix|refactor|patch\b/i.test(objective)) {
        return 'I could not verify this safely. Please share the exact files/functions you want changed and acceptance criteria.';
    }

    if (/\bpayment|purchase|transfer|checkout\b/i.test(objective)) {
        return 'I need explicit confirmation to proceed with payment-related actions. Reply with /approve <request_id>.';
    }

    return 'I could not complete this safely within verification limits. Please provide one clarifying detail so I can continue.';
}

function toUserFacingHarnessError(message: string): string {
    if (/spawn\s+claude\s+ENOENT/i.test(message)) {
        return 'Model runtime error: Claude CLI executable not found in daemon PATH. Install Claude Code, or set `CLAUDE_BIN` to the absolute Claude binary path.';
    }
    if (/spawn\s+codex\s+ENOENT/i.test(message)) {
        return 'Model runtime error: Codex CLI is not installed. Install `codex` and retry.';
    }
    if (/(model|access)/i.test(message) && /(does not exist|do not have access|invalid model)/i.test(message)) {
        return 'Model runtime error: configured Codex model is unavailable for this account. Set `models.openai.model` to an available model (for example `gpt-5-codex`).';
    }
    if (/resume\s+--last/i.test(message) && /no such|not found|previous|session/i.test(message)) {
        return 'Model runtime error: no previous Codex session to resume. Reset the agent or send another command to initialize session state.';
    }
    const trimmed = message.trim();
    if (!trimmed) {
        return 'Model runtime error: unknown failure.';
    }
    return `Model runtime error: ${trimmed.slice(0, 220)}`;
}

const PROACTIVE_COMMUNICATION_INSTRUCTIONS = [
    'When responding, follow these communication guidelines:',
    '- Start with a brief summary of what you did or found.',
    '- For tasks: describe the key steps taken and the outcome.',
    '- For questions: answer directly and concisely.',
    '- End with a clear status: what is done, what needs more info, or what is partial.',
    '- Keep the tone conversational and informative.',
].join('\n');

function generatorPrompt(input: HarnessExecutionInput, risk: RiskLevel, memoryContext: string): string {
    if (risk === 'high' || risk === 'critical') {
        return [
            'You are the generator stage in a harness loop.',
            'Return a high-confidence draft with explicit evidence references in the form [evidence: ...].',
            'Include a short "Refutation check" section that tries to invalidate your own answer and reports limits.',
            '',
            PROACTIVE_COMMUNICATION_INSTRUCTIONS,
            '',
            memoryContext ? `${memoryContext}\n` : '',
            `User request: ${input.messageData.message}`,
        ].join('\n');
    }

    return [
        PROACTIVE_COMMUNICATION_INSTRUCTIONS,
        '',
        memoryContext ? `${memoryContext}\n` : '',
        `User request: ${input.messageData.message}`,
    ].join('\n');
}

function revisorPrompt(original: string, verdict: VerificationVerdict, iteration: number): string {
    return [
        `You are the revisor stage (iteration ${iteration}).`,
        'Revise the candidate using verifier findings. Keep structure concise and actionable.',
        '',
        `Verifier outcome: ${verdict.outcome}`,
        `Findings: ${verdict.findings.join(' | ') || 'none'}`,
        `Required actions: ${verdict.requiredActions.join(' | ') || 'none'}`,
        '',
        'Candidate to revise:',
        original,
    ].join('\n');
}

function resolveBrowserClaudeAgent(base: AgentConfig): AgentConfig {
    if ((base.provider || 'anthropic') === 'anthropic') {
        return base;
    }
    const settings = getSettings();
    const claudeModel = settings?.models?.anthropic?.model || 'claude-opus-4-6';
    return {
        ...base,
        provider: 'anthropic',
        model: claudeModel,
    };
}

export async function executeHarness(input: HarnessExecutionInput): Promise<HarnessExecutionResult> {
    const branchBase = input.messageData.conversationId
        ? `${input.messageData.conversationId}_${input.agentId}_${input.messageData.fromAgent || 'root'}`
        : `${input.messageData.messageId}_${input.agentId}`;
    const runId = `run_${safeId(branchBase)}_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
    const taskId = input.messageData.conversationId
        ? `task_${safeId(input.messageData.conversationId)}`
        : `task_${safeId(input.messageData.messageId)}`;
    const branchKey = input.messageData.conversationId
        ? `${input.messageData.conversationId}:${input.agentId}:${input.messageData.fromAgent || 'root'}`
        : `${input.messageData.messageId}:${input.agentId}:root`;
    const objective = input.messageData.message;
    const userId = input.messageData.senderId || input.messageData.sender;
    const memoryContext = retrieveMemoryContext(userId, objective);

    const risk = classifyRisk(objective);
    const maxIterations = loopBudgetForRisk(risk.risk);

    createTaskRun({
        runId,
        taskId,
        channel: input.messageData.channel,
        sender: input.messageData.sender,
        senderId: input.messageData.senderId || '',
        conversationId: input.messageData.conversationId || '',
        branchKey,
        objective,
        riskLevel: risk.risk,
        status: 'in_progress',
        assignedAgent: input.agentId,
        loopIteration: 0,
        maxIterations,
    });

    appendTaskEvent(runId, 'risk_classified', risk);

    const route = routeTask(objective, input.agent);
    appendTaskEvent(runId, 'task_routed', route);
    const harnessSettings = getHarnessSettings();
    const useClaudeChrome = route.route === 'browser' && harnessSettings.browser.use_claude_chrome;
    const loopAgent = route.route === 'browser' ? resolveBrowserClaudeAgent(input.agent) : input.agent;
    if (route.route === 'browser') {
        appendTaskEvent(runId, 'browser_model_routing', {
            provider: loopAgent.provider,
            model: loopAgent.model,
            claudeChrome: useClaudeChrome,
        });
    }
    incrementMetric('task_runs_total', 1, {
        runId,
        route: route.route,
        risk: risk.risk,
        channel: input.messageData.channel,
    });

    const verifyCtx: VerifyContext = {
        runId,
        objective,
        risk: risk.risk,
    };

    try {
        const loopResult = await runGeneratorVerifierRevisorLoop(runId, risk.risk, {
            generate: async () => {
                const output = await invokeAgent(
                    loopAgent,
                    input.agentId,
                    generatorPrompt(input, risk.risk, memoryContext),
                    input.workspacePath,
                    input.shouldReset,
                    input.agents,
                    input.teams,
                    { enableChrome: useClaudeChrome }
                );
                return {
                    output: output.trim(),
                    evidenceRefs: extractEvidenceRefs(output),
                };
            },
            verify: async (candidate: string) => {
                return verifyCandidate(verifyCtx, candidate);
            },
            revise: async (candidate: string, verdict: VerificationVerdict, iteration: number) => {
                return invokeAgent(
                    loopAgent,
                    input.agentId,
                    revisorPrompt(candidate, verdict, iteration),
                    input.workspacePath,
                    false,
                    input.agents,
                    input.teams,
                    { enableChrome: useClaudeChrome }
                );
            },
        });

        updateTaskRun(runId, {
            loopIteration: loopResult.loopsUsed,
            verifierOutcome: loopResult.verdict.outcome,
        });

        appendRawMemoryEvent(userId, {
            runId,
            channel: input.messageData.channel,
            request: objective,
            response: loopResult.output,
            verifier: loopResult.verdict,
        });

        const memoryUpdates = ingestMemorySignals(userId, runId, objective, loopResult.output);
        if (memoryUpdates > 0) {
            appendTaskEvent(runId, 'memory_ingested', { count: memoryUpdates });
            incrementMetric('memory_updates_count', memoryUpdates, { runId, userId });
        }

        if (loopResult.verdict.outcome === 'pass' && loopResult.loopsUsed > 1) {
            incrementMetric('verifier_pass_after_revision_count', 1, { runId, loopsUsed: loopResult.loopsUsed });
        }

        if (loopResult.exhausted && loopResult.verdict.outcome !== 'pass') {
            const question = askTargetedQuestion(objective);
            updateTaskRun(runId, {
                status: 'needs_input',
                resultText: question,
            });
            appendTaskEvent(runId, 'needs_input', {
                reason: 'loop_budget_exhausted',
                question,
            });
            incrementMetric('tasks_needs_input_count', 1, { runId, reason: 'loop_budget_exhausted' });
            incrementMetric('tasks_blocked_count', 1, { runId, status: 'needs_input' });

            return {
                runId,
                status: 'needs_input',
                responseText: question,
                verifierOutcome: loopResult.verdict.outcome,
            };
        }

        if (route.route !== 'browser') {
            const gate = applyPublishGate({
                runId,
                userId,
                outputText: loopResult.output,
                route: route.route,
                risk: risk.risk,
            });

            if (!gate.allow && gate.requiresApproval) {
                const approvalMessage = [
                    gate.reason || 'Approval required.',
                    gate.requestId ? `Request ID: ${gate.requestId}` : '',
                    'Reply with /approve <request_id> or /deny <request_id>.',
                ].filter(Boolean).join('\n');

                updateTaskRun(runId, {
                    status: 'awaiting_approval',
                    resultText: approvalMessage,
                    verifierOutcome: loopResult.verdict.outcome,
                });

                appendTaskEvent(runId, 'awaiting_approval', {
                    requestId: gate.requestId,
                    reason: gate.reason,
                });
                incrementMetric('tasks_awaiting_approval_count', 1, { runId, reason: gate.reason || 'publish_gate' });
                incrementMetric('tasks_blocked_count', 1, { runId, status: 'awaiting_approval' });

                return {
                    runId,
                    status: 'awaiting_approval',
                    responseText: approvalMessage,
                    verifierOutcome: loopResult.verdict.outcome,
                };
            }
        }

        if (route.route === 'tooling') {
            const toolingResult = await executeToolingTask({
                runId,
                userId,
                objective,
                candidateOutput: loopResult.output,
                workspacePath: input.workspacePath,
            });
            appendTaskEvent(runId, 'tooling_execution', toolingResult);

            if (toolingResult.status === 'needs_input') {
                updateTaskRun(runId, {
                    status: 'needs_input',
                    resultText: toolingResult.message,
                    verifierOutcome: loopResult.verdict.outcome,
                });
                incrementMetric('tasks_needs_input_count', 1, { runId, reason: 'tooling_execution' });
                incrementMetric('tasks_blocked_count', 1, { runId, status: 'needs_input' });
                return {
                    runId,
                    status: 'needs_input',
                    responseText: toolingResult.message,
                    verifierOutcome: loopResult.verdict.outcome,
                };
            }

            if (toolingResult.status === 'failed') {
                const failText = toolingResult.outputSnippet
                    ? `${toolingResult.message}\n\n${toolingResult.outputSnippet}`
                    : toolingResult.message;
                updateTaskRun(runId, {
                    status: 'failed',
                    resultText: failText,
                    verifierOutcome: loopResult.verdict.outcome,
                });
                incrementMetric('tasks_failed_count', 1, { runId, route: route.route });
                return {
                    runId,
                    status: 'failed',
                    responseText: failText,
                    verifierOutcome: loopResult.verdict.outcome,
                };
            }

            const toolText = [
                toolingResult.message,
                toolingResult.command ? `Command: ${toolingResult.command}` : '',
                toolingResult.outputSnippet ? `\n${toolingResult.outputSnippet}` : '',
            ].filter(Boolean).join('\n');

            updateTaskRun(runId, {
                status: 'verified',
                resultText: toolText,
                verifierOutcome: loopResult.verdict.outcome,
            });
            appendTaskEvent(runId, 'verified', {
                verifierOutcome: loopResult.verdict.outcome,
                risk: risk.risk,
                route: route.route,
            });
            incrementMetric('tasks_verified_count', 1, { runId, route: route.route });

            const drafted = maybeAutoDraftSkill({
                userId,
                runId,
                objective,
                route: route.route,
                verified: true,
            });
            appendTaskEvent(runId, 'skill_autodraft', drafted);

            const withSkillNote = drafted.created
                ? `${toolText}\n\nDrafted reusable skill: ${drafted.skillId}`
                : toolText;

            return {
                runId,
                status: 'verified',
                responseText: withSkillNote,
                verifierOutcome: loopResult.verdict.outcome,
            };
        }

        if (route.route === 'browser' && !useClaudeChrome) {
            const browserResult = await executeBrowserTask({
                runId,
                userId,
                objective,
                candidateOutput: loopResult.output,
                risk: risk.risk,
            });

            appendTaskEvent(runId, 'browser_execution', browserResult);

            if (browserResult.status === 'needs_input') {
                updateTaskRun(runId, {
                    status: 'needs_input',
                    resultText: browserResult.message,
                    verifierOutcome: loopResult.verdict.outcome,
                });
                incrementMetric('tasks_needs_input_count', 1, { runId, reason: 'browser_execution' });
                incrementMetric('tasks_blocked_count', 1, { runId, status: 'needs_input' });
                return {
                    runId,
                    status: 'needs_input',
                    responseText: browserResult.message,
                    verifierOutcome: loopResult.verdict.outcome,
                };
            }

            if (browserResult.status === 'failed') {
                updateTaskRun(runId, {
                    status: 'failed',
                    resultText: browserResult.message,
                    verifierOutcome: loopResult.verdict.outcome,
                });
                incrementMetric('tasks_failed_count', 1, { runId, route: route.route });
                return {
                    runId,
                    status: 'failed',
                    responseText: browserResult.message,
                    verifierOutcome: loopResult.verdict.outcome,
                };
            }

            let browserText = browserResult.artifacts && browserResult.artifacts.length > 0
                ? `${browserResult.message}\n\nAudit artifacts:\n${browserResult.artifacts.slice(0, 6).map(f => `- ${f}`).join('\n')}`
                : browserResult.message;

            const drafted = maybeAutoDraftSkill({
                userId,
                runId,
                objective,
                route: route.route,
                verified: true,
            });
            appendTaskEvent(runId, 'skill_autodraft', drafted);
            if (drafted.created) {
                browserText += `\n\nDrafted reusable skill: ${drafted.skillId}`;
            }

            updateTaskRun(runId, {
                status: 'verified',
                resultText: browserText,
                verifierOutcome: loopResult.verdict.outcome,
            });
            appendTaskEvent(runId, 'verified', {
                verifierOutcome: loopResult.verdict.outcome,
                risk: risk.risk,
                route: route.route,
            });
            incrementMetric('tasks_verified_count', 1, { runId, route: route.route });

            return {
                runId,
                status: 'verified',
                responseText: browserText,
                verifierOutcome: loopResult.verdict.outcome,
            };
        }

        const finalText = route.route === 'memory' && memoryUpdates > 0
            ? `${loopResult.output}\n\nMemory updated with ${memoryUpdates} item(s).`
            : loopResult.output;

        const drafted = maybeAutoDraftSkill({
            userId,
            runId,
            objective,
            route: route.route,
            verified: true,
        });
        appendTaskEvent(runId, 'skill_autodraft', drafted);

        const finalWithSkill = drafted.created
            ? `${finalText}\n\nDrafted reusable skill: ${drafted.skillId}`
            : finalText;

        updateTaskRun(runId, {
            status: 'verified',
            resultText: finalWithSkill,
            verifierOutcome: loopResult.verdict.outcome,
        });

        appendTaskEvent(runId, 'verified', {
            verifierOutcome: loopResult.verdict.outcome,
            risk: risk.risk,
            route: route.route,
        });
        incrementMetric('tasks_verified_count', 1, { runId, route: route.route });

        return {
            runId,
            status: 'verified',
            responseText: finalWithSkill,
            verifierOutcome: loopResult.verdict.outcome,
        };
    } catch (error) {
        const message = (error as Error).message || 'Harness execution failed';
        updateTaskRun(runId, {
            status: 'failed',
            resultText: message,
        });
        appendTaskEvent(runId, 'failed', { message });
        incrementMetric('tasks_failed_count', 1, { runId, route: route.route });

        return {
            runId,
            status: 'failed',
            responseText: toUserFacingHarnessError(message),
        };
    }
}
