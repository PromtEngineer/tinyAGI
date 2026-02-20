import fs from 'fs';
import path from 'path';
import { HARNESS_DIR, QUEUE_OUTGOING, getHarnessSettings } from '../../lib/config';
import {
    appendTaskEvent,
    getTaskEventCount,
    getLastTaskEventAt,
    incrementMetric,
    listBlockedRunsForOutreach,
    listDigestTargets,
} from '../repository';
import { buildDailySummary } from '../memory/service';

interface DeferredMessage {
    channel: string;
    sender: string;
    senderId: string;
    text: string;
    files?: string[];
    createdAt: number;
    urgent: boolean;
}

interface ProactiveState {
    digestSent: Record<string, string>;
    lastTickAt: number;
}

const DEFERRED_FILE = path.join(HARNESS_DIR, 'proactive-deferred.jsonl');
const STATE_FILE = path.join(HARNESS_DIR, 'proactive-state.json');
const BLOCKED_OUTREACH_MIN_AGE_MS = 10 * 60 * 1000;
const BLOCKED_OUTREACH_MIN_INTERVAL_MS = 4 * 60 * 60 * 1000;
const BLOCKED_OUTREACH_MAX_ATTEMPTS = 3;
const BLOCKED_OUTREACH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function parseClock(clock: string): number {
    const [hh, mm] = clock.split(':').map(v => Number(v));
    return (Number.isFinite(hh) ? hh : 0) * 60 + (Number.isFinite(mm) ? mm : 0);
}

function nowLocalMinutes(): number {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
}

function currentClock(): string {
    const d = new Date();
    const hh = `${d.getHours()}`.padStart(2, '0');
    const mm = `${d.getMinutes()}`.padStart(2, '0');
    return `${hh}:${mm}`;
}

function currentDateKey(): string {
    const d = new Date();
    const y = d.getFullYear();
    const m = `${d.getMonth() + 1}`.padStart(2, '0');
    const dd = `${d.getDate()}`.padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

function loadState(): ProactiveState {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            return { digestSent: {}, lastTickAt: 0 };
        }
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<ProactiveState>;
        return {
            digestSent: raw.digestSent || {},
            lastTickAt: raw.lastTickAt || 0,
        };
    } catch {
        return { digestSent: {}, lastTickAt: 0 };
    }
}

