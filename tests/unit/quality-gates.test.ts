/**
 * Quality Gates unit tests
 *
 * Tests: scoring calculation, verdict determination, gate evaluation,
 * retry logic, exhaustion detection, gate summaries, pending gates.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  calculateScore,
  determineVerdict,
  evaluateGate,
  hasPassedGate,
  isGateExhausted,
  getGateSummary,
  getPendingGates,
  formatGateResult,
  GATE_DEFINITIONS,
} from '../../src/quality/gates.js';
import type { ReviewDimensions, GateType } from '../../src/shared/types.js';
import { initDb, getDb, closeDb } from '../../src/persistence/db.js';

let testDir: string;
const projectId = 'test-proj';
let taskCounter = 0;

/** Seed a project row and return db handle for creating tasks. */
function seedProject(dir: string): void {
  const db = getDb(dir)!;
  db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, path, session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `).run(projectId, 'Test Project', dir, 'session-gates-test');
}

/** Seed a task row so FK constraints pass for quality_gates inserts. */
function seedTask(dir: string, taskId: string): void {
  const db = getDb(dir)!;
  const ts = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO tasks (id, project_id, title, kanban_status, priority, created_at, updated_at, moved_at)
    VALUES (?, ?, ?, 'in-progress', 3, ?, ?, ?)
  `).run(taskId, projectId, `Test task ${taskId}`, ts, ts, ts);
}

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'ct-gates-test-'));
  await initDb(testDir);
  seedProject(testDir);
  // Pre-seed all task IDs used across tests so FK constraints pass
  for (let i = 1; i <= 20; i++) {
    seedTask(testDir, `task-${i}`);
  }
});

