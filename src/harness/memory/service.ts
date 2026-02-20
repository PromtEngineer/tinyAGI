import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
    forgetMemory,
    listMemory,
    saveDailySummary,
    upsertMemoryRecord,
    MemoryInsertInput,
} from '../repository';
import { MEMORY_DIR } from '../../lib/config';

function toDateKey(ts: number): string {
    const d = new Date(ts);
    const y = d.getUTCFullYear();
    const m = `${d.getUTCMonth() + 1}`.padStart(2, '0');
    const dd = `${d.getUTCDate()}`.padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

function listRawFilesForDate(dateKey: string): string[] {
    const [year, month, day] = dateKey.split('-');
    const dir = path.join(MEMORY_DIR, 'raw', year, month, day);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => path.join(dir, f))
        .sort();
}

function parseJsonlLines(filePath: string): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = [];
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            rows.push(JSON.parse(trimmed));
        } catch {
            // Ignore malformed lines.
        }
    }
    return rows;
}

export function renderMemoryForUser(userId: string, topic = ''): string {
    const rows = listMemory(userId, topic);
    if (rows.length === 0) {
        return topic
            ? `No memory records found for topic "${topic}".`
            : 'No memory records found.';
    }

    const lines: string[] = [];
    lines.push(`Memory records (${rows.length}):`);

    for (const row of rows.slice(0, 50)) {
        lines.push(`- [${row.category}] ${row.key}: ${row.value} (confidence=${row.confidence.toFixed(2)})`);
    }

    return lines.join('\n');
}

export function forgetMemoryForUser(userId: string, topic: string): string {
    if (!topic.trim()) {
        return 'Please provide a topic to forget.';
    }

    const removed = forgetMemory(userId, topic);
    return removed > 0
        ? `Forgot ${removed} memory record(s) matching "${topic}".`
        : `No memory records matched "${topic}".`;
}

function tokenizeObjective(input: string): string[] {
    return input
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .map(token => token.trim())
        .filter(token => token.length >= 3)
        .slice(0, 24);
}

function deterministicMemoryId(userId: string, category: string, key: string): string {
    const hash = crypto.createHash('sha1').update(`${userId}:${category}:${key.toLowerCase()}`).digest('hex').slice(0, 16);
    return `mem_${hash}`;
}

export function retrieveMemoryContext(userId: string, objective: string, limit = 12): string {
    const rows = listMemory(userId, '');
    if (rows.length === 0) return '';

    const tokens = tokenizeObjective(objective);
    const scored = rows.map((row) => {
        const blob = `${row.key} ${row.value}`.toLowerCase();
        const tokenHits = tokens.filter(token => blob.includes(token)).length;
        const confidenceBoost = Math.max(0, Math.min(1, row.confidence));
        const recencyBoost = row.updated_at / 1e13;
        const score = (tokenHits * 2) + confidenceBoost + recencyBoost;
        return { row, score };
    });

    const relevant = scored
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Math.min(limit, 20)))
        .map(item => item.row);

    const lines = ['Known user memory context:'];
    for (const row of relevant) {
        lines.push(`- [${row.category}] ${row.key}: ${row.value} (confidence=${row.confidence.toFixed(2)})`);
    }
    return lines.join('\n');
}

