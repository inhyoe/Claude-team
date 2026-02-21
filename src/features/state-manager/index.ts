/**
 * Claude Team - State Manager
 *
 * JSON-file-based state management for the team pipeline.
 * Uses advisory file locking (mkdir-based) for safe concurrent access.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync, rmdirSync } from 'fs';
import { join } from 'path';
import type {
  TeamPipelineState,
  TeamPipelinePhase,
  TeamPhaseHistoryEntry,
  TeamTransitionResult,
  RoleType,
  ComplexityScore,
  RoleAssignment,
} from '../../shared/types.js';
import { TEAM_PIPELINE_SCHEMA_VERSION } from '../../shared/types.js';

// ============================================================
// STATE FILE PATHS
// ============================================================

const STATE_DIR = '.omc/state';
const STATE_FILE = 'ct-pipeline-state.json';

function getStatePath(cwd: string): string {
  return join(cwd, STATE_DIR, STATE_FILE);
}

function ensureStateDir(cwd: string): void {
  const dir = join(cwd, STATE_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

// ============================================================
// ADVISORY FILE LOCKING
// ============================================================

const LOCK_STALE_MS = 30_000; // Lock considered stale after 30s
const LOCK_RETRY_MS = 50;     // Retry interval
const LOCK_MAX_WAIT_MS = 5000; // Max wait before giving up

function getLockPath(cwd: string): string {
  return join(cwd, STATE_DIR, STATE_FILE + '.lock');
}

/**
 * Acquire an advisory file lock using mkdir (atomic on all platforms).
 * Returns a release function. Stale locks (>30s) are automatically broken.
 */
function acquireLock(cwd: string): () => void {
  ensureStateDir(cwd);
  const lockPath = getLockPath(cwd);
  const startTime = Date.now();

  while (true) {
    try {
      // mkdir is atomic — if it succeeds, we own the lock
      mkdirSync(lockPath);
      // Write PID + timestamp for stale detection
      const infoPath = join(lockPath, 'info');
      writeFileSync(infoPath, `${process.pid}:${Date.now()}`, 'utf-8');
      break;
    } catch {
      // Lock exists — check if stale
      try {
        const infoPath = join(lockPath, 'info');
        if (existsSync(infoPath)) {
          const content = readFileSync(infoPath, 'utf-8');
          const lockTime = parseInt(content.split(':')[1], 10);
          if (Date.now() - lockTime > LOCK_STALE_MS) {
            // Stale lock — break it
            releaseLockFiles(lockPath);
            continue;
          }
        }
      } catch {
        // Can't read lock info — try to break stale lock
        releaseLockFiles(lockPath);
        continue;
      }

      // Not stale — check timeout before retrying
      if (Date.now() - startTime > LOCK_MAX_WAIT_MS) {
        // Throw instead of force-breaking: two concurrent timeouts would both
        // release and re-acquire, creating a race. Let the caller decide.
        throw new Error(`State lock timeout after ${LOCK_MAX_WAIT_MS}ms — another process may be writing state`);
      }
      // Synchronous sleep bounded to 50ms to limit event-loop blocking
      const waitUntil = Date.now() + Math.min(LOCK_RETRY_MS, 50);
      while (Date.now() < waitUntil) { /* spin */ }
    }
  }

  return () => releaseLockFiles(lockPath);
}

