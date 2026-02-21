/**
 * Quality Gate scoring unit tests (pure functions only)
 *
 * Tests: calculateScore, determineVerdict, formatGateResult.
 * DB-dependent functions are tested separately.
 */
import { describe, it, expect } from 'vitest';
import {
  calculateScore,
  determineVerdict,
  formatGateResult,
  GATE_DEFINITIONS,
} from '../../src/quality/gates.js';
import type { ReviewDimensions, QualityGateResult } from '../../src/shared/types.js';

// ============================================================
// CALCULATE SCORE
// ============================================================

describe('calculateScore', () => {
  it('should calculate average of all dimensions', () => {
    const dims: ReviewDimensions = {
      correctness: 8,
      security: 6,
      performance: 7,
      maintainability: 9,
      testCoverage: 5,
    };
    expect(calculateScore(dims)).toBe(7); // (8+6+7+9+5)/5 = 35/5
  });

  it('should handle perfect scores', () => {
    const dims: ReviewDimensions = {
      correctness: 10,
      security: 10,
      performance: 10,
      maintainability: 10,
      testCoverage: 10,
    };
    expect(calculateScore(dims)).toBe(10);
  });

  it('should handle minimum scores', () => {
    const dims: ReviewDimensions = {
      correctness: 1,
      security: 1,
      performance: 1,
      maintainability: 1,
      testCoverage: 1,
    };
    expect(calculateScore(dims)).toBe(1);
  });

  it('should handle mixed scores correctly', () => {
    const dims: ReviewDimensions = {
      correctness: 10,
      security: 1,
      performance: 5,
      maintainability: 8,
      testCoverage: 6,
    };
    expect(calculateScore(dims)).toBe(6); // (10+1+5+8+6)/5 = 30/5
  });
});

// ============================================================
// DETERMINE VERDICT
// ============================================================

describe('determineVerdict', () => {
  it('should return pass for high scores with all dims >= 3', () => {
    const dims: ReviewDimensions = {
      correctness: 8,
      security: 7,
      performance: 8,
      maintainability: 7,
      testCoverage: 7,
    };
    expect(determineVerdict(7.4, dims)).toBe('pass');
  });

  it('should return conditional for score 5.0-6.9', () => {
    const dims: ReviewDimensions = {
      correctness: 6,
      security: 6,
      performance: 5,
      maintainability: 7,
      testCoverage: 6,
    };
    expect(determineVerdict(6.0, dims)).toBe('conditional');
  });

  it('should return reject for score 3.0-4.9', () => {
    const dims: ReviewDimensions = {
      correctness: 4,
      security: 4,
      performance: 4,
      maintainability: 5,
      testCoverage: 3,
    };
    expect(determineVerdict(4.0, dims)).toBe('reject');
  });

  it('should return auto-reject for score < 3.0', () => {
    const dims: ReviewDimensions = {
      correctness: 2,
      security: 2,
      performance: 2,
      maintainability: 3,
      testCoverage: 1,
    };
    expect(determineVerdict(2.0, dims)).toBe('auto-reject');
  });

  it('should not pass if any dimension < 3 even with high avg', () => {
    const dims: ReviewDimensions = {
      correctness: 10,
      security: 2,    // below min dimension threshold
      performance: 10,
      maintainability: 10,
      testCoverage: 10,
    };
    // avg = 8.4, but min dim = 2 < 3
    expect(determineVerdict(8.4, dims)).not.toBe('pass');
  });

  it('should return pass at exactly 7.0 with all dims >= 3', () => {
    const dims: ReviewDimensions = {
      correctness: 7,
      security: 7,
      performance: 7,
      maintainability: 7,
      testCoverage: 7,
    };
    expect(determineVerdict(7.0, dims)).toBe('pass');
  });

  it('should return conditional at exactly 5.0', () => {
    const dims: ReviewDimensions = {
      correctness: 5,
      security: 5,
      performance: 5,
      maintainability: 5,
      testCoverage: 5,
    };
    expect(determineVerdict(5.0, dims)).toBe('conditional');
  });
});

// ============================================================
// GATE DEFINITIONS
// ============================================================

describe('GATE_DEFINITIONS', () => {
  it('should define 5 gate types', () => {
    const types = Object.keys(GATE_DEFINITIONS);
    expect(types).toHaveLength(5);
    expect(types).toContain('design-review');
    expect(types).toContain('code-review');
    expect(types).toContain('qa-review');
    expect(types).toContain('security-review');
    expect(types).toContain('pl-approval');
  });

  it('should have code-review cover all dimensions', () => {
    const codeReview = GATE_DEFINITIONS['code-review'];
    expect(codeReview.requiredDimensions).toContain('correctness');
    expect(codeReview.requiredDimensions).toContain('security');
    expect(codeReview.requiredDimensions).toContain('performance');
    expect(codeReview.requiredDimensions).toContain('maintainability');
    expect(codeReview.requiredDimensions).toContain('testCoverage');
  });

  it('should have security-review with higher min dimension score', () => {
    const secReview = GATE_DEFINITIONS['security-review'];
    expect(secReview.minDimensionScore).toBe(5);
    expect(secReview.minDimensionScore).toBeGreaterThan(
      GATE_DEFINITIONS['code-review'].minDimensionScore
    );
  });

  it('should have pl-approval with lower min score', () => {
    const plApproval = GATE_DEFINITIONS['pl-approval'];
    expect(plApproval.minScore).toBe(6.0);
    expect(plApproval.minScore).toBeLessThan(GATE_DEFINITIONS['code-review'].minScore);
  });
});

// ============================================================
// FORMAT GATE RESULT
// ============================================================

describe('formatGateResult', () => {
  it('should format a result as human-readable text', () => {
    const result: QualityGateResult = {
      id: 'gate-1',
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      taskId: 'task-1',
      score: 7.5,
      dimensions: {
        correctness: 8,
        security: 7,
        performance: 7,
        maintainability: 8,
        testCoverage: 7,
      },
      verdict: 'pass',
      feedback: 'Good work overall.',
      attempt: 1,
      maxAttempts: 3,
      createdAt: '2026-01-01T00:00:00Z',
    };

    const formatted = formatGateResult(result);
    expect(formatted).toContain('code-review');
    expect(formatted).toContain('PASS');
    expect(formatted).toContain('7.5');
    expect(formatted).toContain('Attempt: 1/3');
    expect(formatted).toContain('Good work overall');
  });

  it('should omit feedback line when empty', () => {
    const result: QualityGateResult = {
      id: 'gate-2',
      gateType: 'qa-review',
      reviewerRole: 'qa-engineer',
      taskId: 'task-2',
      score: 4.0,
      dimensions: {
        correctness: 4,
        security: 4,
        performance: 4,
        maintainability: 4,
        testCoverage: 4,
      },
      verdict: 'reject',
      feedback: '',
      attempt: 2,
      maxAttempts: 3,
      createdAt: '2026-01-01T00:00:00Z',
    };

    const formatted = formatGateResult(result);
    expect(formatted).not.toContain('Feedback:');
  });
});
