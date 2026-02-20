import { appendTaskEvent, appendTaskStep } from '../repository';
import { VerificationVerdict, VerifierOutcome, RiskLevel } from '../types';

export interface LoopCallbacks {
    generate: () => Promise<{ output: string; evidenceRefs?: string[] }>;
    verify: (candidate: string, iteration: number) => Promise<VerificationVerdict>;
    revise: (candidate: string, verdict: VerificationVerdict, iteration: number) => Promise<string>;
}

export interface LoopResult {
    output: string;
    verdict: VerificationVerdict;
    loopsUsed: number;
    exhausted: boolean;
}

function budgetForRisk(risk: RiskLevel): number {
    if (risk === 'critical' || risk === 'high') return 5;
    if (risk === 'medium') return 3;
    return 1;
}

function isResolvable(outcome: VerifierOutcome): boolean {
    return outcome === 'minor_fix' || outcome === 'critical_fail';
}

export async function runGeneratorVerifierRevisorLoop(
    runId: string,
    risk: RiskLevel,
    callbacks: LoopCallbacks
): Promise<LoopResult> {
    const maxLoops = budgetForRisk(risk);

    let generated = await callbacks.generate();
    appendTaskStep(runId, 'generator', { iteration: 1, outputPreview: generated.output.slice(0, 1000), evidenceRefs: generated.evidenceRefs || [] });

    let verdict = await callbacks.verify(generated.output, 1);
    appendTaskStep(runId, 'verifier', { iteration: 1, verdict });

    for (let iteration = 1; iteration <= maxLoops; iteration += 1) {
        if (verdict.outcome === 'pass' || verdict.outcome === 'abstain') {
            appendTaskEvent(runId, 'loop_completed', {
                iteration,
                outcome: verdict.outcome,
            });
            return {
                output: generated.output,
                verdict,
                loopsUsed: iteration,
                exhausted: false,
            };
        }

        if (!isResolvable(verdict.outcome) || iteration >= maxLoops) {
            appendTaskEvent(runId, 'loop_exhausted', {
                iteration,
                outcome: verdict.outcome,
            });
            return {
                output: generated.output,
                verdict,
                loopsUsed: iteration,
                exhausted: true,
            };
        }

        const revised = await callbacks.revise(generated.output, verdict, iteration + 1);
        appendTaskStep(runId, 'revisor', { iteration: iteration + 1, outputPreview: revised.slice(0, 1000) });

        generated = { output: revised, evidenceRefs: verdict.evidenceRefs };
        verdict = await callbacks.verify(generated.output, iteration + 1);
        appendTaskStep(runId, 'verifier', { iteration: iteration + 1, verdict });
    }

    return {
        output: generated.output,
        verdict,
        loopsUsed: maxLoops,
        exhausted: true,
    };
}