afterEach(() => {
  if (testDir) {
    closeDb(testDir);
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================
// SCORING
// ============================================================

describe('calculateScore', () => {
  it('returns average of all dimension scores', () => {
    const dims: ReviewDimensions = {
      correctness: 8,
      security: 6,
      performance: 7,
      maintainability: 9,
      testCoverage: 5,
    };
    const score = calculateScore(dims);
    expect(score).toBe((8 + 6 + 7 + 9 + 5) / 5);
  });

  it('handles perfect scores', () => {
    const dims: ReviewDimensions = {
      correctness: 10,
      security: 10,
      performance: 10,
      maintainability: 10,
      testCoverage: 10,
    };
    expect(calculateScore(dims)).toBe(10);
  });

  it('handles zero scores', () => {
    const dims: ReviewDimensions = {
      correctness: 0,
      security: 0,
      performance: 0,
      maintainability: 0,
      testCoverage: 0,
    };
    expect(calculateScore(dims)).toBe(0);
  });
});

// ============================================================
// VERDICT DETERMINATION
// ============================================================

describe('determineVerdict', () => {
  it('returns pass when score >= 7.0 and all dimensions >= 3', () => {
    const verdict = determineVerdict(7.5, {
      correctness: 8,
      security: 7,
      performance: 7,
      maintainability: 8,
      testCoverage: 6,
    });
    expect(verdict).toBe('pass');
  });

  it('returns conditional when score >= 5.0 but < 7.0', () => {
    const verdict = determineVerdict(6.0, {
      correctness: 6,
      security: 6,
      performance: 6,
      maintainability: 6,
      testCoverage: 6,
    });
    expect(verdict).toBe('conditional');
  });

  it('returns reject when score >= 3.0 but < 5.0', () => {
    const verdict = determineVerdict(4.0, {
      correctness: 4,
      security: 4,
      performance: 4,
      maintainability: 4,
      testCoverage: 4,
    });
    expect(verdict).toBe('reject');
  });

  it('returns auto-reject when score < 3.0', () => {
    const verdict = determineVerdict(2.0, {
      correctness: 2,
      security: 2,
      performance: 2,
      maintainability: 2,
      testCoverage: 2,
    });
    expect(verdict).toBe('auto-reject');
  });

  it('returns conditional when score is high but one dimension is too low', () => {
    const verdict = determineVerdict(8.0, {
      correctness: 10,
      security: 10,
      performance: 10,
      maintainability: 10,
      testCoverage: 2, // Below minimum threshold of 3
    });
    expect(verdict).toBe('conditional');
  });

  it('handles edge case: score exactly 7.0 and min dimension exactly 3', () => {
    const verdict = determineVerdict(7.0, {
      correctness: 8,
      security: 8,
      performance: 8,
      maintainability: 8,
      testCoverage: 3, // Exactly at threshold
    });
    expect(verdict).toBe('pass');
  });
});

// ============================================================
// GATE EVALUATION
// ============================================================

describe('evaluateGate', () => {
  it('creates a gate result with correct verdict', () => {
    const result = evaluateGate({
      cwd: testDir,
      projectId,
      taskId: 'task-1',
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      dimensions: {
        correctness: 8,
        security: 7,
        performance: 7,
        maintainability: 8,
        testCoverage: 8,
      },
      feedback: 'Looks good',
    });

    expect(result.verdict).toBe('pass');
    expect(result.result.gateType).toBe('code-review');
    expect(result.result.reviewerRole).toBe('qa-engineer');
    expect(result.result.taskId).toBe('task-1');
    expect(result.result.attempt).toBe(1);
    expect(result.canRetry).toBe(false); // Pass means no retry needed
    expect(result.needsEscalation).toBe(false);
  });

  it('increments attempt count on subsequent evaluations', () => {
    // First attempt
    evaluateGate({
      cwd: testDir,
      projectId,
      taskId: 'task-2',
      gateType: 'qa-review',
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 4, security: 4, performance: 4, maintainability: 4, testCoverage: 4 },
      feedback: 'Needs work',
    });

    // Second attempt
    const result = evaluateGate({
      cwd: testDir,
      projectId,
      taskId: 'task-2',
      gateType: 'qa-review',
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 5, security: 5, performance: 5, maintainability: 5, testCoverage: 5 },
      feedback: 'Better but not passing',
    });

    expect(result.result.attempt).toBe(2);
  });

  it('allows retry when verdict is not pass and attempts remain', () => {
    const result = evaluateGate({
      cwd: testDir,
      projectId,
      taskId: 'task-3',
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 5, security: 5, performance: 5, maintainability: 5, testCoverage: 5 },
      feedback: 'Conditional',
    });

    expect(result.verdict).toBe('conditional');
    expect(result.canRetry).toBe(true);
    expect(result.attemptsRemaining).toBe(2); // Default max is 3
  });

  it('sets needsEscalation when auto-reject verdict', () => {
    const result = evaluateGate({
      cwd: testDir,
      projectId,
      taskId: 'task-4',
      gateType: 'security-review',
      reviewerRole: 'security-specialist',
      dimensions: { correctness: 1, security: 1, performance: 1, maintainability: 1, testCoverage: 1 },
      feedback: 'Critical issues',
    });

    expect(result.verdict).toBe('auto-reject');
    expect(result.needsEscalation).toBe(true);
  });

  it('sets needsEscalation when max attempts exhausted without pass', () => {
    const taskId = 'task-5';
    const gateType: GateType = 'code-review';

    // Exhaust all 3 attempts
    for (let i = 0; i < 3; i++) {
      evaluateGate({
        cwd: testDir,
        projectId,
        taskId,
        gateType,
        reviewerRole: 'qa-engineer',
        dimensions: { correctness: 5, security: 5, performance: 5, maintainability: 5, testCoverage: 5 },
        feedback: `Attempt ${i + 1}`,
      });
    }

    const result = evaluateGate({
      cwd: testDir,
      projectId,
      taskId,
      gateType,
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 5, security: 5, performance: 5, maintainability: 5, testCoverage: 5 },
      feedback: 'Still not passing',
    });

    expect(result.canRetry).toBe(false);
    expect(result.attemptsRemaining).toBe(0);
    expect(result.needsEscalation).toBe(true);
  });
});

// ============================================================
// GATE STATUS QUERIES
// ============================================================