function releaseLockFiles(lockPath: string): void {
  try {
    const infoPath = join(lockPath, 'info');
    if (existsSync(infoPath)) unlinkSync(infoPath);
    if (existsSync(lockPath)) {
      rmdirSync(lockPath);
    }
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Execute a state mutation under advisory file lock.
 * Prevents read-modify-write race conditions between concurrent processes.
 */
export function withStateLock<R>(cwd: string, fn: () => R): R {
  let release: (() => void) | undefined;
  try {
    release = acquireLock(cwd);
    return fn();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('State lock timeout')) {
      throw new Error(`Concurrent access conflict: ${err.message}. Retry the operation.`);
    }
    throw err;
  } finally {
    release?.();
  }
}

// ============================================================
// STATE LIFECYCLE
// ============================================================

/**
 * Create a new pipeline state.
 */
export function createPipelineState(
  cwd: string,
  sessionId: string,
  projectPath: string
): TeamPipelineState {
  const now = new Date().toISOString();

  const state: TeamPipelineState = {
    schemaVersion: TEAM_PIPELINE_SCHEMA_VERSION,
    mode: 'claude-team',
    active: true,
    sessionId,
    projectPath,

    phase: 'team-plan',
    phaseHistory: [{ phase: 'team-plan', enteredAt: now }],

    iteration: 1,
    maxIterations: 10,

    roles: [],
    complexityScore: null,
    executionPlanId: null,
    currentSprintId: null,

    kanban: {
      backlog: 0,
      todo: 0,
      inProgress: 0,
      review: 0,
      done: 0,
      blocked: 0,
      failed: 0,
      cancelled: 0,
    },

    qualityGates: {
      passed: 0,
      failed: 0,
      pending: 0,
      lastScore: null,
    },

    execution: {
      workersTotal: 0,
      workersActive: 0,
      tasksTotal: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
    },

    fixLoop: {
      attempt: 0,
      maxAttempts: 3,
      lastFailureReason: null,
    },

    cancel: {
      requested: false,
      requestedAt: null,
      preserveForResume: false,
    },

    startedAt: now,
    updatedAt: now,
    completedAt: null,
  };

  saveState(cwd, state);
  return state;
}

/**
 * Load existing pipeline state, or null if none exists.
 */
export function loadPipelineState(cwd: string): TeamPipelineState | null {
  const path = getStatePath(cwd);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, 'utf-8');
    const state = JSON.parse(raw) as TeamPipelineState;

    // Validate schema version
    if (state.schemaVersion !== TEAM_PIPELINE_SCHEMA_VERSION) {
      return null; // Incompatible version
    }

    return state;
  } catch {
    return null;
  }
}

/**
 * Save pipeline state to disk atomically.
 * Uses write-to-temp-then-rename to prevent corruption on crash.
 */
export function saveState(cwd: string, state: TeamPipelineState): void {
  ensureStateDir(cwd);
  state.updatedAt = new Date().toISOString();
  const target = getStatePath(cwd);
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, target);
}

/**
 * Delete pipeline state.
 */
export function clearState(cwd: string): void {
  const path = getStatePath(cwd);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

// ============================================================
// PHASE TRANSITIONS
// ============================================================

const VALID_PHASE_TRANSITIONS: Record<TeamPipelinePhase, TeamPipelinePhase[]> = {
  'team-plan': ['team-prd', 'team-exec', 'cancelled'],
  'team-prd': ['team-exec', 'cancelled'],
  'team-exec': ['team-verify', 'failed', 'cancelled'],
  'team-verify': ['team-fix', 'complete', 'cancelled'],
  'team-fix': ['team-exec', 'failed', 'cancelled'],
  'complete': [],
  'failed': ['team-plan'], // Can restart
  'cancelled': [],
};

/**
 * Transition the pipeline to a new phase.
 */
export function transitionPhase(
  cwd: string,
  toPhase: TeamPipelinePhase,
  reason?: string,
  activeRoles?: RoleType[]
): TeamTransitionResult {
  return withStateLock(cwd, () => {
    const state = loadPipelineState(cwd);
    if (!state) {
      return { ok: false, state: null, reason: 'No active pipeline state' };
    }

    // Check if transition is valid
    const validTargets = VALID_PHASE_TRANSITIONS[state.phase];
    if (!validTargets.includes(toPhase)) {
      return {
        ok: false,
        state,
        reason: `Cannot transition from ${state.phase} to ${toPhase}. Valid targets: ${validTargets.join(', ')}`,
      };
    }

    // Record transition
    const entry: TeamPhaseHistoryEntry = {
      phase: toPhase,
      enteredAt: new Date().toISOString(),
      reason,
      activeRoles,
    };

    state.phase = toPhase;
    state.phaseHistory.push(entry);

    // Handle terminal states
    if (toPhase === 'complete' || toPhase === 'failed' || toPhase === 'cancelled') {
      state.active = false;
      state.completedAt = new Date().toISOString();
    }

    // Handle fix loop
    if (toPhase === 'team-fix') {
      state.fixLoop.attempt++;
      if (state.fixLoop.attempt > state.fixLoop.maxAttempts) {
        state.phase = 'failed';
        state.active = false;
        state.completedAt = new Date().toISOString();
        state.fixLoop.lastFailureReason = 'Max fix loop attempts exceeded';
        saveState(cwd, state);
        return { ok: false, state, reason: 'Max fix loop attempts exceeded' };
      }
    }

    saveState(cwd, state);
    return { ok: true, state };
  });
}

// ============================================================
// SAFE ASSIGNMENT (Prototype Pollution Prevention)
// ============================================================

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function safeAssign<T extends Record<string, unknown>>(target: T, source: Partial<T>): void {
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      (target as Record<string, unknown>)[key] = source[key];
    }
  }
}