function buildMemoryRowsFromText(text: string): MemoryInsertInput[] {
    const rows: MemoryInsertInput[] = [];
    const lower = text.toLowerCase();

    const preferenceMatch = text.match(/\b(i prefer|please always|my preference is|i usually)\b[:\s-]*(.+)$/i);
    if (preferenceMatch) {
        rows.push({
            recordId: '',
            userId: '',
            category: 'preferences',
            key: 'preference',
            value: preferenceMatch[2].trim(),
            confidence: /\b(always|must)\b/i.test(preferenceMatch[2]) ? 0.95 : 0.85,
        });
    }

    const workflowMatch = text.match(/\b(this is my workflow|how i do this|process is)\b[:\s-]*(.+)$/i);
    if (workflowMatch) {
        rows.push({
            recordId: '',
            userId: '',
            category: 'workflows',
            key: 'workflow',
            value: workflowMatch[2].trim(),
            confidence: 0.82,
        });
    }

    const projectMatch = text.match(/\b(project|working on|build)\b[:\s-]*(.+)$/i);
    if (projectMatch && /\bproject\b/.test(lower)) {
        rows.push({
            recordId: '',
            userId: '',
            category: 'projects',
            key: 'active_project',
            value: projectMatch[2].trim(),
            confidence: 0.7,
        });
    }

    const taskStateMatch = text.match(/\b(remember that|remind me|i need to)\b[:\s-]*(.+)$/i);
    if (taskStateMatch) {
        rows.push({
            recordId: '',
            userId: '',
            category: 'task_states',
            key: 'task_state',
            value: taskStateMatch[2].trim(),
            confidence: 0.72,
        });
    }

    const correctionMatch = text.match(/\bactually\b[,:\s-]*(.+)$/i);
    if (correctionMatch) {
        rows.push({
            recordId: '',
            userId: '',
            category: 'confirmed_facts',
            key: 'explicit_correction',
            value: correctionMatch[1].trim(),
            confidence: 0.9,
        });
    }

    return rows;
}

export function ingestMemorySignals(userId: string, runId: string, objective: string, responseText: string): number {
    const fromObjective = buildMemoryRowsFromText(objective);
    const fromResponse = buildMemoryRowsFromText(responseText);
    const rawRows = [...fromObjective, ...fromResponse];

    if (rawRows.length === 0) return 0;

    const dedup = new Map<string, MemoryInsertInput>();
    for (const row of rawRows) {
        const key = `${row.category}:${row.key}:${row.value.toLowerCase()}`;
        const existing = dedup.get(key);
        if (!existing || row.confidence > existing.confidence) {
            dedup.set(key, row);
        }
    }

    for (const row of dedup.values()) {
        const stableId = deterministicMemoryId(userId, row.category, row.key);
        upsertMemoryRecord({
            recordId: stableId,
            userId,
            category: row.category,
            key: row.key,
            value: row.value,
            confidence: row.confidence,
            sourceRunId: runId,
        });
    }

    return dedup.size;
}

function summarizeRows(rows: Record<string, unknown>[]): string {
    const grouped: Record<string, number> = {};
    for (const row of rows) {
        const channel = (row.channel as string) || 'unknown';
        grouped[channel] = (grouped[channel] || 0) + 1;
    }

    const keys = Object.keys(grouped).sort();
    const lines = keys.map(k => `- ${k}: ${grouped[k]} event(s)`);
    return lines.length > 0 ? lines.join('\n') : '- No channel events';
}

export function buildDailySummary(dateKey = toDateKey(Date.now())): { date: string; path: string; summary: string } {
    const files = listRawFilesForDate(dateKey);
    const rows = files.flatMap(parseJsonlLines);

    const header = `# tinyAGI Daily Memory Summary (${dateKey})`;
    const counts = summarizeRows(rows);

    const notableRequests = rows
        .map(r => ({ request: (r.request as string) || '', ts: (r.timestamp as number) || 0 }))
        .filter(r => r.request)
        .sort((a, b) => a.ts - b.ts)
        .slice(-20);

    const requestLines = notableRequests.length > 0
        ? notableRequests.map(r => `- ${r.request}`).join('\n')
        : '- No requests captured';

    const summary = [
        header,
        '',
        '## Event Volume',
        counts,
        '',
        '## Notable Requests',
        requestLines,
        '',
        '## Notes',
        '- Conflicts should be resolved by recency and explicit user corrections.',
    ].join('\n');

    const summaryPath = saveDailySummary(dateKey, summary);
    return {
        date: dateKey,
        path: summaryPath,
        summary,
    };
}
