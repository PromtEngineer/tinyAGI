export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type RunStatus =
    | 'queued'
    | 'in_progress'
    | 'needs_input'
    | 'needs_revision'
    | 'verified'
    | 'rejected'
    | 'awaiting_approval'
    | 'sent'
    | 'failed';

export type VerifierOutcome = 'pass' | 'minor_fix' | 'critical_fail' | 'abstain';

export interface TaskSpec {
    taskId: string;
    source: 'whatsapp' | 'telegram' | 'discord' | 'system';
    userId: string;
    objective: string;
    constraints: string[];
    acceptanceCriteria: string[];
    riskLevel?: RiskLevel;
    requiresHumanCheckpoint?: boolean;
    channelContext?: {
        channel: string;
        senderId: string;
        threadId: string;
    };
}

export interface TaskRun {
    runId: string;
    taskId: string;
    status: RunStatus;
    assignedAgent: string;
    startedAt: number;
    updatedAt: number;
    loopIteration: number;
    maxIterations: number;
}

export interface VerificationVerdict {
    runId: string;
    verifier: 'policy' | 'factual' | 'citation' | 'code' | 'tool_safety' | 'memory_consistency' | 'llm';
    outcome: VerifierOutcome;
    findings: string[];
    requiredActions: string[];
    evidenceRefs: string[];
}

export interface PermissionGrant {
    grantId: string;
    userId: string;
    scope: 'tool_install' | 'tool_execute' | 'external_action' | 'browser_payment';
    subject: string;
    riskCeiling: 'low' | 'medium' | 'high';
    status: 'active' | 'revoked';
    grantedAt: number;
    revokedAt?: number;
}

export interface MemoryRecord {
    memoryId: string;
    userId: string;
    kind: 'preference' | 'project' | 'workflow' | 'contact' | 'fact' | 'task_state';
    content: string;
    confidence: number;
    sourceRefs: string[];
    lastConfirmedAt: number;
}

export interface BrowserActionRequest {
    requestId: string;
    runId: string;
    userId: string;
    url: string;
    action: string;
    selector?: string;
    risk: RiskLevel;
    requiresApproval: boolean;
    status: 'pending' | 'approved' | 'denied' | 'executed' | 'failed';
    createdAt: number;
}

export interface BrowserActionAudit {
    auditId: string;
    requestId: string;
    runId: string;
    timestamp: number;
    step: string;
    url: string;
    screenshotPath?: string;
    details: string;
}

export interface SkillDraft {
    draftId: string;
    userId: string;
    name: string;
    prompt: string;
    createdAt: number;
    status: 'draft' | 'verified' | 'active' | 'disabled';
}

export interface SkillVersion {
    skillId: string;
    version: number;
    path: string;
    createdAt: number;
    verifierSummary: string;
}

