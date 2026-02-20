#!/usr/bin/env node
import os from 'os';
import crypto from 'crypto';
import { getHarnessSettings, getSettings, saveSettings, setHarnessEnabled } from '../lib/config';
import {
    getTaskRun,
    listTaskEvents,
    listTaskRuns,
    listTaskSteps,
    listBrowserTabs,
    listMetrics,
    listPermissions,
    upsertPermission,
    resolveBrowserApproval,
    listBrowserApprovals,
} from './repository';
import { renderMemoryForUser, forgetMemoryForUser, buildDailySummary } from './memory/service';
import { ensureBrowserSession, renderBrowserSessions } from './browser/runtime';
import { replayBrowserRun } from './browser/executor';
import { approveTool, blockTool, registerTool, renderPermissions, renderTools } from './tools/service';
import {
    activateSkill,
    createSkillDraft,
    disableSkill,
    renderSkill,
    renderSkills,
    rollbackSkill,
} from './skills/service';

function usage(): string {
    return [
        'tinyagi harness status|enable|disable',
        'tinyagi task list|show <run_id>',
        'tinyagi memory show [user_id] [topic]|forget <user_id> <topic>|summarize [YYYY-MM-DD]',
        'tinyagi browser sessions|tabs [run_id]|attach|approve <request_id>|deny <request_id>|approvals [user_id]',
        'tinyagi browser replay <run_id> [user_id]',
        'tinyagi permission list [user_id]|grant <user_id> <subject> <action> [resource]|revoke <permission_id>',
        'tinyagi tools list|register <name> <source>|approve <name> [user_id]|block <name> [user_id]',
        'tinyagi skills list|show <skill_id>|draft <name> <prompt>|activate <skill_id>|disable <skill_id>|rollback <skill_id> [version]',
        'tinyagi metrics',
    ].join('\n');
}

function defaultUser(): string {
    return os.userInfo().username || 'local-user';
}

function printTask(runId: string): string {
    const run = getTaskRun(runId);
    if (!run) return `Run not found: ${runId}`;

    const steps = listTaskSteps(runId);
    const events = listTaskEvents(runId);

    const lines = [
        `Run: ${run.run_id}`,
        `Status: ${run.status}`,
        `Risk: ${run.risk_level}`,
        `Agent: ${run.assigned_agent || 'n/a'}`,
        `Objective: ${run.objective}`,
        `Verifier outcome: ${run.verifier_outcome || 'n/a'}`,
        '',
        `Steps (${steps.length}):`,
    ];

    for (const step of steps) {
        lines.push(`- [${step.id}] ${step.step_type}`);
    }

    lines.push('');
    lines.push(`Events (${events.length}):`);
    for (const event of events) {
        lines.push(`- [${event.id}] ${event.event_type}`);
    }

    if (run.result_text) {
        lines.push('');
        lines.push('Result:');
        lines.push(run.result_text);
    }

    return lines.join('\n');
}

