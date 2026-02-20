#!/usr/bin/env bash
# tinyAGI harness smoke/integration test runner

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

NO_BUILD=false
TEST_USER=""

usage() {
    cat <<USAGE
Usage: scripts/test-harness.sh [--no-build] [--user <user_id>]

Runs harness migration smoke tests:
1. Build + harness enable
2. Tooling approval gate + approved execution
3. Memory ingest/retrieval
4. Auto skill draft creation
5. Browser replay command wiring
6. Durable pending message store
7. Metrics CLI
USAGE
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --no-build)
            NO_BUILD=true
            ;;
        --user)
            shift
            TEST_USER="${1:-}"
            if [ -z "$TEST_USER" ]; then
                echo "--user requires a value"
                exit 1
            fi
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1"
            usage
            exit 1
            ;;
    esac
    shift
done

if [ -z "$TEST_USER" ]; then
    TEST_USER="harness_test_user_$(date +%s)"
fi

TOTAL=0
PASSED=0
FAILED=0

step() {
    echo -e "${BLUE}\n==>${NC} $1"
}

pass() {
    PASSED=$((PASSED + 1))
    TOTAL=$((TOTAL + 1))
    echo -e "${GREEN}PASS${NC} $1"
}

fail() {
    FAILED=$((FAILED + 1))
    TOTAL=$((TOTAL + 1))
    echo -e "${RED}FAIL${NC} $1"
}

run_cmd() {
    local label="$1"
    shift
    if "$@"; then
        pass "$label"
        return 0
    fi

    fail "$label"
    return 1
}

json_field() {
    local field="$1"
    node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const v=j['$field'];process.stdout.write(v===undefined?'':String(v));}catch{process.stdout.write('');}});"
}

cd "$PROJECT_ROOT" || exit 1

echo -e "${BLUE}tinyAGI Harness Test Runner${NC}"
echo "Project: $PROJECT_ROOT"
echo "Test user: $TEST_USER"

if [ "$NO_BUILD" = false ]; then
    step "Build"
    run_cmd "npm run build:main" npm run build:main
else
    echo -e "${YELLOW}Skipping build (--no-build).${NC}"
fi

step "Enable Harness"
run_cmd "harness enabled" node dist/harness/cli.js harness enable >/dev/null

step "Tooling Approval Gate"
TOOL_GATE_JSON="$(TEST_USER="$TEST_USER" node - <<'NODE'
const { executeToolingTask } = require('./dist/harness/tools/executor.js');
(async () => {
  const result = await executeToolingTask({
    runId: `run_tool_gate_${Date.now()}`,
    userId: process.env.TEST_USER,
    objective: 'npm --version',
    workspacePath: process.cwd(),
  });
  process.stdout.write(JSON.stringify(result));
})();
NODE
)"

GATE_STATUS="$(printf '%s' "$TOOL_GATE_JSON" | json_field status)"
GATE_REQUEST_ID="$(printf '%s' "$TOOL_GATE_JSON" | json_field requestId)"

if [ "$GATE_STATUS" = "needs_approval" ] && [ -n "$GATE_REQUEST_ID" ]; then
    pass "tooling requires approval"
    echo "request_id=$GATE_REQUEST_ID"
else
    fail "tooling requires approval"
    echo "output=$TOOL_GATE_JSON"
fi

step "Grant Permission + Execute Tool"
run_cmd "grant permission for npm execute" node dist/harness/cli.js permission grant "$TEST_USER" npm execute tool >/dev/null

TOOL_EXEC_JSON="$(TEST_USER="$TEST_USER" node - <<'NODE'
const { executeToolingTask } = require('./dist/harness/tools/executor.js');
(async () => {
  const result = await executeToolingTask({
    runId: `run_tool_exec_${Date.now()}`,
    userId: process.env.TEST_USER,
    objective: 'npm --version',
    workspacePath: process.cwd(),
  });
  process.stdout.write(JSON.stringify(result));
})();
NODE
)"

EXEC_STATUS="$(printf '%s' "$TOOL_EXEC_JSON" | json_field status)"
if [ "$EXEC_STATUS" = "completed" ]; then
    pass "tooling executes after approval"
else
    fail "tooling executes after approval"
    echo "output=$TOOL_EXEC_JSON"
fi

