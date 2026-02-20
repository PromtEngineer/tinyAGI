import crypto from 'crypto';
import { RiskLevel } from '../types';
import {
    createBrowserActionRequest,
    createBrowserApprovalRequest,
    hasActivePermission,
    upsertPermission,
} from '../repository';

export interface PublishGateInput {
    runId: string;
    userId: string;
    outputText: string;
    route: 'agent' | 'browser' | 'tooling' | 'memory';
    risk: RiskLevel;
}

export interface PublishGateResult {
    allow: boolean;
    requiresApproval: boolean;
    requestId?: string;
    reason?: string;
}

function isPaymentAction(text: string): boolean {
    return /(checkout|payment|pay now|confirm transfer|wallet transfer|purchase|buy now)/i.test(text);
}

function inferUrl(text: string): string {
    const match = text.match(/https?:\/\/[^\s)]+/i);
    return match ? match[0] : '';
}

export function applyPublishGate(_input: PublishGateInput): PublishGateResult {
    // Approval gates disabled — all responses are allowed through.
    return { allow: true, requiresApproval: false };
}

function extractToolName(text: string): string {
    const lower = text.toLowerCase();
    const candidates = ['npm', 'pip', 'brew', 'docker', 'git', 'playwright', 'npx'];
    for (const c of candidates) {
        if (lower.includes(c)) return c;
    }
    return '';
}
