import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { HARNESS_DB_FILE, HARNESS_DIR, MEMORY_DIR } from '../lib/config';
import { log } from '../lib/logging';

const SQLITE_CANDIDATES = [
    process.env.TINYAGI_SQLITE_BIN,
    'sqlite3',
    '/opt/homebrew/bin/sqlite3',
    '/usr/local/bin/sqlite3',
    '/usr/bin/sqlite3',
].filter((v): v is string => !!v);

function ensureDir(p: string): void {
    if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
    }
}

function pickSqliteBinary(): string {
    for (const candidate of SQLITE_CANDIDATES) {
        const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
        if (probe.status === 0) {
            return candidate;
        }
    }
    throw new Error('sqlite3 binary not found. Install sqlite3 or set TINYAGI_SQLITE_BIN.');
}

function sqlValue(value: string | number | boolean | null | undefined): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? `${value}` : 'NULL';
    if (typeof value === 'boolean') return value ? '1' : '0';
    return `'${value.replace(/'/g, "''")}'`;
}

export type SqlPrimitive = string | number | boolean | null | undefined;

export class HarnessDB {
    readonly dbFile: string;
    readonly sqliteBin: string;

    constructor(dbFile = HARNESS_DB_FILE) {
        this.dbFile = dbFile;
        ensureDir(path.dirname(dbFile));
        ensureDir(HARNESS_DIR);
        ensureDir(path.join(MEMORY_DIR, 'raw'));
        ensureDir(path.join(MEMORY_DIR, 'daily'));
        ensureDir(path.join(MEMORY_DIR, 'entities'));
        this.sqliteBin = pickSqliteBinary();
        this.initSchema();
    }

    private runRaw(args: string[], sql?: string): string {
        const proc = spawnSync(this.sqliteBin, ['-cmd', '.timeout 5000', ...args], {
            encoding: 'utf8',
            input: sql,
        });

        if (proc.status !== 0) {
            const stderr = proc.stderr?.trim() || 'sqlite3 failed';
            throw new Error(stderr);
        }

        return proc.stdout || '';
    }

    exec(sql: string): void {
        this.runRaw([this.dbFile], sql);
    }

    all<T = Record<string, unknown>>(sql: string): T[] {
        const out = this.runRaw(['-json', this.dbFile, sql]);
        const trimmed = out.trim();
        if (!trimmed) return [];
        return JSON.parse(trimmed) as T[];
    }

    get<T = Record<string, unknown>>(sql: string): T | null {
        const rows = this.all<T>(sql);
        return rows[0] || null;
    }

    begin(): void {
        this.exec('BEGIN TRANSACTION;');
    }

    commit(): void {
        this.exec('COMMIT;');
    }

    rollback(): void {
        this.exec('ROLLBACK;');
    }

    insert(table: string, values: Record<string, SqlPrimitive>): void {
        const cols = Object.keys(values).join(', ');
        const vals = Object.values(values).map(sqlValue).join(', ');
        this.exec(`INSERT INTO ${table} (${cols}) VALUES (${vals});`);
    }

    update(table: string, values: Record<string, SqlPrimitive>, whereSql: string): void {
        const assignments = Object.entries(values)
            .map(([k, v]) => `${k} = ${sqlValue(v)}`)
            .join(', ');
        this.exec(`UPDATE ${table} SET ${assignments} WHERE ${whereSql};`);
    }

    upsert(table: string, values: Record<string, SqlPrimitive>, conflictCols: string[], updateCols: string[]): void {
        const cols = Object.keys(values);
        const insertCols = cols.join(', ');
        const insertVals = Object.values(values).map(sqlValue).join(', ');
        const conflict = conflictCols.join(', ');
        const updates = updateCols.map(c => `${c}=excluded.${c}`).join(', ');

        this.exec(
            `INSERT INTO ${table} (${insertCols}) VALUES (${insertVals}) ` +
            `ON CONFLICT(${conflict}) DO UPDATE SET ${updates};`
        );
    }