async function main(): Promise<void> {
    const [group, action, ...rest] = process.argv.slice(2);

    if (!group) {
        console.log(usage());
        process.exit(1);
    }

    switch (group) {
        case 'harness': {
            if (action === 'status' || !action) {
                const settings = getHarnessSettings();
                console.log([
                    `enabled=${settings.enabled}`,
                    `autonomy=${settings.autonomy}`,
                    `quiet_hours=${settings.quiet_hours.start}-${settings.quiet_hours.end}`,
                    `digest_time=${settings.digest_time}`,
                    `browser.enabled=${settings.browser.enabled}`,
                    `browser.profile_path=${settings.browser.profile_path || '(default)'}`,
                    `browser.profile_directory=${settings.browser.profile_directory || '(auto-last-used)'}`,
                    `browser.open_domain_access=${settings.browser.open_domain_access}`,
                    `browser.hard_stop_payments=${settings.browser.hard_stop_payments}`,
                    `browser.use_claude_chrome=${settings.browser.use_claude_chrome}`,
                ].join('\n'));
                return;
            }

            if (action === 'enable') {
                setHarnessEnabled(true);
                console.log('Harness enabled.');
                return;
            }

            if (action === 'disable') {
                setHarnessEnabled(false);
                console.log('Harness disabled.');
                return;
            }

            if (action === 'autonomy') {
                const mode = rest[0] as 'low' | 'normal' | 'strict' | undefined;
                if (!mode || !['low', 'normal', 'strict'].includes(mode)) {
                    console.log('Usage: tinyagi harness autonomy <low|normal|strict>');
                    process.exit(1);
                }

                const settings = getSettings();
                if (!settings.harness) settings.harness = {};
                settings.harness.autonomy = mode;
                saveSettings(settings);
                console.log(`Harness autonomy set to ${mode}.`);
                return;
            }

            console.log('Usage: tinyagi harness status|enable|disable|autonomy <low|normal|strict>');
            process.exit(1);
        }

        case 'task': {
            if (action === 'list' || !action) {
                const rows = listTaskRuns(50);
                if (rows.length === 0) {
                    console.log('No task runs found.');
                    return;
                }

                console.log('Recent task runs:');
                for (const row of rows) {
                    console.log(`- ${row.run_id} status=${row.status} risk=${row.risk_level} agent=${row.assigned_agent || 'n/a'} objective=${row.objective.slice(0, 80)}`);
                }
                return;
            }

            if (action === 'show') {
                const runId = rest[0];
                if (!runId) {
                    console.log('Usage: tinyagi task show <run_id>');
                    process.exit(1);
                }
                console.log(printTask(runId));
                return;
            }

            console.log('Usage: tinyagi task list|show <run_id>');
            process.exit(1);
        }

        case 'memory': {
            if (action === 'show' || !action) {
                const userId = rest[0] || defaultUser();
                const topic = rest.slice(1).join(' ');
                console.log(renderMemoryForUser(userId, topic));
                return;
            }

            if (action === 'forget') {
                const userId = rest[0];
                const topic = rest.slice(1).join(' ');
                if (!userId || !topic) {
                    console.log('Usage: tinyagi memory forget <user_id> <topic>');
                    process.exit(1);
                }
                console.log(forgetMemoryForUser(userId, topic));
                return;
            }

            if (action === 'summarize') {
                const date = rest[0];
                const summary = buildDailySummary(date);
                console.log(`Summary written to ${summary.path}`);
                return;
            }

            console.log('Usage: tinyagi memory show [user_id] [topic]|forget <user_id> <topic>|summarize [YYYY-MM-DD]');
            process.exit(1);
        }

        case 'browser': {
            if (action === 'sessions' || !action) {
                console.log(renderBrowserSessions());
                return;
            }

            if (action === 'tabs') {
                const runId = rest[0] || '';
                const rows = listBrowserTabs(runId);
                if (rows.length === 0) {
                    console.log(runId ? `No browser tabs for run ${runId}.` : 'No browser tabs found.');
                    return;
                }
                console.log('Browser tabs:');
                for (const row of rows) {
                    console.log(`- ${row.tab_id} run=${row.run_id} owner=${row.owner} status=${row.status} url=${row.url || 'n/a'}`);
                }
                return;
            }

            if (action === 'attach') {
                const session = await ensureBrowserSession();
                console.log(session.message);
                if (session.ok) {
                    console.log(`session=${session.sessionId}`);
                    console.log(`debugger=${session.debuggerUrl}`);
                }
                return;
            }

            if (action === 'approve' || action === 'deny') {
                const requestId = rest[0];
                if (!requestId) {
                    console.log(`Usage: tinyagi browser ${action} <request_id>`);
                    process.exit(1);
                }
                const ok = resolveBrowserApproval(requestId, action === 'approve', `via_cli:${defaultUser()}`);
                console.log(ok ? `Request ${requestId} ${action}d.` : `Request not found: ${requestId}`);
                return;
            }

            if (action === 'replay') {
                const runId = rest[0];
                const userId = rest[1] || defaultUser();
                if (!runId) {
                    console.log('Usage: tinyagi browser replay <run_id> [user_id]');
                    process.exit(1);
                }
                const result = await replayBrowserRun({ runId, userId });
                console.log(result.message);
                if (result.artifacts && result.artifacts.length > 0) {
                    console.log('Artifacts:');
                    for (const artifact of result.artifacts) {
                        console.log(`- ${artifact}`);
                    }
                }
                return;
            }

            if (action === 'approvals') {
                const userId = rest[0] || '';
                const rows = listBrowserApprovals(userId);
                if (rows.length === 0) {
                    console.log(userId ? `No browser approvals for ${userId}.` : 'No browser approvals.');
                    return;
                }
                console.log('Browser approvals:');
                for (const row of rows) {
                    console.log(`- ${row.request_id} action=${row.action_id} user=${row.user_id} status=${row.status} reason=${row.reason || 'n/a'}`);
                }
                return;
            }

            console.log('Usage: tinyagi browser sessions|tabs [run_id]|attach|approve <request_id>|deny <request_id>|approvals [user_id]|replay <run_id> [user_id]');
            process.exit(1);
        }

        case 'permission': {
            if (action === 'list' || !action) {
                console.log(renderPermissions(rest[0] || ''));
                return;
            }

            if (action === 'grant') {
                const [userId, subject, subjectAction, resource = 'manual'] = rest;
                if (!userId || !subject || !subjectAction) {
                    console.log('Usage: tinyagi permission grant <user_id> <subject> <action> [resource]');
                    process.exit(1);
                }
                upsertPermission(`perm_${crypto.randomUUID()}`, userId, subject, subjectAction, resource, 'active');
                console.log(`Granted permission: ${userId} ${subject}:${subjectAction}`);
                return;
            }

            if (action === 'revoke') {
                const permissionId = rest[0];
                if (!permissionId) {
                    console.log('Usage: tinyagi permission revoke <permission_id>');
                    process.exit(1);
                }
                const permissions = listPermissions();
                const target = permissions.find(p => p.permission_id === permissionId);
                if (!target) {
                    console.log(`Permission not found: ${permissionId}`);
                    process.exit(1);
                }
                upsertPermission(permissionId, target.user_id, target.subject, target.action, target.resource || 'manual', 'revoked');
                console.log(`Revoked permission: ${permissionId}`);
                return;
            }

            console.log('Usage: tinyagi permission list [user_id]|grant <user_id> <subject> <action> [resource]|revoke <permission_id>');
            process.exit(1);
        }

        case 'tools': {
            if (action === 'list' || !action) {
                console.log(renderTools());
                return;
            }

            if (action === 'register') {
                const [name, source] = rest;
                if (!name || !source) {
                    console.log('Usage: tinyagi tools register <name> <source>');
                    process.exit(1);
                }
                const id = registerTool(name, source);
                console.log(`Registered tool ${name} as ${id}.`);
                return;
            }

            if (action === 'approve') {
                const [name, userId = defaultUser()] = rest;
                if (!name) {
                    console.log('Usage: tinyagi tools approve <name> [user_id]');
                    process.exit(1);
                }
                console.log(approveTool(name, userId));
                return;
            }

            if (action === 'block') {
                const [name, userId = defaultUser()] = rest;
                if (!name) {
                    console.log('Usage: tinyagi tools block <name> [user_id]');
                    process.exit(1);
                }
                console.log(blockTool(name, userId));
                return;
            }

            console.log('Usage: tinyagi tools list|register <name> <source>|approve <name> [user_id]|block <name> [user_id]');
            process.exit(1);
        }

        case 'skills': {
            if (action === 'list' || !action) {
                console.log(renderSkills());
                return;
            }

            if (action === 'show') {
                const skillId = rest[0];
                if (!skillId) {
                    console.log('Usage: tinyagi skills show <skill_id>');
                    process.exit(1);
                }
                console.log(renderSkill(skillId));
                return;
            }

            if (action === 'draft') {
                const [name, ...promptParts] = rest;
                const prompt = promptParts.join(' ');
                if (!name || !prompt) {
                    console.log('Usage: tinyagi skills draft <name> <prompt>');
                    process.exit(1);
                }
                const draft = createSkillDraft(name, prompt);
                console.log(`Skill draft created: ${draft.skillId} -> ${draft.path}`);
                return;
            }

            if (action === 'activate') {
                const skillId = rest[0];
                if (!skillId) {
                    console.log('Usage: tinyagi skills activate <skill_id>');
                    process.exit(1);
                }
                console.log(activateSkill(skillId));
                return;
            }

            if (action === 'disable') {
                const skillId = rest[0];
                if (!skillId) {
                    console.log('Usage: tinyagi skills disable <skill_id>');
                    process.exit(1);
                }
                console.log(disableSkill(skillId));
                return;
            }

            if (action === 'rollback') {
                const skillId = rest[0];
                const version = rest[1] ? Number(rest[1]) : undefined;
                if (!skillId) {
                    console.log('Usage: tinyagi skills rollback <skill_id> [version]');
                    process.exit(1);
                }
                console.log(rollbackSkill(skillId, Number.isFinite(version) ? version : undefined));
                return;
            }

            console.log('Usage: tinyagi skills list|show <skill_id>|draft <name> <prompt>|activate <skill_id>|disable <skill_id>|rollback <skill_id> [version]');
            process.exit(1);
        }

        case 'metrics': {
            const rows = listMetrics();
            if (rows.length === 0) {
                console.log('No metrics recorded yet.');
                return;
            }
            console.log('Harness metrics:');
            for (const row of rows) {
                console.log(`- ${row.metric_name}=${row.metric_value} updated_at=${new Date(row.updated_at).toISOString()}`);
            }
            const delivered = rows.find(r => r.metric_name === 'channel_response_delivered_count')?.metric_value || 0;
            const dropped = rows.find(r => r.metric_name === 'channel_response_dropped_count')?.metric_value || 0;
            const attempted = delivered + dropped;
            if (attempted > 0) {
                const rate = (dropped / attempted) * 100;
                console.log(`response_loss_rate=${rate.toFixed(2)}% (${dropped}/${attempted})`);
            }
            return;
        }

        default:
            console.log(usage());
            process.exit(1);
    }
}

main().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
});