describe('hasPassedGate', () => {
  it('returns true when task has passed the gate', () => {
    evaluateGate({
      cwd: testDir,
      projectId,
      taskId: 'task-6',
      gateType: 'qa-review',
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 8, security: 8, performance: 8, maintainability: 8, testCoverage: 8 },
      feedback: 'Pass',
    });

    expect(hasPassedGate(testDir, 'task-6', 'qa-review')).toBe(true);
  });

  it('returns false when task has not passed the gate', () => {
    evaluateGate({
      cwd: testDir,
      projectId,
      taskId: 'task-7',
      gateType: 'qa-review',
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 4, security: 4, performance: 4, maintainability: 4, testCoverage: 4 },
      feedback: 'Reject',
    });

    expect(hasPassedGate(testDir, 'task-7', 'qa-review')).toBe(false);
  });

  it('returns false when no gate result exists', () => {
    expect(hasPassedGate(testDir, 'nonexistent', 'qa-review')).toBe(false);
  });

  it('returns true if latest attempt is pass even with prior failures', () => {
    // First attempt: fail
    evaluateGate({
      cwd: testDir,
      projectId,
      taskId: 'task-8',
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 4, security: 4, performance: 4, maintainability: 4, testCoverage: 4 },
      feedback: 'First fail',
    });

    // Second attempt: pass
    evaluateGate({
      cwd: testDir,
      projectId,
      taskId: 'task-8',
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 8, security: 8, performance: 8, maintainability: 8, testCoverage: 8 },
      feedback: 'Now pass',
    });

    expect(hasPassedGate(testDir, 'task-8', 'code-review')).toBe(true);
  });
});

describe('isGateExhausted', () => {
  it('returns true when max attempts reached without pass', () => {
    const taskId = 'task-9';
    const gateType: GateType = 'qa-review';

    for (let i = 0; i < 3; i++) {
      evaluateGate({
        cwd: testDir,
        projectId,
        taskId,
        gateType,
        reviewerRole: 'qa-engineer',
        dimensions: { correctness: 5, security: 5, performance: 5, maintainability: 5, testCoverage: 5 },
        feedback: 'Fail',
      });
    }

    expect(isGateExhausted(testDir, taskId, gateType)).toBe(true);
  });

  it('returns false when max attempts reached but passed', () => {
    const taskId = 'task-10';
    const gateType: GateType = 'qa-review';

    // 2 failures
    for (let i = 0; i < 2; i++) {
      evaluateGate({
        cwd: testDir,
        projectId,
        taskId,
        gateType,
        reviewerRole: 'qa-engineer',
        dimensions: { correctness: 5, security: 5, performance: 5, maintainability: 5, testCoverage: 5 },
        feedback: 'Fail',
      });
    }

    // 1 pass
    evaluateGate({
      cwd: testDir,
      projectId,
      taskId,
      gateType,
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 8, security: 8, performance: 8, maintainability: 8, testCoverage: 8 },
      feedback: 'Pass',
    });

    expect(isGateExhausted(testDir, taskId, gateType)).toBe(false);
  });

  it('returns false when attempts remain', () => {
    evaluateGate({
      cwd: testDir,
      projectId,
      taskId: 'task-11',
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 5, security: 5, performance: 5, maintainability: 5, testCoverage: 5 },
      feedback: 'One attempt',
    });

    expect(isGateExhausted(testDir, 'task-11', 'code-review')).toBe(false);
  });
});

describe('getGateSummary', () => {
  it('returns summary for task with multiple gate results', () => {
    const taskId = 'task-12';

    evaluateGate({
      cwd: testDir,
      projectId,
      taskId,
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 8, security: 8, performance: 8, maintainability: 8, testCoverage: 8 },
      feedback: 'Code pass',
    });

    evaluateGate({
      cwd: testDir,
      projectId,
      taskId,
      gateType: 'qa-review',
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 6, security: 6, performance: 6, maintainability: 6, testCoverage: 6 },
      feedback: 'QA conditional',
    });

    const summary = getGateSummary(testDir, taskId);

    expect(summary.gates['code-review'].passed).toBe(true);
    expect(summary.gates['code-review'].attempts).toBe(1);
    expect(summary.gates['qa-review'].passed).toBe(false);
    expect(summary.gates['qa-review'].attempts).toBe(1);
    expect(summary.allPassed).toBe(false);
    expect(summary.anyExhausted).toBe(false);
  });

  it('sets allPassed true when all evaluated gates passed', () => {
    const taskId = 'task-13';

    evaluateGate({
      cwd: testDir,
      projectId,
      taskId,
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 8, security: 8, performance: 8, maintainability: 8, testCoverage: 8 },
      feedback: 'Pass',
    });

    evaluateGate({
      cwd: testDir,
      projectId,
      taskId,
      gateType: 'qa-review',
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 8, security: 8, performance: 8, maintainability: 8, testCoverage: 8 },
      feedback: 'Pass',
    });

    const summary = getGateSummary(testDir, taskId);
    expect(summary.allPassed).toBe(true);
  });

  it('sets anyExhausted true when a gate is exhausted', () => {
    const taskId = 'task-14';
    const gateType: GateType = 'security-review';

    for (let i = 0; i < 3; i++) {
      evaluateGate({
        cwd: testDir,
        projectId,
        taskId,
        gateType,
        reviewerRole: 'security-specialist',
        dimensions: { correctness: 5, security: 5, performance: 5, maintainability: 5, testCoverage: 5 },
        feedback: 'Fail',
      });
    }

    const summary = getGateSummary(testDir, taskId);
    expect(summary.anyExhausted).toBe(true);
    expect(summary.gates['security-review'].attempts).toBe(3);
    expect(summary.gates['security-review'].passed).toBe(false);
  });
});