step "Memory Ingest + Retrieval"
MEMORY_JSON="$(TEST_USER="$TEST_USER" node - <<'NODE'
const memory = require('./dist/harness/memory/service.js');
const runId = `run_memory_${Date.now()}`;
const userId = process.env.TEST_USER;
const ingested = memory.ingestMemorySignals(
  userId,
  runId,
  'I prefer concise bullet updates. Remember this preference.',
  'Acknowledged and stored your preference.'
);
const context = memory.retrieveMemoryContext(userId, 'Please keep updates concise');
process.stdout.write(JSON.stringify({ ingested, hasPreference: /concise/i.test(context) }));
NODE
)"

MEMORY_INGESTED="$(printf '%s' "$MEMORY_JSON" | json_field ingested)"
MEMORY_HAS_PREF="$(printf '%s' "$MEMORY_JSON" | json_field hasPreference)"

if [ "${MEMORY_INGESTED:-0}" -ge 1 ] && [ "$MEMORY_HAS_PREF" = "true" ]; then
    pass "memory ingest/retrieval works"
else
    fail "memory ingest/retrieval works"
    echo "output=$MEMORY_JSON"
fi

step "Skill Auto-Draft"
SKILL_JSON="$(TEST_USER="$TEST_USER" node - <<'NODE'
const skills = require('./dist/harness/skills/service.js');
const token = Math.random().toString(36).slice(2, 8);
const result = skills.maybeAutoDraftSkill({
  userId: process.env.TEST_USER,
  runId: `run_skill_${Date.now()}`,
  objective: `Always do this workflow ${token}: run npm test and summarize failures.`,
  route: 'tooling',
  verified: true,
});
process.stdout.write(JSON.stringify(result));
NODE
)"

SKILL_CREATED="$(printf '%s' "$SKILL_JSON" | json_field created)"
SKILL_ID="$(printf '%s' "$SKILL_JSON" | json_field skillId)"

if [ "$SKILL_CREATED" = "true" ] && [ -n "$SKILL_ID" ]; then
    pass "auto skill draft created"
    run_cmd "skills show $SKILL_ID" node dist/harness/cli.js skills show "$SKILL_ID" >/dev/null
else
    fail "auto skill draft created"
    echo "output=$SKILL_JSON"
fi

step "Browser Replay Command"
REPLAY_OUTPUT="$(node dist/harness/cli.js browser replay missing_run 2>&1)"
if printf '%s' "$REPLAY_OUTPUT" | grep -qi "No replayable browser trace found"; then
    pass "browser replay wiring"
else
    fail "browser replay wiring"
    echo "$REPLAY_OUTPUT"
fi

step "Durable Pending Store"
PENDING_JSON="$(node - <<'NODE'
const pending = require('./dist/channels/pending-store.js');
pending.rememberPendingMessage({
  messageId: 'msg_harness_test',
  channel: 'whatsapp',
  sender: 'tester',
  senderId: '123',
  chatRef: '123@c.us',
  replyRef: 'abc',
  ttlMs: 60000,
});
const before = pending.readPendingMessage('whatsapp', 'msg_harness_test');
pending.clearPendingMessage('msg_harness_test');
const after = pending.readPendingMessage('whatsapp', 'msg_harness_test');
process.stdout.write(JSON.stringify({ beforeExists: !!before, afterExists: !!after }));
NODE
)"

PENDING_BEFORE="$(printf '%s' "$PENDING_JSON" | json_field beforeExists)"
PENDING_AFTER="$(printf '%s' "$PENDING_JSON" | json_field afterExists)"

if [ "$PENDING_BEFORE" = "true" ] && [ "$PENDING_AFTER" = "false" ]; then
    pass "durable pending store read/clear"
else
    fail "durable pending store read/clear"
    echo "output=$PENDING_JSON"
fi

step "Metrics CLI"
METRICS_OUTPUT="$(node dist/harness/cli.js metrics 2>&1)"
if printf '%s' "$METRICS_OUTPUT" | grep -qi "Harness metrics\|No metrics recorded yet"; then
    pass "metrics command"
else
    fail "metrics command"
    echo "$METRICS_OUTPUT"
fi

echo -e "${BLUE}\nSummary${NC}"
echo "Passed: $PASSED"
echo "Failed: $FAILED"
echo "Total:  $TOTAL"

if [ "$FAILED" -gt 0 ]; then
    exit 1
fi

exit 0
