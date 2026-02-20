import fs from 'fs';
import path from 'path';
import { getHarnessDb, toJson } from './db';
import { RunStatus, RiskLevel, VerifierOutcome } from './types';
import { MEMORY_DIR } from '../lib/config';

function q(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function now(): number {
    return Date.now();
}

function dayPath(ts = Date.now()): { raw: string; daily: string } {
    const d = new Date(ts);
    const y = `${d.getUTCFullYear()}`;
    const m = `${d.getUTCMonth() + 1}`.padStart(2, '0');
    const dd = `${d.getUTCDate()}`.padStart(2, '0');
    const rawDir = path.join(MEMORY_DIR, 'raw', y, m, dd);
    const dailyFile = path.join(MEMORY_DIR, 'daily', `${y}-${m}-${dd}.md`);
    return { raw: rawDir, daily: dailyFile };
}

export interface CreateTaskRunInput {
    runId: string;
    taskId: string;
    channel: string;
    sender: string;
    senderId?: string;
    conversationId?: string;
    branchKey?: string;
    objective: string;
    riskLevel: RiskLevel;
    status: RunStatus;
    assignedAgent?: string;
    loopIteration: number;
    maxIterations: number;
}

export function createTaskRun(input: CreateTaskRunInput): void {
    const db = getHarnessDb();
    const t = now();
    db.insert('task_runs', {
        run_id: input.runId,
        task_id: input.taskId,
        channel: input.channel,
        sender: input.sender,
        sender_id: input.senderId || '',
        conversation_id: input.conversationId || '',
        branch_key: input.branchKey || '',
        objective: input.objective,
        risk_level: input.riskLevel,
        status: input.status,
        assigned_agent: input.assignedAgent || '',
        loop_iteration: input.loopIteration,
        max_iterations: input.maxIterations,
        created_at: t,
        updated_at: t,
    });
}

export function updateTaskRun(
    runId: string,
    patch: Partial<{
        status: RunStatus;
        loopIteration: number;
        resultText: string;
        verifierOutcome: VerifierOutcome;
    }>
): void {
    const db = getHarnessDb();
    const updates: Record<string, string | number> = { updated_at: now() };
    if (patch.status) updates.status = patch.status;
    if (typeof patch.loopIteration === 'number') updates.loop_iteration = patch.loopIteration;
    if (typeof patch.resultText === 'string') updates.result_text = patch.resultText;
    if (patch.verifierOutcome) updates.verifier_outcome = patch.verifierOutcome;
    db.update('task_runs', updates, `run_id = ${q(runId)}`);
}

export function appendTaskStep(runId: string, stepType: string, payload: unknown): void {
    const db = getHarnessDb();
    db.insert('task_steps', {
        run_id: runId,
        step_type: stepType,
        payload_json: toJson(payload),
        created_at: now(),
    });
}

export function appendTaskEvent(runId: string, eventType: string, payload?: unknown): void {
    const db = getHarnessDb();
    db.insert('task_events', {
        run_id: runId,
        event_type: eventType,
        payload_json: toJson(payload || {}),
        created_at: now(),
    });
}

export interface TaskRunRow {
    run_id: string;
    task_id: string;
    channel: string;
    sender: string;
    sender_id: string;
    conversation_id: string;
    branch_key: string;
    objective: string;
    risk_level: RiskLevel;
    status: RunStatus;
    assigned_agent: string;
    loop_iteration: number;
    max_iterations: number;
    result_text: string;
    verifier_outcome?: VerifierOutcome;
    created_at: number;
    updated_at: number;
}

export function listTaskRuns(limit = 50): TaskRunRow[] {
    const db = getHarnessDb();
    return db.all<TaskRunRow>(
        `SELECT * FROM task_runs ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(limit, 200))};`
    );
}

export function getTaskRun(runId: string): TaskRunRow | null {
    const db = getHarnessDb();
    return db.get<TaskRunRow>(`SELECT * FROM task_runs WHERE run_id = ${q(runId)} LIMIT 1;`);
}

export interface DigestTargetRow {
    channel: string;
    sender: string;
    sender_id: string;
}

export function listDigestTargets(limit = 100): DigestTargetRow[] {
    const db = getHarnessDb();
    return db.all<DigestTargetRow>(`
SELECT channel, sender, sender_id
FROM task_runs
WHERE sender_id IS NOT NULL AND sender_id != ''
GROUP BY channel, sender, sender_id
ORDER BY MAX(updated_at) DESC
LIMIT ${Math.max(1, Math.min(limit, 1000))};
`);
}

export interface BlockedRunRow {
    run_id: string;
    channel: string;
    sender: string;
    sender_id: string;
    status: RunStatus;
    objective: string;
    result_text: string;
    created_at: number;
    updated_at: number;
}

export function listBlockedRunsForOutreach(minAgeMs: number, limit = 100): BlockedRunRow[] {
    const db = getHarnessDb();
    const cutoff = now() - Math.max(0, minAgeMs);
    return db.all<BlockedRunRow>(`
SELECT
  tr.run_id,
  tr.channel,
  tr.sender,
  tr.sender_id,
  tr.status,
  tr.objective,
  COALESCE(tr.result_text, '') AS result_text,
  tr.created_at,
  tr.updated_at
FROM task_runs tr
WHERE tr.status IN ('needs_input', 'awaiting_approval')
  AND tr.sender_id IS NOT NULL
  AND tr.sender_id != ''
  AND tr.updated_at <= ${cutoff}
  AND NOT EXISTS (
    SELECT 1
    FROM task_runs newer
    WHERE newer.channel = tr.channel
      AND newer.sender_id = tr.sender_id
      AND newer.run_id != tr.run_id
      AND newer.created_at > tr.updated_at
  )
ORDER BY tr.updated_at ASC
LIMIT ${Math.max(1, Math.min(limit, 1000))};
`);
}

export function getLastTaskEventAt(runId: string, eventType: string): number {
    const db = getHarnessDb();
    const row = db.get<{ ts: number }>(`
SELECT MAX(created_at) as ts
FROM task_events
WHERE run_id = ${q(runId)} AND event_type = ${q(eventType)};
`);
    return row?.ts || 0;
}

export function getTaskEventCount(runId: string, eventType: string): number {
    const db = getHarnessDb();
    const row = db.get<{ count: number }>(`
SELECT COUNT(*) as count
FROM task_events
WHERE run_id = ${q(runId)} AND event_type = ${q(eventType)};
`);
    return row?.count || 0;
}

export function supersedeNeedsInputRuns(channel: string, senderId: string, beforeTs = now()): string[] {
    if (!senderId) return [];

    const db = getHarnessDb();
    const rows = db.all<{ run_id: string }>(`
SELECT run_id
FROM task_runs
WHERE channel = ${q(channel)}
  AND sender_id = ${q(senderId)}
  AND status = 'needs_input'
  AND updated_at < ${beforeTs}
ORDER BY updated_at ASC
LIMIT 200;
`);

    if (rows.length === 0) return [];

    const t = now();
    for (const row of rows) {
        db.update('task_runs', {
            status: 'rejected',
            updated_at: t,
        }, `run_id = ${q(row.run_id)}`);
    }

    return rows.map(r => r.run_id);
}

export interface TaskStepRow {
    id: number;
    run_id: string;
    step_type: string;
    payload_json: string;
    created_at: number;
}

export interface TaskEventRow {
    id: number;
    run_id: string;
    event_type: string;
    payload_json: string;
    created_at: number;
}

export function listTaskSteps(runId: string): TaskStepRow[] {
    const db = getHarnessDb();
    return db.all<TaskStepRow>(`SELECT * FROM task_steps WHERE run_id = ${q(runId)} ORDER BY id ASC;`);
}

export function listTaskEvents(runId: string): TaskEventRow[] {
    const db = getHarnessDb();
    return db.all<TaskEventRow>(`SELECT * FROM task_events WHERE run_id = ${q(runId)} ORDER BY id ASC;`);
}

export interface MemoryInsertInput {
    recordId: string;
    userId: string;
    category: 'preferences' | 'projects' | 'workflows' | 'contacts' | 'task_states' | 'confirmed_facts';
    key: string;
    value: string;
    confidence: number;
    sourceRunId?: string;
}

export function upsertMemoryRecord(input: MemoryInsertInput): void {
    const db = getHarnessDb();
    const t = now();
    db.upsert(
        'memory_records',
        {
            record_id: input.recordId,
            user_id: input.userId,
            category: input.category,
            key: input.key,
            value: input.value,
            confidence: input.confidence,
            source_run_id: input.sourceRunId || '',
            created_at: t,
            updated_at: t,
        },
        ['record_id'],
        ['value', 'confidence', 'source_run_id', 'updated_at']
    );
}

export interface MemoryRow {
    record_id: string;
    user_id: string;
    category: string;
    key: string;
    value: string;
    confidence: number;
    source_run_id: string;
    created_at: number;
    updated_at: number;
}

export function listMemory(userId: string, topic = ''): MemoryRow[] {
    const db = getHarnessDb();
    const where = topic
        ? `user_id = ${q(userId)} AND (key LIKE ${q(`%${topic}%`)} OR value LIKE ${q(`%${topic}%`)})`
        : `user_id = ${q(userId)}`;
    return db.all<MemoryRow>(`SELECT * FROM memory_records WHERE ${where} ORDER BY updated_at DESC LIMIT 200;`);
}

export function forgetMemory(userId: string, topic: string): number {
    const db = getHarnessDb();
    const before = db.get<{ count: number }>(`SELECT COUNT(*) as count FROM memory_records WHERE user_id = ${q(userId)} AND (key LIKE ${q(`%${topic}%`)} OR value LIKE ${q(`%${topic}%`)});`);
    db.exec(`DELETE FROM memory_records WHERE user_id = ${q(userId)} AND (key LIKE ${q(`%${topic}%`)} OR value LIKE ${q(`%${topic}%`)});`);
    return before?.count || 0;
}

export function appendRawMemoryEvent(userId: string, payload: Record<string, unknown>): string {
    const { raw } = dayPath();
    fs.mkdirSync(raw, { recursive: true });
    const f = path.join(raw, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jsonl`);
    fs.writeFileSync(f, `${JSON.stringify({ userId, timestamp: now(), ...payload })}\n`, { flag: 'a' });
    return f;
}

export function saveDailySummary(summaryDate: string, summaryText: string): string {
    const db = getHarnessDb();
    const [y, m, d] = summaryDate.split('-');
    const dir = path.join(MEMORY_DIR, 'daily', y || '', m || '');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${summaryDate}.md`);
    fs.writeFileSync(file, summaryText);

    db.upsert(
        'memory_summaries',
        {
            summary_date: summaryDate,
            summary_path: file,
            summary_text: summaryText,
            created_at: now(),
        },
        ['summary_date'],
        ['summary_path', 'summary_text', 'created_at']
    );

    return file;
}

export interface PermissionRow {
    permission_id: string;
    user_id: string;
    subject: string;
    action: string;
    resource: string;
    status: 'active' | 'revoked' | 'pending';
    created_at: number;
    updated_at: number;
}

export function listPermissions(userId = ''): PermissionRow[] {
    const db = getHarnessDb();
    const where = userId ? `WHERE user_id = ${q(userId)}` : '';
    return db.all<PermissionRow>(`SELECT * FROM permissions ${where} ORDER BY updated_at DESC;`);
}

export function getPermission(permissionId: string): PermissionRow | null {
    const db = getHarnessDb();
    return db.get<PermissionRow>(`SELECT * FROM permissions WHERE permission_id = ${q(permissionId)} LIMIT 1;`);
}

export function upsertPermission(
    permissionId: string,
    userId: string,
    subject: string,
    action: string,
    resource: string,
    status: 'active' | 'revoked' | 'pending'
): void {
    const db = getHarnessDb();
    const t = now();
    db.upsert(
        'permissions',
        {
            permission_id: permissionId,
            user_id: userId,
            subject,
            action,
            resource,
            status,
            created_at: t,
            updated_at: t,
        },
        ['permission_id'],
        ['status', 'resource', 'updated_at']
    );
}

export function hasActivePermission(userId: string, subject: string, action: string): boolean {
    const db = getHarnessDb();
    const row = db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM permissions WHERE user_id = ${q(userId)} AND subject = ${q(subject)} AND action = ${q(action)} AND status = 'active';`
    );
    return (row?.count || 0) > 0;
}

export interface ToolRow {
    tool_id: string;
    name: string;
    source: string;
    trust_class: string;
    status: 'approved' | 'blocked' | 'pending';
    last_verified_at: number;
    metadata_json: string;
    created_at: number;
    updated_at: number;
}

export function upsertTool(
    toolId: string,
    name: string,
    source: string,
    trustClass: 'curated' | 'mainstream' | 'unknown',
    status: 'approved' | 'blocked' | 'pending',
    metadata?: Record<string, unknown>
): void {
    const db = getHarnessDb();
    const t = now();
    db.upsert(
        'tool_registry',
        {
            tool_id: toolId,
            name,
            source,
            trust_class: trustClass,
            status,
            last_verified_at: t,
            metadata_json: toJson(metadata || {}),
            created_at: t,
            updated_at: t,
        },
        ['tool_id'],
        ['name', 'source', 'trust_class', 'status', 'last_verified_at', 'metadata_json', 'updated_at']
    );
}

export function listTools(): ToolRow[] {
    const db = getHarnessDb();
    return db.all<ToolRow>('SELECT * FROM tool_registry ORDER BY updated_at DESC;');
}

export function getToolByName(name: string): ToolRow | null {
    const db = getHarnessDb();
    return db.get<ToolRow>(`SELECT * FROM tool_registry WHERE lower(name) = lower(${q(name)}) LIMIT 1;`);
}

export function appendToolEvent(toolId: string, eventType: string, payload?: unknown): void {
    const db = getHarnessDb();
    db.insert('tool_events', {
        tool_id: toolId,
        event_type: eventType,
        payload_json: toJson(payload || {}),
        created_at: now(),
    });
}

export interface BrowserSessionRow {
    session_id: string;
    profile_path: string;
    debugger_url: string;
    chrome_pid: number;
    status: 'active' | 'stopped' | 'error';
    created_at: number;
    updated_at: number;
}

export function upsertBrowserSession(session: BrowserSessionRow): void {
    const db = getHarnessDb();
    db.upsert(
        'browser_sessions',
        {
            session_id: session.session_id,
            profile_path: session.profile_path,
            debugger_url: session.debugger_url,
            chrome_pid: session.chrome_pid,
            status: session.status,
            created_at: session.created_at,
            updated_at: session.updated_at,
        },
        ['session_id'],
        ['profile_path', 'debugger_url', 'chrome_pid', 'status', 'updated_at']
    );
}

export function listBrowserSessions(): BrowserSessionRow[] {
    const db = getHarnessDb();
    return db.all<BrowserSessionRow>('SELECT * FROM browser_sessions ORDER BY updated_at DESC LIMIT 50;');
}

export function createBrowserActionRequest(input: {
    actionId: string;
    runId: string;
    sessionId: string;
    url: string;
    action: string;
    selector?: string;
    risk: RiskLevel;
    requiresApproval: boolean;
}): void {
    const db = getHarnessDb();
    const t = now();
    db.insert('browser_actions', {
        action_id: input.actionId,
        run_id: input.runId,
        session_id: input.sessionId,
        url: input.url,
        action: input.action,
        selector: input.selector || '',
        risk: input.risk,
        status: input.requiresApproval ? 'pending' : 'approved',
        requires_approval: input.requiresApproval ? 1 : 0,
        created_at: t,
        updated_at: t,
    });
}

export function updateBrowserActionStatus(actionId: string, status: 'pending' | 'approved' | 'denied' | 'executed' | 'failed'): void {
    const db = getHarnessDb();
    db.update('browser_actions', { status, updated_at: now() }, `action_id = ${q(actionId)}`);
}

export function createBrowserApprovalRequest(input: {
    requestId: string;
    actionId: string;
    userId: string;
    reason: string;
}): void {
    const db = getHarnessDb();
    const t = now();
    db.insert('browser_approvals', {
        request_id: input.requestId,
        action_id: input.actionId,
        user_id: input.userId,
        status: 'pending',
        reason: input.reason,
        created_at: t,
        updated_at: t,
    });
}

export interface BrowserApprovalRow {
    request_id: string;
    action_id: string;
    user_id: string;
    status: 'pending' | 'approved' | 'denied';
    reason: string;
    created_at: number;
    updated_at: number;
}

export function listBrowserApprovals(userId = ''): BrowserApprovalRow[] {
    const db = getHarnessDb();
    const where = userId ? `WHERE user_id = ${q(userId)}` : '';
    return db.all<BrowserApprovalRow>(`SELECT * FROM browser_approvals ${where} ORDER BY updated_at DESC;`);
}

export function resolveBrowserApproval(requestId: string, approve: boolean, reason = ''): boolean {
    const db = getHarnessDb();
    const row = db.get<BrowserApprovalRow>(`SELECT * FROM browser_approvals WHERE request_id = ${q(requestId)} LIMIT 1;`);
    if (!row) return false;

    const status = approve ? 'approved' : 'denied';
    db.update('browser_approvals', { status, reason, updated_at: now() }, `request_id = ${q(requestId)}`);

    const actionStatus = approve ? 'approved' : 'denied';
    db.update('browser_actions', { status: actionStatus, updated_at: now() }, `action_id = ${q(row.action_id)}`);
    return true;
}

export function appendBrowserAudit(input: {
    actionId: string;
    runId: string;
    step: string;
    url: string;
    screenshotBefore?: string;
    screenshotAfter?: string;
    selectorTrace?: string;
    details?: Record<string, unknown>;
}): void {
    const db = getHarnessDb();
    db.insert('browser_audits', {
        action_id: input.actionId,
        run_id: input.runId,
        step: input.step,
        url: input.url,
        screenshot_before: input.screenshotBefore || '',
        screenshot_after: input.screenshotAfter || '',
        selector_trace: input.selectorTrace || '',
        details_json: toJson(input.details || {}),
        created_at: now(),
    });
}

export interface BrowserTabRow {
    tab_id: string;
    session_id: string;
    run_id: string;
    owner: string;
    status: 'active' | 'released' | 'error';
    url: string;
    selector_trace_json: string;
    created_at: number;
    updated_at: number;
}

export function upsertBrowserTab(input: {
    tabId: string;
    sessionId: string;
    runId: string;
    owner: string;
    status: 'active' | 'released' | 'error';
    url: string;
    selectorTraceJson?: string;
}): void {
    const db = getHarnessDb();
    const t = now();
    db.upsert(
        'browser_tabs',
        {
            tab_id: input.tabId,
            session_id: input.sessionId,
            run_id: input.runId,
            owner: input.owner,
            status: input.status,
            url: input.url,
            selector_trace_json: input.selectorTraceJson || '[]',
            created_at: t,
            updated_at: t,
        },
        ['tab_id'],
        ['status', 'url', 'selector_trace_json', 'updated_at']
    );
}

export function listBrowserTabs(runId = ''): BrowserTabRow[] {
    const db = getHarnessDb();
    const where = runId ? `WHERE run_id = ${q(runId)}` : '';
    return db.all<BrowserTabRow>(`SELECT * FROM browser_tabs ${where} ORDER BY updated_at DESC LIMIT 200;`);
}

export interface BrowserAuditRow {
    id: number;
    action_id: string;
    run_id: string;
    step: string;
    url: string;
    screenshot_before: string;
    screenshot_after: string;
    selector_trace: string;
    details_json: string;
    created_at: number;
}

export function listBrowserAuditsByRun(runId: string, limit = 500): BrowserAuditRow[] {
    const db = getHarnessDb();
    return db.all<BrowserAuditRow>(`
SELECT *
FROM browser_audits
WHERE run_id = ${q(runId)}
ORDER BY id ASC
LIMIT ${Math.max(1, Math.min(limit, 5000))};
`);
}

export function listBrowserAuditsByAction(actionId: string, limit = 200): BrowserAuditRow[] {
    const db = getHarnessDb();
    return db.all<BrowserAuditRow>(`
SELECT *
FROM browser_audits
WHERE action_id = ${q(actionId)}
ORDER BY id ASC
LIMIT ${Math.max(1, Math.min(limit, 1000))};
`);
}

export interface ChannelPendingMessageRow {
    message_id: string;
    channel: string;
    sender: string;
    sender_id: string;
    chat_ref: string;
    reply_ref: string;
    expires_at: number;
    created_at: number;
    updated_at: number;
}

export function upsertChannelPendingMessage(input: {
    messageId: string;
    channel: string;
    sender: string;
    senderId: string;
    chatRef?: string;
    replyRef?: string;
    expiresAt: number;
}): void {
    const db = getHarnessDb();
    const t = now();
    db.upsert(
        'channel_pending_messages',
        {
            message_id: input.messageId,
            channel: input.channel,
            sender: input.sender,
            sender_id: input.senderId,
            chat_ref: input.chatRef || '',
            reply_ref: input.replyRef || '',
            expires_at: input.expiresAt,
            created_at: t,
            updated_at: t,
        },
        ['message_id'],
        ['channel', 'sender', 'sender_id', 'chat_ref', 'reply_ref', 'expires_at', 'updated_at']
    );
}

export function getChannelPendingMessage(messageId: string): ChannelPendingMessageRow | null {
    const db = getHarnessDb();
    return db.get<ChannelPendingMessageRow>(`SELECT * FROM channel_pending_messages WHERE message_id = ${q(messageId)} LIMIT 1;`);
}

export function deleteChannelPendingMessage(messageId: string): void {
    const db = getHarnessDb();
    db.exec(`DELETE FROM channel_pending_messages WHERE message_id = ${q(messageId)};`);
}

export function purgeExpiredChannelPendingMessages(channel = '', olderThanMs = 0): number {
    const db = getHarnessDb();
    const cutoff = now() - Math.max(0, olderThanMs);
    const channelFilter = channel ? `AND channel = ${q(channel)}` : '';
    const before = db.get<{ count: number }>(`
SELECT COUNT(*) as count
FROM channel_pending_messages
WHERE expires_at <= ${cutoff}
${channelFilter};
`);
    db.exec(`
DELETE FROM channel_pending_messages
WHERE expires_at <= ${cutoff}
${channelFilter};
`);
    return before?.count || 0;
}

export function incrementMetric(metricName: string, delta = 1, metadata?: Record<string, unknown>): number {
    const db = getHarnessDb();
    const current = db.get<{ metric_value: number }>(`SELECT metric_value FROM harness_metrics WHERE metric_name = ${q(metricName)} LIMIT 1;`);
    const nextValue = (current?.metric_value || 0) + delta;
    db.upsert(
        'harness_metrics',
        {
            metric_name: metricName,
            metric_value: nextValue,
            updated_at: now(),
        },
        ['metric_name'],
        ['metric_value', 'updated_at']
    );
    db.insert('harness_metric_events', {
        metric_name: metricName,
        delta,
        metadata_json: toJson(metadata || {}),
        created_at: now(),
    });
    return nextValue;
}

export interface MetricRow {
    metric_name: string;
    metric_value: number;
    updated_at: number;
}

export function listMetrics(): MetricRow[] {
    const db = getHarnessDb();
    return db.all<MetricRow>('SELECT * FROM harness_metrics ORDER BY metric_name ASC;');
}

export interface SkillRow {
    skill_id: string;
    name: string;
    status: 'draft' | 'active' | 'disabled';
    draft_path: string;
    created_at: number;
    updated_at: number;
}

export function upsertSkill(skillId: string, name: string, status: 'draft' | 'active' | 'disabled', draftPath: string): void {
    const db = getHarnessDb();
    const t = now();
    db.upsert(
        'skills',
        {
            skill_id: skillId,
            name,
            status,
            draft_path: draftPath,
            created_at: t,
            updated_at: t,
        },
        ['skill_id'],
        ['name', 'status', 'draft_path', 'updated_at']
    );
}

export function listSkills(): SkillRow[] {
    const db = getHarnessDb();
    return db.all<SkillRow>('SELECT * FROM skills ORDER BY updated_at DESC;');
}

export function addSkillVersion(skillId: string, version: number, contentPath: string, verifierSummary: string): void {
    const db = getHarnessDb();
    db.upsert(
        'skill_versions',
        {
            skill_id: skillId,
            version,
            content_path: contentPath,
            verifier_summary: verifierSummary,
            created_at: now(),
        },
        ['skill_id', 'version'],
        ['content_path', 'verifier_summary', 'created_at']
    );
}

export function listSkillVersions(skillId: string): Array<{ version: number; content_path: string; verifier_summary: string; created_at: number }> {
    const db = getHarnessDb();
    return db.all(`SELECT version, content_path, verifier_summary, created_at FROM skill_versions WHERE skill_id = ${q(skillId)} ORDER BY version DESC LIMIT 20;`);
}