function saveState(state: ProactiveState): void {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function enqueueOutgoing(input: {
    channel: string;
    sender: string;
    senderId: string;
    text: string;
    files?: string[];
}): string {
    const response = {
        channel: input.channel,
        sender: input.sender,
        senderId: input.senderId,
        message: input.text,
        originalMessage: '[proactive]',
        timestamp: Date.now(),
        messageId: `proactive_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        files: input.files && input.files.length > 0 ? input.files : undefined,
    };

    fs.mkdirSync(QUEUE_OUTGOING, { recursive: true });
    const file = path.join(QUEUE_OUTGOING, `${input.channel}_${response.messageId}.json`);
    fs.writeFileSync(file, JSON.stringify(response, null, 2));
    return file;
}

function appendDeferredMessage(message: DeferredMessage): void {
    fs.mkdirSync(path.dirname(DEFERRED_FILE), { recursive: true });
    fs.writeFileSync(DEFERRED_FILE, `${JSON.stringify(message)}\n`, { flag: 'a' });
}

function readDeferredMessages(): DeferredMessage[] {
    if (!fs.existsSync(DEFERRED_FILE)) return [];
    const rows: DeferredMessage[] = [];
    const content = fs.readFileSync(DEFERRED_FILE, 'utf8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const parsed = JSON.parse(trimmed) as DeferredMessage;
            rows.push(parsed);
        } catch {
            // Ignore malformed line.
        }
    }
    return rows;
}

function truncate(text: string, max: number): string {
    const trimmed = text.trim();
    if (trimmed.length <= max) return trimmed;
    return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function buildBlockedOutreachText(run: {
    run_id: string;
    status: string;
    objective: string;
    result_text: string;
}): string {
    if (run.status === 'awaiting_approval') {
        const detail = truncate(run.result_text || '', 320);
        if (detail) {
            return [
                'This task is waiting for your approval.',
                detail,
                '',
                'Reply with /approve <request_id> or /deny <request_id>.',
            ].join('\n');
        }
        return 'A task is waiting for approval. Reply with /approve <request_id> or /deny <request_id>.';
    }

    const detail = truncate(run.result_text || '', 360);
    if (detail) {
        return [
            'This task is still blocked and needs your input:',
            detail,
            '',
            'Reply with /agent <details> when ready and I will continue.',
        ].join('\n');
    }

    return [
        `Task blocked: ${truncate(run.objective || '', 180)}`,
        '',
        'Reply with /agent <details> when ready and I will continue.',
    ].join('\n');
}

export function isQuietHours(): boolean {
    const settings = getHarnessSettings();
    const start = parseClock(settings.quiet_hours.start);
    const end = parseClock(settings.quiet_hours.end);
    const current = nowLocalMinutes();

    if (start === end) return false;
    if (start < end) return current >= start && current < end;
    return current >= start || current < end;
}

export function queueProactiveMessage(input: {
    channel: string;
    sender: string;
    senderId: string;
    text: string;
    files?: string[];
    urgent?: boolean;
}): string {
    const urgent = !!input.urgent;
    if (!urgent && isQuietHours()) {
        appendDeferredMessage({
            channel: input.channel,
            sender: input.sender,
            senderId: input.senderId,
            text: input.text,
            files: input.files,
            createdAt: Date.now(),
            urgent,
        });
        return 'deferred_quiet_hours';
    }

    return enqueueOutgoing({
        channel: input.channel,
        sender: input.sender,
        senderId: input.senderId,
        text: input.text,
        files: input.files,
    });
}

export function flushDeferredProactiveQueue(): number {
    if (isQuietHours()) return 0;

    const deferred = readDeferredMessages();
    if (deferred.length === 0) return 0;

    let sent = 0;
    for (const message of deferred) {
        enqueueOutgoing({
            channel: message.channel,
            sender: message.sender,
            senderId: message.senderId,
            text: message.text,
            files: message.files,
        });
        sent += 1;
    }

    fs.unlinkSync(DEFERRED_FILE);
    return sent;
}

function queueDailyDigestIfDue(state: ProactiveState): { sent: number; deferred: number } {
    const settings = getHarnessSettings();
    if (currentClock() !== settings.digest_time) {
        return { sent: 0, deferred: 0 };
    }

    const targets = listDigestTargets(250);
    if (targets.length === 0) {
        return { sent: 0, deferred: 0 };
    }

    const summary = buildDailySummary(currentDateKey());
    let sent = 0;
    let deferred = 0;

    for (const target of targets) {
        const stateKey = `${target.channel}:${target.sender_id}`;
        if (state.digestSent[stateKey] === summary.date) {
            continue;
        }

        const text = [
            `Daily digest (${summary.date})`,
            '',
            summary.summary,
        ].join('\n');

        const result = queueProactiveMessage({
            channel: target.channel,
            sender: target.sender,
            senderId: target.sender_id,
            text,
            urgent: false,
        });

        state.digestSent[stateKey] = summary.date;
        if (result === 'deferred_quiet_hours') deferred += 1;
        else sent += 1;
    }

    return { sent, deferred };
}

function queueBlockedRunOutreach(): { sent: number; deferred: number } {
    const blocked = listBlockedRunsForOutreach(BLOCKED_OUTREACH_MIN_AGE_MS, 200);
    let sent = 0;
    let deferred = 0;

    for (const run of blocked) {
        const ageMs = Date.now() - run.updated_at;
        if (ageMs > BLOCKED_OUTREACH_MAX_AGE_MS) {
            continue;
        }

        const outreachCount = getTaskEventCount(run.run_id, 'proactive_outreach');
        if (outreachCount >= BLOCKED_OUTREACH_MAX_ATTEMPTS) {
            continue;
        }

        const lastOutreach = getLastTaskEventAt(run.run_id, 'proactive_outreach');
        if (lastOutreach > 0 && Date.now() - lastOutreach < BLOCKED_OUTREACH_MIN_INTERVAL_MS) {
            continue;
        }

        const text = buildBlockedOutreachText(run);

        const result = queueProactiveMessage({
            channel: run.channel,
            sender: run.sender,
            senderId: run.sender_id,
            text,
            urgent: run.status === 'awaiting_approval',
        });

        appendTaskEvent(run.run_id, 'proactive_outreach', {
            result,
            status: run.status,
            attempt: outreachCount + 1,
        });

        if (result === 'deferred_quiet_hours') deferred += 1;
        else sent += 1;
    }

    return { sent, deferred };
}

export function runProactiveSchedulerTick(): { sent: number; deferred: number; flushed: number } {
    const state = loadState();
    const flushed = flushDeferredProactiveQueue();
    const digests = queueDailyDigestIfDue(state);
    const blocked = queueBlockedRunOutreach();

    state.lastTickAt = Date.now();
    saveState(state);

    if (digests.sent > 0) incrementMetric('proactive_digest_sent_count', digests.sent);
    if (digests.deferred > 0) incrementMetric('proactive_digest_deferred_count', digests.deferred);
    if (blocked.sent > 0) incrementMetric('proactive_blocked_sent_count', blocked.sent);
    if (blocked.deferred > 0) incrementMetric('proactive_blocked_deferred_count', blocked.deferred);
    if (flushed > 0) incrementMetric('proactive_deferred_flushed_count', flushed);

    return {
        sent: digests.sent + blocked.sent,
        deferred: digests.deferred + blocked.deferred,
        flushed,
    };
}

export function maybeQueueDailyDigest(channel: string, sender: string, senderId: string): string {
    const settings = getHarnessSettings();
    if (currentClock() !== settings.digest_time) {
        return 'not_digest_window';
    }

    const summary = buildDailySummary(currentDateKey());
    return queueProactiveMessage({
        channel,
        sender,
        senderId,
        text: [`Daily digest (${summary.date})`, '', summary.summary].join('\n'),
        urgent: false,
    });
}
