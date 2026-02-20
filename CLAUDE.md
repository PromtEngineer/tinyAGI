# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

tinyAGI is a harness-driven personal assistant that orchestrates multiple isolated AI agents across Discord, WhatsApp, and Telegram. It combines bash scripts for CLI/daemon management with TypeScript for core message processing, agent invocation, and a generator-verifier-reviser quality loop (the "harness").

Legacy name: TinyClaw. The codebase is mid-migration from `.tinyclaw` to `.tinyagi` with backward-compat symlinks.

## Build & Run Commands

```bash
npm run build              # Full build: tsc + visualizer
npm run build:main         # TypeScript only (src/ → dist/)
npm run build:visualizer   # Visualizer TUI only

# Individual channel/processor runs (require build first)
npm run queue              # Queue processor
npm run discord            # Discord client
npm run telegram           # Telegram client
npm run whatsapp           # WhatsApp client
npm run visualize          # Team visualizer TUI
```

There are no tests or linter configured in this project.

The daemon (started via `tinyagi start`) handles building automatically — it checks timestamps and runs `npm run build` if source is newer than `dist/`.

## Architecture

### Two-Layer Design

**Shell layer** (`lib/*.sh`, `tinyclaw.sh`): CLI commands, daemon lifecycle (tmux sessions), setup wizard, agent/team management, pairing, updates. Entry point is `tinyagi.sh` → `tinyclaw.sh` which sources `lib/` modules and dispatches commands.

**TypeScript layer** (`src/` → `dist/`): Message processing, channel clients, agent invocation, harness system. Compiled to CommonJS (ES2020 target) in `dist/`. The visualizer uses a separate tsconfig (`tsconfig.visualizer.json`) with ESM output.

### Message Flow (File-Based Queue)

```
Channel client → ~/.tinyagi/queue/incoming/ → queue-processor → ~/.tinyagi/queue/outgoing/ → channel client
```

- Messages are JSON files moved atomically: `incoming/` → `processing/` → `outgoing/`
- `queuedFiles` Set prevents duplicate processing; orphaned files in `processing/` are recovered on restart
- Multi-agent routing: `@agent_id` prefix routes to specific agent, unrouted goes to default
- Team conversations: agent responses containing `[@teammate: message]` tags are parsed and re-enqueued as new incoming messages; conversations complete when all branches resolve

### Key TypeScript Modules

- `src/queue-processor.ts` — Main loop: polls incoming queue, routes to agents, manages per-agent sequential promise chains (parallel across agents)
- `src/channels/{discord,telegram,whatsapp}-client.ts` — Channel adapters that write to incoming queue and poll outgoing queue
- `src/lib/invoke.ts` — Spawns Claude Code CLI or Codex CLI as subprocess per invocation
- `src/lib/routing.ts` — `@agent` routing, `[@teammate: msg]` extraction, team lookup
- `src/lib/config.ts` — Resolves state home, loads `settings.json`, exports all path constants
- `src/lib/state-home.ts` — Detects `.tinyagi` or legacy `.tinyclaw` directory, handles migration

### Harness System (`src/harness/`)

Generator-verifier-reviser loop inspired by DeepMind Aletheia:

- `runtime/orchestrator.ts` — Creates TaskRun, classifies risk, runs loop, applies publish gate
- `runtime/loop-engine.ts` — Generate → Verify → Revise cycle; budget scales with risk level (low=1, medium=3, high/critical=5 iterations)
- `runtime/risk-classifier.ts` — Classifies message intent risk
- `runtime/publish-gate.ts` — Pre-send safety/policy checks
- `harness/db.ts` + `repository.ts` — SQLite persistence for tasks, runs, metrics
- `browser/` — Playwright-based browser automation with approval gates
- `skills/` — Agent skill versioning, drafting, rollback
- `memory/` — Per-user preference storage and context retrieval

### State Directory (`~/.tinyagi/`)

```
queue/{incoming,processing,outgoing}/   # Message queue
logs/{queue,discord,telegram,whatsapp,daemon,heartbeat}.log
settings.json                           # All configuration
pairing.json                            # Sender allowlist
chats/                                  # Team conversation logs
events/                                 # Real-time events for visualizer
harness/state.db                        # Harness SQLite DB
files/                                  # Uploaded attachments
memory/                                 # User memory records
```

### Agent Workspaces

Each agent gets an isolated directory under the configured workspace path (default `~/tinyagi-workspace/<agent_id>/`). Agent setup (`src/lib/agent-setup.ts`) creates `.claude/` config, `heartbeat.md`, `AGENTS.md`, and symlinks `.agents/skills` from the project root.

## System Requirements

Bash 4.0+ (macOS ships 3.x; the scripts auto-detect and exec Homebrew bash), tmux, jq, Node.js, and either Claude Code CLI or Codex CLI.

## Conventions

- Shell scripts use `TINYAGI_HOME` env var pointing to the project root; TypeScript uses `SCRIPT_DIR` resolved from `__dirname`
- Settings are always loaded via `jq` in shell and `fs.readFileSync` + `JSON.parse` in TypeScript from `~/.tinyagi/settings.json`
- Channel clients and queue processor run as separate Node processes in tmux windows
- The `bin/tinyagi` and `bin/tinyclaw` wrappers resolve the project directory and exec the main shell script
- Long responses (>4000 chars) are truncated and the full text is saved as a `.md` file attachment