    private initSchema(): void {
        const schema = `
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_runs (
    run_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    sender TEXT NOT NULL,
    sender_id TEXT,
    conversation_id TEXT,
    branch_key TEXT,
    objective TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    status TEXT NOT NULL,
    assigned_agent TEXT,
    loop_iteration INTEGER NOT NULL DEFAULT 0,
    max_iterations INTEGER NOT NULL DEFAULT 1,
    verifier_outcome TEXT,
    result_text TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
CREATE INDEX IF NOT EXISTS idx_task_runs_created_at ON task_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS task_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    step_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_steps_run_id ON task_steps(run_id);

CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_events_run_id ON task_events(run_id);

CREATE TABLE IF NOT EXISTS memory_records (
    record_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    source_run_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_user_category ON memory_records(user_id, category);
CREATE INDEX IF NOT EXISTS idx_memory_user_key ON memory_records(user_id, key);

CREATE TABLE IF NOT EXISTS memory_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_record_id TEXT NOT NULL,
    to_record_id TEXT NOT NULL,
    link_type TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_summaries (
    summary_date TEXT PRIMARY KEY,
    summary_path TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
    permission_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    action TEXT NOT NULL,
    resource TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_permissions_user_subject ON permissions(user_id, subject, action);

CREATE TABLE IF NOT EXISTS tool_registry (
    tool_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT,
    trust_class TEXT NOT NULL,
    status TEXT NOT NULL,
    last_verified_at INTEGER,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
    skill_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    draft_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    content_path TEXT NOT NULL,
    verifier_summary TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(skill_id, version)
);

CREATE TABLE IF NOT EXISTS skill_verdicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    findings_json TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS browser_sessions (
    session_id TEXT PRIMARY KEY,
    profile_path TEXT,
    debugger_url TEXT,
    chrome_pid INTEGER,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS browser_actions (
    action_id TEXT PRIMARY KEY,
    run_id TEXT,
    session_id TEXT,
    url TEXT,
    action TEXT NOT NULL,
    selector TEXT,
    risk TEXT NOT NULL,
    status TEXT NOT NULL,
    requires_approval INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS browser_approvals (
    request_id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS browser_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_id TEXT NOT NULL,
    run_id TEXT,
    step TEXT NOT NULL,
    url TEXT,
    screenshot_before TEXT,
    screenshot_after TEXT,
    selector_trace TEXT,
    details_json TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS browser_tabs (
    tab_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    status TEXT NOT NULL,
    url TEXT,
    selector_trace_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_tabs_run ON browser_tabs(run_id);

CREATE TABLE IF NOT EXISTS channel_pending_messages (
    message_id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    sender TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    chat_ref TEXT,
    reply_ref TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_channel_expires ON channel_pending_messages(channel, expires_at);

CREATE TABLE IF NOT EXISTS harness_metrics (
    metric_name TEXT PRIMARY KEY,
    metric_value REAL NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS harness_metric_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_name TEXT NOT NULL,
    delta REAL NOT NULL,
    metadata_json TEXT,
    created_at INTEGER NOT NULL
);
`;

        this.exec(schema);
        this.applyMigrations();
    }

    private applyMigrations(): void {
        const current = this.get<{ version: number }>('SELECT MAX(version) as version FROM schema_migrations;');
        const version = typeof current?.version === 'number' ? current.version : 0;

        if (version < 1) {
            try {
                this.exec('ALTER TABLE task_runs ADD COLUMN verifier_outcome TEXT;');
            } catch (error) {
                const message = (error as Error).message || '';
                if (!/duplicate column name/i.test(message)) {
                    throw error;
                }
            }
            this.insert('schema_migrations', { version: 1, applied_at: Date.now() });
            log('INFO', 'Applied harness schema migration v1');
        }

        if (version < 2) {
            try {
                this.exec('ALTER TABLE task_runs ADD COLUMN conversation_id TEXT;');
            } catch (error) {
                const message = (error as Error).message || '';
                if (!/duplicate column name/i.test(message)) {
                    throw error;
                }
            }

            try {
                this.exec('ALTER TABLE task_runs ADD COLUMN branch_key TEXT;');
            } catch (error) {
                const message = (error as Error).message || '';
                if (!/duplicate column name/i.test(message)) {
                    throw error;
                }
            }

            this.exec(`
CREATE TABLE IF NOT EXISTS browser_tabs (
    tab_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    status TEXT NOT NULL,
    url TEXT,
    selector_trace_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_tabs_run ON browser_tabs(run_id);
`);
            this.exec('CREATE INDEX IF NOT EXISTS idx_task_runs_conversation ON task_runs(conversation_id, branch_key);');
            this.insert('schema_migrations', { version: 2, applied_at: Date.now() });
            log('INFO', 'Applied harness schema migration v2');
        }

        if (version < 3) {
            this.exec(`
CREATE TABLE IF NOT EXISTS channel_pending_messages (
    message_id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    sender TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    chat_ref TEXT,
    reply_ref TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_channel_expires ON channel_pending_messages(channel, expires_at);

CREATE TABLE IF NOT EXISTS harness_metrics (
    metric_name TEXT PRIMARY KEY,
    metric_value REAL NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS harness_metric_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_name TEXT NOT NULL,
    delta REAL NOT NULL,
    metadata_json TEXT,
    created_at INTEGER NOT NULL
);
`);
            this.insert('schema_migrations', { version: 3, applied_at: Date.now() });
            log('INFO', 'Applied harness schema migration v3');
        }
    }
}

let cachedDb: HarnessDB | null = null;

export function getHarnessDb(): HarnessDB {
    if (!cachedDb) {
        cachedDb = new HarnessDB();
    }
    return cachedDb;
}

export function toJson(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return '{}';
    }
}
