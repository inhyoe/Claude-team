/**
 * Integration test: Escalation Pipeline
 *
 * End-to-end test exercising determineEscalation with real SQLite DB:
 *   initDb → seed project/task → insert gate results → verify escalation decisions
 *
 * Key: attempt = history.length (number of gate results in DB for the same gateType).
 * The latestResult passed to determineEscalation is NOT yet in DB.
 *
 * Requires better-sqlite3 (runtime dependency).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { initDb, getDb, closeDb } from '../../src/persistence/db.js';
import { createTask } from '../../src/persistence/tasks-repo.js';
import { createGateResult } from '../../src/persistence/quality-gates-repo.js';
import { determineEscalation } from '../../src/quality/escalation.js';
import type { QualityGateResult } from '../../src/shared/types.js';
import { MAX_REVIEW_ATTEMPTS } from '../../src/shared/constants.js';

let tmpDir: string;
const PROJECT_ID = 'proj-esc-test';

function makeGateResult(overrides: Partial<QualityGateResult> & { id: string; taskId: string; attempt: number }): QualityGateResult {
  return {
    gateType: 'code-review',
    reviewerRole: 'qa-engineer',
    score: 5.0,
    dimensions: { correctness: 5, security: 5, performance: 5, maintainability: 5, testCoverage: 5 },
    verdict: 'reject',
    feedback: 'Needs improvement',
    maxAttempts: MAX_REVIEW_ATTEMPTS,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================
// DB LIFECYCLE
// ============================================================

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ct-esc-integ-'));
  const ok = await initDb(tmpDir);
  expect(ok).toBe(true);

  // Seed project row for FK constraints
  const db = getDb(tmpDir)!;
  db.prepare(`
    INSERT INTO projects (id, name, path, session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `).run(PROJECT_ID, 'Escalation Test', tmpDir, 'session-esc');

  // Create tasks for escalation testing
  createTask(tmpDir, PROJECT_ID, { id: 'esc-task-1', title: 'Task for retry path', priority: 1, assignedRole: 'be-dev' });
  createTask(tmpDir, PROJECT_ID, { id: 'esc-task-2', title: 'Task for upgrade path', priority: 1, assignedRole: 'fe-dev' });
  createTask(tmpDir, PROJECT_ID, { id: 'esc-task-3', title: 'Task for escalate path', priority: 1, assignedRole: 'be-dev' });
  createTask(tmpDir, PROJECT_ID, { id: 'esc-task-4', title: 'Task for auto-reject', priority: 1, assignedRole: 'be-dev' });
  createTask(tmpDir, PROJECT_ID, { id: 'esc-task-5', title: 'Task for attempt=0', priority: 1, assignedRole: 'be-dev' });
  createTask(tmpDir, PROJECT_ID, { id: 'esc-task-6', title: 'Task for pass', priority: 1, assignedRole: 'be-dev' });
});

afterAll(() => {
  closeDb(tmpDir);
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// FIRST FAILURE → RETRY (attempt=1, DB has 1 prior result)
// ============================================================

describe('escalation: first failure retry', () => {
  it('should return retry action on first reject', () => {
    // Insert 1 gate result into DB so attempt=1
    createGateResult(tmpDir, PROJECT_ID, makeGateResult({
      id: 'gate-esc-1a',
      taskId: 'esc-task-1',
      score: 4.5,
      verdict: 'reject',
      attempt: 1,
    }));

    const latestResult = makeGateResult({
      id: 'gate-esc-1b',
      taskId: 'esc-task-1',
      score: 4.5,
      verdict: 'reject',
      attempt: 2,
    });

    // DB has 1 code-review result → attempt=1 → "First failure"
    const decision = determineEscalation(tmpDir, 'esc-task-1', 'code-review', latestResult);

    expect(decision.action).toBe('retry');
    expect(decision.reason).toContain('First attempt');
    expect(decision.context.attempt).toBe(1);
    expect(decision.context.lastVerdict).toBe('reject');
    expect(decision.context.lastScore).toBe(4.5);
  });
});

// ============================================================
// SECOND CONDITIONAL → UPGRADE MODEL (attempt=2, DB has 2 prior results)
// ============================================================

describe('escalation: second conditional upgrades model', () => {
  it('should return upgrade-model on second conditional verdict', () => {
    // Insert 2 gate results into DB so attempt=2
    createGateResult(tmpDir, PROJECT_ID, makeGateResult({
      id: 'gate-esc-2a',
      taskId: 'esc-task-2',
      score: 5.5,
      verdict: 'conditional',
      attempt: 1,
    }));
    createGateResult(tmpDir, PROJECT_ID, makeGateResult({
      id: 'gate-esc-2b',
      taskId: 'esc-task-2',
      score: 6.0,
      verdict: 'conditional',
      attempt: 2,
    }));

    // Third attempt (latest, not in DB yet)
    const latestResult = makeGateResult({
      id: 'gate-esc-2c',
      taskId: 'esc-task-2',
      score: 6.2,
      verdict: 'conditional',
      attempt: 3,
    });

    // DB has 2 code-review results → attempt=2 → "Second conditional"
    const decision = determineEscalation(tmpDir, 'esc-task-2', 'code-review', latestResult);

    expect(decision.action).toBe('upgrade-model');
    expect(decision.reason).toContain('opus');
    expect(decision.context.attempt).toBe(2);
  });
});

// ============================================================
// THREE FAILURES → ESCALATE PL (attempt>=3, DB has 3+ prior results)
// ============================================================

describe('escalation: three failures escalate to PL', () => {
  it('should escalate to PL after max attempts exhausted', () => {
    // Insert 3 gate results into DB so attempt=3 (>= MAX_REVIEW_ATTEMPTS)
    createGateResult(tmpDir, PROJECT_ID, makeGateResult({
      id: 'gate-esc-3a',
      taskId: 'esc-task-3',
      score: 3.5,
      verdict: 'reject',
      attempt: 1,
    }));
    createGateResult(tmpDir, PROJECT_ID, makeGateResult({
      id: 'gate-esc-3b',
      taskId: 'esc-task-3',
      score: 3.0,
      verdict: 'reject',
      attempt: 2,
    }));
    createGateResult(tmpDir, PROJECT_ID, makeGateResult({
      id: 'gate-esc-3c',
      taskId: 'esc-task-3',
      score: 3.2,
      verdict: 'reject',
      attempt: 3,
    }));

    // Fourth attempt (latest, not in DB)
    const latestResult = makeGateResult({
      id: 'gate-esc-3d',
      taskId: 'esc-task-3',
      score: 3.5,
      verdict: 'reject',
      attempt: 4,
    });

    // DB has 3 results → attempt=3 >= MAX_REVIEW_ATTEMPTS → escalate-pl
    // Scores: 3.5, 3.0, 3.2 — NOT consistently improving (3.5 → 3.0 is a drop)
    const decision = determineEscalation(tmpDir, 'esc-task-3', 'code-review', latestResult);

    expect(decision.action).toBe('escalate-pl');
    expect(decision.targetRole).toBe('pl');
    expect(decision.context.attempt).toBe(3);
    expect(decision.reason).toContain('exhausted');
  });
});

// ============================================================
// AUTO-REJECT → IMMEDIATE ESCALATION
// ============================================================

describe('escalation: auto-reject immediate escalation', () => {
  it('should escalate immediately on auto-reject regardless of attempt count', () => {
    const latestResult = makeGateResult({
      id: 'gate-esc-4',
      taskId: 'esc-task-4',
      score: 2.0,
      verdict: 'auto-reject',
      attempt: 1,
    });

    // No prior DB results needed — auto-reject always escalates immediately
    const decision = determineEscalation(tmpDir, 'esc-task-4', 'code-review', latestResult);

    expect(decision.action).toBe('escalate-pl');
    expect(decision.reason).toContain('Auto-reject');
    expect(decision.targetRole).toBe('pl');
    expect(decision.suggestedGuidance).toBeDefined();
  });
});

// ============================================================
// ATTEMPT=0 (no DB history) → RETRY (not accept-risk)
// ============================================================

describe('escalation: attempt=0 with no DB history', () => {
  it('should return retry (not accept-risk) when DB has no prior gate results', () => {
    // esc-task-5 has NO gate results in DB → attempt=0
    // Before fix, this fell through to accept-risk (bug)
    const latestResult = makeGateResult({
      id: 'gate-esc-zero',
      taskId: 'esc-task-5',
      score: 4.0,
      verdict: 'reject',
      attempt: 1,
    });

    const decision = determineEscalation(tmpDir, 'esc-task-5', 'code-review', latestResult);

    expect(decision.action).toBe('retry');
    expect(decision.reason).toContain('First attempt');
  });
});

// ============================================================
// PASS → NO ESCALATION
// ============================================================

describe('escalation: pass verdict no escalation', () => {
  it('should return accept-risk on pass verdict', () => {
    const latestResult = makeGateResult({
      id: 'gate-esc-6',
      taskId: 'esc-task-6',
      score: 8.5,
      verdict: 'pass',
      attempt: 1,
    });

    const decision = determineEscalation(tmpDir, 'esc-task-6', 'code-review', latestResult);

    // Pass should return accept-risk (no escalation needed)
    expect(decision.action).toBe('accept-risk');
    expect(decision.reason).toContain('No escalation needed');
  });
});
