#!/usr/bin/env bash
# =============================================================================
# Claude Team E2E Smoke Test
#
# Exercises the full Claude Team pipeline end-to-end using real module calls
# and (optionally) CCB-based AI provider calls when the daemon is running.
#
# Usage:
#   bash scripts/smoke-test.sh [project_path]
#   DRY_RUN=true bash scripts/smoke-test.sh
#   bash scripts/smoke-test.sh --dry-run
#
# Environment variables:
#   DRY_RUN=true   Skip all AI calls; exercise TypeScript modules only.
#   VERBOSE=true   Print extra debug output.
#
# Requirements for full mode (DRY_RUN unset):
#   - CCB daemon running  (ask / pend commands available)
#   - Node.js >= 18 + npx tsx
# =============================================================================

# NOTE: intentionally NOT using set -e — each step captures its own exit code.
set -uo pipefail

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --verbose) VERBOSE=true ;;
  esac
done

DRY_RUN="${DRY_RUN:-false}"
VERBOSE="${VERBOSE:-false}"

# ---------------------------------------------------------------------------
# Resolve paths (always use absolute so cwd changes don't break things)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Use first positional non-flag argument as project dir, else a temp dir
PROJECT_DIR=""
for arg in "$@"; do
  case "$arg" in
    --*) ;;
    *) PROJECT_DIR="$arg" ;;
  esac
done
if [[ -z "$PROJECT_DIR" ]]; then
  PROJECT_DIR="$(mktemp -d /tmp/ct-e2e-XXXX)"
fi

PROJECT_ID="e2e-test-$(date +%s)"
TASK="Build a REST API with JWT authentication and SQLite database"

# Temp dir for generated .ts scripts — cleaned up at exit
SCRIPTS_TMP="$(mktemp -d /tmp/ct-smoke-scripts-XXXX)"
trap 'rm -rf "$SCRIPTS_TMP"' EXIT

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RESET='\033[0m'

