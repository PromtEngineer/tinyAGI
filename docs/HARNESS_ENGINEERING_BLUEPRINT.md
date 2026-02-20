# Harness Engineering Blueprint For tinyAGI

## Purpose

This document defines how tinyAGI should evolve from a channel bot + queue worker into a harness-driven engineering system:

- clear task specs
- durable orchestration
- measurable evidence before publish
- continuous cleanup of quality drift

It also maps relevant ideas from DeepMind's Aletheia / Gemini Deep Think workflow into practical patterns for this repo.

## External References

- OpenAI: [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/)
- Google DeepMind: [Accelerating Mathematical and Scientific Discovery with Gemini Deep Think](https://deepmind.google/blog/accelerating-mathematical-and-scientific-discovery-with-gemini-deep-think/)

## Core Shift

Current shape:

- channel adapters ingest messages
- queue processor routes to agent
- provider CLI returns answer
- answer is sent back

Target shape:

- task intent is explicit
- orchestration enforces policy and evidence gates
- outputs are verified before delivery
- system continuously measures and repairs quality

## Principles To Adopt (Harness Engineering)

1. Throughput and autonomy require bounded architecture.
2. Docs are system-of-record for architecture and agent behavior.
3. Repository rules must be machine-checkable, not just prompt text.
4. Merge/publish decisions should be evidence-based.
5. Background "garbage collection" should continuously reduce drift and debt.

## Current Gaps In tinyAGI

1. Config and behavior are fragmented across shell and TS paths.
2. Some critical flows are memory-only (pending replies, conversation state).
3. Provider/model controls are ambiguous between global and per-agent config.
4. Team collaboration guidance and parser semantics are not fully aligned.
5. Verification is mostly implicit, not a first-class gate.
6. No formal taxonomy for output confidence and contribution level.

## Target Architecture

### 1) Control Plane

- `task_spec`:
  - objective
  - constraints
  - acceptance criteria
  - required evidence
  - risk profile
- `policy_engine`:
  - architecture rules
  - security rules
  - reliability rules
  - publication/sending rules
- `run_orchestrator`:
  - creates execution plan
  - selects agent set
  - manages retries and escalation

### 2) Runtime Plane

- `ingress adapters`: Discord/Telegram/WhatsApp become thin translators.
- `durable state store`: message/run states persisted, restart-safe.
- `agent runners`: provider-specific execution wrappers.
- `verification workers`: structured checks before outbound delivery.
- `egress adapters`: send only approved outputs.

### 3) Data Model (Durable)

Key entities:

- `task_runs`
- `run_steps`
- `artifacts`
- `verdicts`
- `outbound_messages`

Suggested run states:

- `queued`
- `in_progress`
- `needs_revision`
- `verified`
- `rejected`
- `sent`
- `failed`

## Aletheia-Inspired Patterns To Use

The DeepMind post describes an iterative "generator -> verifier -> reviser" loop and explicit human+automated verification. These ideas map directly to tinyAGI:

1. Generator -> Verifier -> Reviser loop
   - Generate candidate response/patch.
   - Verifier finds flaws and classifies severity.
   - Reviser updates candidate.
   - Repeat until pass or budget exceeded.

2. Explicit "cannot solve" outcome
   - Permit abstention when confidence is low.
   - Return unresolved status plus next-best actions.
   - Avoid forcing plausible but weak answers.

3. Balanced prompting (prove or refute)
   - Add a "counterexample/refutation" pass for critical claims.
   - Require one pass that attempts to break the primary answer.

4. Advisor mode for high-stakes tasks
   - Keep human in the loop with checkpoints.
   - Human guides scope and verifies final claims.

5. Code-assisted verification
   - Require executable checks when possible:
     - tests
     - lint/static analysis
     - reproducible command outputs

6. Search/browsing with citation checks
   - Validate external claims and URLs.
   - Reject unsupported citations.

7. Contribution taxonomy
   - Label outputs by contribution level and evidence quality:
     - L0: draft/idea
     - L1: internally validated
     - L2: externally reproducible
     - L3: publication-grade
   - Do not overstate level.

## Proposed Repository Additions

```text
docs/
  HARNESS_ENGINEERING_BLUEPRINT.md
  ARCHITECTURE_MAP.md
  QUALITY_SCORECARD.md
  POLICIES.md
harness/
  specs/
  runtime/
  verifiers/
  evaluators/
  telemetry/
```

## Migration Plan

### Phase 0: Alignment

- Create architecture map and policy docs.
- Normalize naming and ownership for config fields.

### Phase 1: Reliability Foundation

- Unify config resolution path.
- Persist pending reply correlation in durable storage.
- Persist conversation graph state.
- Add idempotency keys and dead-letter queue.

### Phase 2: Harness Core

- Introduce `task_spec` and `task_run` schema.
- Move routing/execution behind orchestrator.
- Add pre-send verification gates.

### Phase 3: Aletheia Loop

- Add generator/verifier/reviser cycle to critical tasks.
- Add explicit abstain path.
- Add balanced prompting refutation worker.

### Phase 4: Continuous Quality

- Add quality scorecard and drift monitors.
- Add recurring cleanup agents for:
  - stale docs
  - policy violations
  - flaky checks
  - orphaned runtime artifacts

## Minimum Acceptance Criteria For Any Future "Agentic" Feature

1. Must define acceptance criteria in machine-readable form.
2. Must produce evidence artifacts.
3. Must have a verifier path.
4. Must survive restart without silent data loss.
5. Must expose clear confidence/contribution level.

## Metrics

Reliability:

- response loss rate
- duplicate send rate
- restart recovery success rate

Quality:

- verifier pass rate
- post-send correction rate
- unresolved-abstain correctness rate

Velocity:

- median task completion time
- percentage of auto-verified tasks
- regression rate per release

## Immediate Next Steps For tinyAGI

1. Fix config path inconsistencies and make one canonical resolver.
2. Persist pending message mapping used by channel adapters.
3. Add a first verifier worker that checks:
   - citation validity
   - required artifacts
   - policy constraints
4. Introduce run-level states and basic telemetry.
5. Pilot Aletheia loop on one high-risk workflow first.

