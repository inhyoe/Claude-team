/**
 * Escalation logic unit tests
 *
 * Tests: applyPLDecision, formatEscalation (pure functions).
 * determineEscalation depends on DB, tested via integration.
 */
import { describe, it, expect } from 'vitest';
import {
  applyPLDecision,
  formatEscalation,
} from '../../src/quality/escalation.js';
import type { EscalationDecision, PLDecisionInput } from '../../src/quality/escalation.js';
import type { QualityGateResult } from '../../src/shared/types.js';

// ============================================================
// APPLY PL DECISION
// ============================================================

describe('applyPLDecision', () => {
  it('should return retry action for retry decision', () => {
    const result = applyPLDecision({
      taskId: 'task-1',
      gateType: 'code-review',
      history: [],
      decision: 'retry',
      reason: 'Worker can fix the remaining issues',
    });

    expect(result.action).toBe('retry');
    expect(result.guidance).toContain('PL authorized additional retry');
    expect(result.guidance).toContain('Worker can fix the remaining issues');
  });

  it('should return split-task action for split decision', () => {
    const result = applyPLDecision({
      taskId: 'task-1',
      gateType: 'code-review',
      history: [makeGateResult(4.0, 'reject')],
      decision: 'split',
      reason: 'Task too complex',
    });

    expect(result.action).toBe('split-task');
    expect(result.guidance).toContain('split task');
  });

  it('should return escalate-pm action for redesign decision', () => {
    const result = applyPLDecision({
      taskId: 'task-1',
      gateType: 'code-review',
      history: [],
      decision: 'redesign',
      reason: 'Architecture needs rethinking',
    });

    expect(result.action).toBe('escalate-pm');
    expect(result.guidance).toContain('redesign');
  });

  it('should return accept-risk action for accept decision', () => {
    const result = applyPLDecision({
      taskId: 'task-1',
      gateType: 'code-review',
      history: [],
      decision: 'accept',
      reason: 'Minor issues, deadline approaching',
    });

    expect(result.action).toBe('accept-risk');
    expect(result.guidance).toContain('accepted with risk');
    expect(result.guidance).toContain('Minor issues');
  });
});

// ============================================================
// FORMAT ESCALATION
// ============================================================

describe('formatEscalation', () => {
  it('should format escalation decision as readable text', () => {
    const decision: EscalationDecision = {
      action: 'escalate-pl',
      reason: '3 attempts exhausted, no improvement.',
      targetRole: 'pl',
      context: {
        taskId: 'task-42',
        gateType: 'code-review',
        attempt: 3,
        lastVerdict: 'reject',
        lastScore: 4.5,
        history: [],
      },
      suggestedGuidance: 'Consider splitting the task.',
    };

    const formatted = formatEscalation(decision);
    expect(formatted).toContain('ESCALATE-PL');
    expect(formatted).toContain('task-42');
    expect(formatted).toContain('code-review');
    expect(formatted).toContain('3/3');
    expect(formatted).toContain('4.5');
    expect(formatted).toContain('reject');
    expect(formatted).toContain('Consider splitting');
    expect(formatted).toContain('Target: pl');
  });

  it('should omit guidance line when not provided', () => {
    const decision: EscalationDecision = {
      action: 'retry',
      reason: 'First failure, retrying.',
      targetRole: 'be-dev',
      context: {
        taskId: 'task-1',
        gateType: 'qa-review',
        attempt: 1,
        lastVerdict: 'conditional',
        lastScore: 6.0,
        history: [],
      },
    };

    const formatted = formatEscalation(decision);
    expect(formatted).not.toContain('Guidance:');
  });
});

// ============================================================
// HELPERS
// ============================================================

function makeGateResult(score: number, verdict: 'pass' | 'conditional' | 'reject' | 'auto-reject'): QualityGateResult {
  return {
    id: `gate-${Date.now()}`,
    gateType: 'code-review',
    reviewerRole: 'qa-engineer',
    taskId: 'task-1',
    score,
    dimensions: {
      correctness: score,
      security: score,
      performance: score,
      maintainability: score,
      testCoverage: score,
    },
    verdict,
    feedback: `Score: ${score}`,
    attempt: 1,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
  };
}