log()   { echo -e "${BLUE}[INFO]${RESET}  $*"; }
ok()    { echo -e "${GREEN}[PASS]${RESET}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
err()   { echo -e "${RED}[FAIL]${RESET}  $*"; }
debug() { [[ "$VERBOSE" == "true" ]] && echo -e "       $*" || true; }
fatal() { err "$*"; exit 1; }

PASS=0
FAIL=0
SKIP=0

step_pass() { ok   "Step $1"; PASS=$((PASS + 1)); }
step_skip() { warn "Step $1 (skipped)"; SKIP=$((SKIP + 1)); }
step_fail() { err  "Step $1"; FAIL=$((FAIL + 1)); }

# Write a TypeScript snippet to a temp file in the REPO_ROOT so relative
# imports resolve correctly, then run it with npx tsx.
# Returns stdout; never aborts on failure.
run_ts() {
  local label="$1"
  local snippet="$2"
  local ts_file="$REPO_ROOT/.smoke-step-${label}.ts"
  printf '%s\n' "$snippet" > "$ts_file"
  local output
  output="$(npx tsx "$ts_file" 2>/dev/null)" || output=""
  rm -f "$ts_file"
  printf '%s' "$output"
}

# Extract a top-level JSON field value from a JSON string using node.
json_field() {
  local json="$1" field="$2"
  printf '%s' "$json" | node -e \
    "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const v=JSON.parse(d)$field;console.log(v===undefined?'':v)}catch(e){console.log('')}})" \
    2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------
echo ""
echo "================================================================="
echo "  Claude Team E2E Smoke Test"
echo "================================================================="
echo "  Repo        : $REPO_ROOT"
echo "  Project dir : $PROJECT_DIR"
echo "  Project ID  : $PROJECT_ID"
echo "  Dry-run     : $DRY_RUN"
echo "  Task        : $TASK"
echo "================================================================="
echo ""

# ---------------------------------------------------------------------------
# STEP 1: Environment check
# ---------------------------------------------------------------------------
log "Step 1: Environment check (node + npx + source files)"

node --version > /dev/null 2>&1 || fatal "node not found — install Node.js >= 18"
npx --version  > /dev/null 2>&1 || fatal "npx not found"

MISSING=0
for f in \
  "$REPO_ROOT/src/features/state-manager/index.ts" \
  "$REPO_ROOT/src/core/dag-engine.ts" \
  "$REPO_ROOT/src/core/complexity-analyzer.ts" \
  "$REPO_ROOT/src/core/planner-worker-judge.ts"; do
  [[ -f "$f" ]] || { warn "Missing: $f"; MISSING=$((MISSING + 1)); }
done

if [[ $MISSING -eq 0 ]]; then
  step_pass "1 (environment check: node $(node --version), $(npx --version | head -1))"
else
  step_fail "1 (environment check: $MISSING source files missing)"
fi

# ---------------------------------------------------------------------------
# STEP 2: Initialise pipeline state
# ---------------------------------------------------------------------------
log "Step 2: Initialise pipeline state"

INIT_OUT="$(run_ts "init" "
import { createPipelineState } from './src/features/state-manager/index.js';
const state = createPipelineState('$PROJECT_DIR', '$PROJECT_ID', '$PROJECT_DIR');
console.log(JSON.stringify({ phase: state.phase, active: state.active, schema: state.schemaVersion }));
")"

if [[ -n "$INIT_OUT" ]]; then
  INIT_PHASE="$(json_field "$INIT_OUT" '.phase')"
  INIT_ACTIVE="$(json_field "$INIT_OUT" '.active')"
  STATE_FILE="$PROJECT_DIR/.omc/state/ct-pipeline-state.json"
  debug "phase=$INIT_PHASE active=$INIT_ACTIVE file=$([ -f "$STATE_FILE" ] && echo yes || echo no)"
  if [[ "$INIT_PHASE" == "team-plan" && -f "$STATE_FILE" ]]; then
    step_pass "2 (init pipeline → phase=$INIT_PHASE, state file created)"
  else
    step_fail "2 (init pipeline: phase=$INIT_PHASE, file=$([ -f "$STATE_FILE" ] && echo exists || echo missing))"
  fi
else
  step_fail "2 (init pipeline state — tsx returned empty output)"
fi

# ---------------------------------------------------------------------------
# STEP 3: Analyse complexity
# ---------------------------------------------------------------------------
log "Step 3: Analyse task complexity"

COMPLEXITY_OUT="$(run_ts "complexity" "
import { analyzeComplexity } from './src/core/complexity-analyzer.js';
const result = analyzeComplexity({
  description: 'Build a REST API with JWT authentication and SQLite database',
  fileCount: 12,
  crossModuleDeps: 4,
  hasTests: true,
  hasApiChanges: true,
  hasDbChanges: true,
  hasSecurityImplications: true,
});
console.log(JSON.stringify({ level: result.level, score: result.score, agents: result.recommendedAgentCount }));
")"

if [[ -n "$COMPLEXITY_OUT" ]]; then
  C_LEVEL="$(json_field "$COMPLEXITY_OUT" '.level')"
  C_AGENTS="$(json_field "$COMPLEXITY_OUT" '.agents')"
  debug "level=$C_LEVEL agents=$C_AGENTS"
  if [[ "$C_LEVEL" =~ ^(tiny|small|medium|large)$ ]]; then
    step_pass "3 (complexity analysis: level=$C_LEVEL, agents=$C_AGENTS)"
  else
    step_fail "3 (complexity analysis: unexpected level=$C_LEVEL)"
  fi
else
  step_fail "3 (complexity analysis — tsx returned empty output)"
fi

# ---------------------------------------------------------------------------
# STEP 4: Select roles
# ---------------------------------------------------------------------------
log "Step 4: Select roles based on complexity"

ROLES_OUT="$(run_ts "roles" "
import { analyzeComplexity } from './src/core/complexity-analyzer.js';
import { selectRoles } from './src/core/planner-worker-judge.js';
const complexity = analyzeComplexity({
  description: 'REST API with auth and DB',
  fileCount: 12, crossModuleDeps: 4,
  hasTests: true, hasApiChanges: true, hasDbChanges: true, hasSecurityImplications: true,
});
const roles = selectRoles(complexity);
console.log(JSON.stringify({ count: roles.length, roles: roles.map((r: any) => r.role), layers: roles.map((r: any) => r.dagLayer) }));
")"

if [[ -n "$ROLES_OUT" ]]; then
  R_COUNT="$(json_field "$ROLES_OUT" '.count')"
  debug "roles count=$R_COUNT — $ROLES_OUT"
  if [[ "$R_COUNT" =~ ^[0-9]+$ ]] && [[ "$R_COUNT" -ge 1 ]]; then
    step_pass "4 (role selection: $R_COUNT agents)"
  else
    step_fail "4 (role selection: unexpected count=$R_COUNT)"
  fi
else
  step_fail "4 (role selection — tsx returned empty output)"
fi

# ---------------------------------------------------------------------------
# STEP 5: Build DAG execution plan
# ---------------------------------------------------------------------------
log "Step 5: Build DAG execution plan"

DAG_OUT="$(run_ts "dag" "
import { buildExecutionPlan, validateFileOwnership } from './src/core/dag-engine.js';
const specs = [
  { id: 'plan', title: 'Plan',     description: 'Planning phase', assignedRole: 'pm'          as any, filePatterns: [],            dependencies: [],           nodeType: 'planning'     as any, priority: 1 },
  { id: 'fe',   title: 'Frontend', description: 'FE work',        assignedRole: 'fe-dev'       as any, filePatterns: ['src/fe/**'], dependencies: ['plan'],     nodeType: 'execution'    as any, priority: 2 },
  { id: 'be',   title: 'Backend',  description: 'BE work',        assignedRole: 'be-dev'       as any, filePatterns: ['src/be/**'], dependencies: ['plan'],     nodeType: 'execution'    as any, priority: 2 },
  { id: 'qa',   title: 'QA',       description: 'QA review',      assignedRole: 'qa-engineer'  as any, filePatterns: [],            dependencies: ['fe', 'be'], nodeType: 'verification' as any, priority: 3 },
];
const plan = buildExecutionPlan('$PROJECT_ID', specs);
const conflicts = validateFileOwnership(plan);
console.log(JSON.stringify({ planId: plan.id, layers: plan.layers.length, nodes: plan.nodes.size, conflicts: conflicts.length, status: plan.status }));
")"

if [[ -n "$DAG_OUT" ]]; then
  D_LAYERS="$(json_field "$DAG_OUT" '.layers')"
  D_NODES="$(json_field "$DAG_OUT" '.nodes')"
  D_CONFLICTS="$(json_field "$DAG_OUT" '.conflicts')"
  debug "layers=$D_LAYERS nodes=$D_NODES conflicts=$D_CONFLICTS"
  if [[ "$D_LAYERS" =~ ^[0-9]+$ ]] && [[ "$D_LAYERS" -ge 2 ]]; then
    step_pass "5 (DAG build: $D_LAYERS layers, $D_NODES nodes, $D_CONFLICTS conflicts)"
  else
    step_fail "5 (DAG build: unexpected layers=$D_LAYERS)"
  fi
else
  step_fail "5 (DAG build — tsx returned empty output)"
fi

# ---------------------------------------------------------------------------
# STEP 6: Phase transitions (full lifecycle)
# ---------------------------------------------------------------------------
log "Step 6: Phase transitions (team-plan → prd → exec → verify → complete)"

TRANSITION_OUT="$(run_ts "transitions" "
import { createPipelineState, transitionPhase, loadPipelineState } from './src/features/state-manager/index.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const dir = mkdtempSync(join(tmpdir(), 'ct-smoke-trans-'));
try {
  createPipelineState(dir, 'smoke-session', dir);
  const r1 = transitionPhase(dir, 'team-prd');
  const r2 = transitionPhase(dir, 'team-exec');
  const r3 = transitionPhase(dir, 'team-verify');
  const r4 = transitionPhase(dir, 'complete');
  const final = loadPipelineState(dir);
  console.log(JSON.stringify({
    prd: r1.ok, exec: r2.ok, verify: r3.ok, complete: r4.ok,
    phase: final?.phase,
    active: final?.active,
    historyLen: final?.phaseHistory.length,
  }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
")"

if [[ -n "$TRANSITION_OUT" ]]; then
  T_PHASE="$(json_field "$TRANSITION_OUT" '.phase')"
  T_ACTIVE="$(json_field "$TRANSITION_OUT" '.active')"
  T_HISTORY="$(json_field "$TRANSITION_OUT" '.historyLen')"
  debug "final phase=$T_PHASE active=$T_ACTIVE historyLen=$T_HISTORY"
  if [[ "$T_PHASE" == "complete" && "$T_ACTIVE" == "false" ]]; then
    step_pass "6 (phase transitions → complete, history=$T_HISTORY entries)"
  else
    step_fail "6 (phase transitions: phase=$T_PHASE active=$T_ACTIVE)"
  fi
else
  step_fail "6 (phase transitions — tsx returned empty output)"
fi

# ---------------------------------------------------------------------------
# STEP 7: State update helpers
# ---------------------------------------------------------------------------
log "Step 7: State update helpers (complexity + kanban + execution + quality gates)"

UPDATES_OUT="$(run_ts "updates" "
import { createPipelineState, updateComplexity, updateKanbanCounts, updateExecution, updateQualityGates, loadPipelineState } from './src/features/state-manager/index.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const dir = mkdtempSync(join(tmpdir(), 'ct-smoke-upd-'));
try {
  createPipelineState(dir, 'smoke-upd', dir);
  updateComplexity(dir, {
    level: 'large' as any,
    score: 0.85,
    factors: { fileCount: 12, crossModuleDeps: 4, hasTests: true, hasApiChanges: true, hasDbChanges: true, hasSecurityImplications: true },
    recommendedAgentCount: 4,
  });
  updateKanbanCounts(dir, { inProgress: 3, done: 5 });
  updateExecution(dir, { workersTotal: 4, workersActive: 2, tasksTotal: 10, tasksCompleted: 6 });
  updateQualityGates(dir, { passed: 2, lastScore: 8.5 });
  const state = loadPipelineState(dir);
  console.log(JSON.stringify({
    complexityLevel: state?.complexityScore?.level,
    kanbanDone: state?.kanban.done,
    workersTotal: state?.execution.workersTotal,
    gatesPassed: state?.qualityGates.passed,
    lastScore: state?.qualityGates.lastScore,
  }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
")"

if [[ -n "$UPDATES_OUT" ]]; then
  U_LEVEL="$(json_field "$UPDATES_OUT" '.complexityLevel')"
  U_DONE="$(json_field "$UPDATES_OUT" '.kanbanDone')"
  U_WORKERS="$(json_field "$UPDATES_OUT" '.workersTotal')"
  U_GATES="$(json_field "$UPDATES_OUT" '.gatesPassed')"
  debug "complexity=$U_LEVEL kanban.done=$U_DONE workers=$U_WORKERS gates.passed=$U_GATES"
  if [[ "$U_LEVEL" == "large" && "$U_DONE" == "5" && "$U_WORKERS" == "4" && "$U_GATES" == "2" ]]; then
    step_pass "7 (state updates: complexity=$U_LEVEL done=$U_DONE workers=$U_WORKERS gates=$U_GATES)"
  else
    step_fail "7 (state updates: unexpected values — $UPDATES_OUT)"
  fi
else
  step_fail "7 (state updates — tsx returned empty output)"
fi

# ---------------------------------------------------------------------------
# STEP 8: Full vitest e2e suite
# ---------------------------------------------------------------------------
log "Step 8: Run vitest e2e test suite (tests/e2e/full-pipeline.test.ts)"

VITEST_OUT="$(npx vitest run "$REPO_ROOT/tests/e2e/full-pipeline.test.ts" --reporter=verbose 2>&1)" || true

# Match the vitest summary lines (strip ANSI codes first for reliable grep):
#   "Test Files  1 passed (1)"
#   "Tests  56 passed (56)"
VITEST_PLAIN="$(printf '%s' "$VITEST_OUT" | sed 's/\x1b\[[0-9;]*m//g')"
VITEST_FILE_FAILED="$(echo "$VITEST_PLAIN" | grep -cE '^[[:space:]]*Test Files +[0-9]+ failed' 2>/dev/null)" || VITEST_FILE_FAILED=0
VITEST_TEST_FAILED="$(echo "$VITEST_PLAIN" | grep -cE '^[[:space:]]*Tests +[0-9]+ failed'      2>/dev/null)" || VITEST_TEST_FAILED=0

if echo "$VITEST_PLAIN" | grep -qE 'Tests +[0-9]+ passed'; then
  SUMMARY_LINE="$(echo "$VITEST_PLAIN" | grep -E 'Tests +[0-9]+ passed' | tail -1 | sed 's/^[[:space:]]*//')"
  if [[ "$VITEST_FILE_FAILED" -gt 0 || "$VITEST_TEST_FAILED" -gt 0 ]]; then
    err "vitest output (last 20 lines):"
    echo "$VITEST_OUT" | tail -20
    step_fail "8 (vitest e2e suite — some tests failed)"
  else
    step_pass "8 (vitest e2e suite: $SUMMARY_LINE)"
  fi
else
  warn "vitest output tail:"
  echo "$VITEST_OUT" | tail -10
  step_fail "8 (vitest e2e suite — could not determine result)"
fi

# ---------------------------------------------------------------------------
# STEP 9: AI planning phase (real CCB call or dry-run)
# ---------------------------------------------------------------------------
log "Step 9: Planning phase via AI (CCB ask codex)"

if [[ "$DRY_RUN" == "true" ]]; then
  step_skip "9 (planning via ask codex — dry-run)"
else
  if ! command -v ask > /dev/null 2>&1; then
    step_skip "9 (planning via ask codex — 'ask' command not found)"
  else
    PLAN_PROMPT="You are a Project Manager for the Claude Team plugin.
Task: $TASK
Create a structured execution plan with:
1. Clear deliverables (3-5 items)
2. Complexity assessment (tiny/small/medium/large)
3. Role assignments
Respond with valid JSON only: { deliverables: string[], complexity: string, roles: string[] }"

    PLAN_OUT="$(ask codex "$PLAN_PROMPT" 2>/dev/null)" || PLAN_OUT=""

    if echo "$PLAN_OUT" | grep -q 'CCB_ASYNC_SUBMITTED'; then
      debug "Codex job submitted asynchronously"
      step_pass "9 (planning: async job submitted — use 'pend codex' to retrieve)"
    elif [[ -n "$PLAN_OUT" ]]; then
      debug "Plan: ${PLAN_OUT:0:200}"
      step_pass "9 (planning via ask codex)"
    else
      step_skip "9 (planning via ask codex — empty response)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# STEP 10: CCB pend (retrieve async results if applicable)
# ---------------------------------------------------------------------------
log "Step 10: Retrieve async AI results (pend codex)"

if [[ "$DRY_RUN" == "true" ]]; then
  step_skip "10 (pend codex — dry-run)"
else
  if ! command -v pend > /dev/null 2>&1; then
    step_skip "10 (pend codex — 'pend' command not found)"
  else
    PEND_OUT="$(pend codex 2>/dev/null)" || PEND_OUT=""
    if [[ -n "$PEND_OUT" ]]; then
      debug "Pend result: ${PEND_OUT:0:200}"
      step_pass "10 (pend codex: results received)"
    else
      step_skip "10 (pend codex — no pending results)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# CLEANUP
# ---------------------------------------------------------------------------
if [[ "$PROJECT_DIR" == /tmp/ct-e2e-* ]]; then
  rm -rf "$PROJECT_DIR" 2>/dev/null || true
  debug "Cleaned up $PROJECT_DIR"
fi

# ---------------------------------------------------------------------------
# SUMMARY
# ---------------------------------------------------------------------------
echo ""
echo "================================================================="
echo "  Smoke Test Summary"
echo "================================================================="
printf "  ${GREEN}PASS${RESET}: %d\n" "$PASS"
printf "  ${YELLOW}SKIP${RESET}: %d  (dry-run or unavailable commands)\n" "$SKIP"
printf "  ${RED}FAIL${RESET}: %d\n" "$FAIL"
echo "================================================================="

if [[ $FAIL -gt 0 ]]; then
  echo ""
  err "Smoke test completed with $FAIL failure(s)."
  exit 1
fi

if [[ $PASS -eq 0 && $SKIP -gt 0 ]]; then
  warn "All steps were skipped. Install npx/tsx and retry."
  exit 0
fi

echo ""
ok "All smoke test steps completed successfully."
exit 0