describe('getPendingGates', () => {
  it('returns gates that have not been passed', () => {
    const taskId = 'task-15';

    evaluateGate({
      cwd: testDir,
      projectId,
      taskId,
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 8, security: 8, performance: 8, maintainability: 8, testCoverage: 8 },
      feedback: 'Pass',
    });

    const requiredGates: GateType[] = ['code-review', 'qa-review', 'security-review'];
    const pending = getPendingGates(testDir, taskId, requiredGates);

    expect(pending).toContain('qa-review');
    expect(pending).toContain('security-review');
    expect(pending).not.toContain('code-review');
  });

  it('returns empty array when all required gates passed', () => {
    const taskId = 'task-16';

    evaluateGate({
      cwd: testDir,
      projectId,
      taskId,
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 8, security: 8, performance: 8, maintainability: 8, testCoverage: 8 },
      feedback: 'Pass',
    });

    evaluateGate({
      cwd: testDir,
      projectId,
      taskId,
      gateType: 'qa-review',
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 8, security: 8, performance: 8, maintainability: 8, testCoverage: 8 },
      feedback: 'Pass',
    });

    const requiredGates: GateType[] = ['code-review', 'qa-review'];
    const pending = getPendingGates(testDir, taskId, requiredGates);

    expect(pending).toHaveLength(0);
  });
});

// ============================================================
// FORMATTING
// ============================================================

describe('formatGateResult', () => {
  it('formats gate result as human-readable string', () => {
    const result = evaluateGate({
      cwd: testDir,
      projectId,
      taskId: 'task-17',
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      dimensions: { correctness: 8, security: 7, performance: 6, maintainability: 9, testCoverage: 7 },
      feedback: 'Good work',
    });

    const formatted = formatGateResult(result.result);

    expect(formatted).toContain('code-review');
    expect(formatted).toContain('PASS');
    expect(formatted).toContain('7.4'); // Average score
    expect(formatted).toContain('Correctness: 8');
    expect(formatted).toContain('Security: 7');
    expect(formatted).toContain('Good work');
    expect(formatted).toContain('Attempt: 1/3');
  });
});

// ============================================================
// GATE DEFINITIONS
// ============================================================

describe('GATE_DEFINITIONS', () => {
  it('defines all expected gate types', () => {
    expect(GATE_DEFINITIONS['design-review']).toBeDefined();
    expect(GATE_DEFINITIONS['code-review']).toBeDefined();
    expect(GATE_DEFINITIONS['qa-review']).toBeDefined();
    expect(GATE_DEFINITIONS['security-review']).toBeDefined();
    expect(GATE_DEFINITIONS['pl-approval']).toBeDefined();
  });

  it('security-review has higher minDimensionScore than others', () => {
    expect(GATE_DEFINITIONS['security-review'].minDimensionScore).toBe(5);
    expect(GATE_DEFINITIONS['code-review'].minDimensionScore).toBe(3);
  });

  it('all gates specify required dimensions', () => {
    for (const gate of Object.values(GATE_DEFINITIONS)) {
      expect(gate.requiredDimensions.length).toBeGreaterThan(0);
    }
  });
});
