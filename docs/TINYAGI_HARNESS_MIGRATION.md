# tinyAGI Harness Migration

This document describes the implemented migration from legacy tinyclaw runtime patterns to tinyAGI harness runtime patterns.

## What Was Implemented

- Rebrand command surface to `tinyagi` with compatibility alias `tinyclaw`.
- New canonical state home: `~/.tinyagi`.
- Legacy compatibility: `~/.tinyclaw` fallback and symlink path compatibility.
- Harness runtime inserted into queue processing behind `settings.harness.enabled`.
- SQLite-backed harness state for tasks, memory, permissions, tools, skills, and browser session/audit data.
- Generator-verifier-revisor loop with risk-based iteration budgets.
- Publish gates for payment actions and tool execution approvals.
- WhatsApp operator commands for status, approvals, permissions, memory, and autonomy mode.
- Browser session manager for logged-in Chrome profile attach with profile lock detection.
- Browser DOM action executor with tab ownership, selector trace capture, before/after screenshots, retries, and CAPTCHA/session checkpoints.
- Proactive scheduler tick in queue runtime for daily digest delivery, blocked-run outreach, and deferred outbox flush after quiet hours.
- Harness routing expanded to team/internal branches with per-branch run IDs for verifier-gated team collaboration.

## New Runtime Modules

- `src/harness/db.ts`
- `src/harness/repository.ts`
- `src/harness/runtime/orchestrator.ts`
- `src/harness/runtime/loop-engine.ts`
- `src/harness/runtime/risk-classifier.ts`
- `src/harness/runtime/publish-gate.ts`
- `src/harness/runtime/task-router.ts`
- `src/harness/runtime/proactive-notifier.ts`
- `src/harness/memory/service.ts`
- `src/harness/browser/runtime.ts`
- `src/harness/browser/executor.ts`
- `src/harness/tools/service.ts`
- `src/harness/skills/service.ts`
- `src/harness/cli.ts`

## CLI Surface

Harness/runtime:

- `tinyagi harness status|enable|disable|autonomy <low|normal|strict>`
- `tinyagi task list|show <run_id>`
- `tinyagi memory show [user_id] [topic]`
- `tinyagi memory forget <user_id> <topic>`
- `tinyagi memory summarize [YYYY-MM-DD]`
- `tinyagi browser sessions|attach|approve <request_id>|deny <request_id>|approvals [user_id]`
- `tinyagi permission list [user_id]|grant <user_id> <subject> <action> [resource]|revoke <permission_id>`
- `tinyagi tools list|register <name> <source>|approve <name> [user_id]|block <name> [user_id]`
- `tinyagi skills list|show <skill_id>|draft <name> <prompt>|activate <skill_id>|disable <skill_id>|rollback <skill_id> [version]`

Compatibility:

- `tinyclaw ...` still works and delegates to tinyAGI runtime paths.

## WhatsApp Commands

- `/status`
- `/approve <request_id>`
- `/deny <request_id>`
- `/permissions`
- `/memory <topic>`
- `/autonomy low|normal|strict`

## Browser Policy (Implemented)

- Browser runtime uses existing Chrome profile path from harness settings when set, else local default profile path.
- Browser provider modes:
  - `auto` (default): use CDP attach first, then fallback to Chrome DevTools MCP when CDP is unavailable due active profile/session lock.
  - `cdp`: strict CDP-only attach (`playwright-core` `connectOverCDP`).
  - `chrome-devtools-mcp`: strict Chrome DevTools MCP execution path (no CDP attach attempt).
- Profile lock detection uses `SingletonLock`/`SingletonCookie`/`SingletonSocket` and prevents relaunch when Chrome is already running.
- Existing debugger discovery checks configured endpoint/ports plus known/default ports before attempting any launch.
- Config keys: `harness.browser.debugger_url` and `harness.browser.debugger_ports` (also env: `TINYAGI_BROWSER_DEBUGGER_URL`, `TINYAGI_BROWSER_DEBUGGER_PORTS`).
- MCP channel config key: `harness.browser.mcp_channel` (`stable|canary|beta|dev`, default `stable`).
- Payment-related browser actions require explicit approval.
- Browser actions and session startup create audit rows in SQLite.

## Database Location

- `~/.tinyagi/harness/state.db`

Schema groups include:

- `task_runs`, `task_steps`, `task_events`
- `memory_records`, `memory_links`, `memory_summaries`
- `permissions`, `tool_registry`, `tool_events`
- `skills`, `skill_versions`, `skill_verdicts`
- `browser_sessions`, `browser_actions`, `browser_approvals`, `browser_audits`

## Notes

- Harness routing now covers non-team and team/internal message branches when harness mode is enabled.
- Legacy queue and channel behavior remains available when harness mode is disabled.