// ============================================================
// STATE UPDATES
// ============================================================

/**
 * Update complexity score in pipeline state.
 */
export function updateComplexity(cwd: string, complexity: ComplexityScore): void {
  withStateLock(cwd, () => {
    const state = loadPipelineState(cwd);
    if (!state) return;
    state.complexityScore = complexity;
    saveState(cwd, state);
  });
}

/**
 * Update role assignments in pipeline state.
 */
export function updateRoles(cwd: string, roles: RoleAssignment[]): void {
  withStateLock(cwd, () => {
    const state = loadPipelineState(cwd);
    if (!state) return;
    state.roles = roles;
    saveState(cwd, state);
  });
}

/**
 * Update execution counters.
 */
export function updateExecution(
  cwd: string,
  updates: Partial<TeamPipelineState['execution']>
): void {
  withStateLock(cwd, () => {
    const state = loadPipelineState(cwd);
    if (!state) return;
    safeAssign(state.execution, updates);
    saveState(cwd, state);
  });
}

/**
 * Update kanban counts.
 */
export function updateKanbanCounts(
  cwd: string,
  counts: Partial<TeamPipelineState['kanban']>
): void {
  withStateLock(cwd, () => {
    const state = loadPipelineState(cwd);
    if (!state) return;
    safeAssign(state.kanban, counts);
    saveState(cwd, state);
  });
}

/**
 * Update quality gate tracking.
 */
export function updateQualityGates(
  cwd: string,
  updates: Partial<TeamPipelineState['qualityGates']>
): void {
  withStateLock(cwd, () => {
    const state = loadPipelineState(cwd);
    if (!state) return;
    safeAssign(state.qualityGates, updates);
    saveState(cwd, state);
  });
}

/**
 * Request cancellation.
 */
export function requestCancel(cwd: string, preserveForResume: boolean = false): void {
  withStateLock(cwd, () => {
    const state = loadPipelineState(cwd);
    if (!state) return;
    state.cancel = {
      requested: true,
      requestedAt: new Date().toISOString(),
      preserveForResume,
    };
    saveState(cwd, state);
  });
}

// ============================================================
// STATE QUERIES
// ============================================================

/**
 * Check if pipeline is active.
 */
export function isActive(cwd: string): boolean {
  const state = loadPipelineState(cwd);
  return state?.active ?? false;
}

/**
 * Check if pipeline can be resumed.
 */
export function canResume(cwd: string): boolean {
  const state = loadPipelineState(cwd);
  if (!state) return false;
  return state.active || state.cancel.preserveForResume;
}

/**
 * Get a summary of the pipeline state.
 */
export function getStateSummary(cwd: string): string | null {
  const state = loadPipelineState(cwd);
  if (!state) return null;

  const lines: string[] = [
    `Pipeline: ${state.phase} (${state.active ? 'active' : 'inactive'})`,
    `Iteration: ${state.iteration}/${state.maxIterations}`,
    `Workers: ${state.execution.workersActive}/${state.execution.workersTotal}`,
    `Tasks: ${state.execution.tasksCompleted}/${state.execution.tasksTotal} completed, ${state.execution.tasksFailed} failed`,
    `Kanban: ${state.kanban.inProgress} in-progress, ${state.kanban.review} review, ${state.kanban.done} done`,
    `Quality: ${state.qualityGates.passed} passed, ${state.qualityGates.failed} failed`,
  ];

  if (state.fixLoop.attempt > 0) {
    lines.push(`Fix Loop: attempt ${state.fixLoop.attempt}/${state.fixLoop.maxAttempts}`);
  }

  return lines.join('\n');
}
