/**
 * Review Scorer unit tests
 *
 * Tests: Codex prompt building, response parsing, score aggregation.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCodexReviewPrompt,
  parseCodexResponse,
  buildRoleReviewPrompt,
  aggregateScores,
} from '../../src/quality/review-scorer.js';

// ============================================================
// BUILD CODEX REVIEW PROMPT
// ============================================================

describe('buildCodexReviewPrompt', () => {
  it('should include review type in prompt', () => {
    const prompt = buildCodexReviewPrompt('code-review', ['src/app.ts'], 'diff content');
    expect(prompt).toContain('code-review');
  });

  it('should list changed files', () => {
    const prompt = buildCodexReviewPrompt('qa-review', ['src/a.ts', 'src/b.ts'], 'diff');
    expect(prompt).toContain('- src/a.ts');
    expect(prompt).toContain('- src/b.ts');
  });

  it('should include diff content', () => {
    const prompt = buildCodexReviewPrompt('code-review', [], '+added line\n-removed line');
    expect(prompt).toContain('+added line');
    expect(prompt).toContain('-removed line');
  });

  it('should include additional context when provided', () => {
    const prompt = buildCodexReviewPrompt('security-review', [], 'diff', 'This handles auth tokens');
    expect(prompt).toContain('Additional Context');
    expect(prompt).toContain('This handles auth tokens');
  });

  it('should not include context section when omitted', () => {
    const prompt = buildCodexReviewPrompt('code-review', [], 'diff');
    expect(prompt).not.toContain('Additional Context');
  });

  it('should include JSON response format instructions', () => {
    const prompt = buildCodexReviewPrompt('code-review', [], 'diff');
    expect(prompt).toContain('"correctness"');
    expect(prompt).toContain('"security"');
    expect(prompt).toContain('"feedback"');
  });
});

// ============================================================
// PARSE CODEX RESPONSE
// ============================================================

describe('parseCodexResponse', () => {
  it('should parse clean JSON response', () => {
    const response = JSON.stringify({
      correctness: 8,
      security: 7,
      performance: 9,
      maintainability: 8,
      testCoverage: 6,
      feedback: 'Good implementation with minor test gaps.',
    });

    const result = parseCodexResponse(response);
    expect(result.dimensions.correctness).toBe(8);
    expect(result.dimensions.security).toBe(7);
    expect(result.dimensions.performance).toBe(9);
    expect(result.dimensions.maintainability).toBe(8);
    expect(result.dimensions.testCoverage).toBe(6);
    expect(result.feedback).toBe('Good implementation with minor test gaps.');
    expect(result.score).toBe(7.6); // (8+7+9+8+6)/5
    expect(result.verdict).toBe('pass');
    expect(result.parseError).toBeUndefined();
  });

  it('should parse JSON embedded in markdown', () => {
    const response = `Here is my review:
\`\`\`json
{"correctness": 6, "security": 5, "performance": 6, "maintainability": 7, "testCoverage": 4, "feedback": "Needs work"}
\`\`\`
That's my assessment.`;

    const result = parseCodexResponse(response);
    expect(result.dimensions.correctness).toBe(6);
    expect(result.feedback).toBe('Needs work');
  });

  it('should handle missing dimensions with defaults', () => {
    const response = JSON.stringify({
      correctness: 8,
      feedback: 'Partial review',
    });

    const result = parseCodexResponse(response);
    expect(result.dimensions.correctness).toBe(8);
    expect(result.dimensions.security).toBe(5);      // default
    expect(result.dimensions.performance).toBe(5);    // default
    expect(result.dimensions.maintainability).toBe(5); // default
    expect(result.dimensions.testCoverage).toBe(5);    // default
  });

  it('should handle test_coverage alias', () => {
    const response = JSON.stringify({
      correctness: 7, security: 7, performance: 7,
      maintainability: 7, test_coverage: 8,
      feedback: 'Good',
    });

    const result = parseCodexResponse(response);
    expect(result.dimensions.testCoverage).toBe(8);
  });

  it('should clamp scores to 1-10 range', () => {
    const response = JSON.stringify({
      correctness: 15,
      security: -2,
      performance: 0,
      maintainability: 11,
      testCoverage: 10,
      feedback: 'Weird scores',
    });

    const result = parseCodexResponse(response);
    expect(result.dimensions.correctness).toBe(10);
    expect(result.dimensions.security).toBe(1);
    expect(result.dimensions.performance).toBe(1);
    expect(result.dimensions.maintainability).toBe(10);
    expect(result.dimensions.testCoverage).toBe(10);
  });

  it('should return default response when no JSON found', () => {
    const result = parseCodexResponse('This response has no JSON at all.');
    expect(result.parseError).toBeDefined();
    expect(result.parseError).toContain('No JSON');
    expect(result.dimensions.correctness).toBe(3);
    expect(result.verdict).toBe('reject');
  });

  it('should return default response for invalid JSON', () => {
    const result = parseCodexResponse('{broken json!!!}');
    expect(result.parseError).toBeDefined();
    expect(result.dimensions.correctness).toBe(3);
  });

  it('should handle missing feedback gracefully', () => {
    const response = JSON.stringify({
      correctness: 7, security: 7, performance: 7,
      maintainability: 7, testCoverage: 7,
    });

    const result = parseCodexResponse(response);
    expect(result.feedback).toBe('No feedback provided');
  });
});

// ============================================================
// BUILD ROLE REVIEW PROMPT
// ============================================================

describe('buildRoleReviewPrompt', () => {
  it('should include QA-specific focus areas for qa-engineer', () => {
    const prompt = buildRoleReviewPrompt('qa-engineer', 'Fix login', ['src/auth.ts'], 'diff');
    expect(prompt).toContain('Riley');
    expect(prompt).toContain('Test coverage completeness');
    expect(prompt).toContain('Edge case handling');
  });

  it('should include security focus areas for security-specialist', () => {
    const prompt = buildRoleReviewPrompt('security-specialist', 'Auth flow', ['src/auth.ts'], 'diff');
    expect(prompt).toContain('Avery');
    expect(prompt).toContain('Injection vulnerabilities');
    expect(prompt).toContain('Sensitive data exposure');
  });

  it('should include PL focus areas', () => {
    const prompt = buildRoleReviewPrompt('pl', 'API redesign', ['src/api/'], 'diff');
    expect(prompt).toContain('Jordan');
    expect(prompt).toContain('Architecture alignment');
  });

  it('should handle unknown reviewer roles with defaults', () => {
    const prompt = buildRoleReviewPrompt('fe-dev', 'UI fix', ['src/ui.tsx'], 'diff');
    expect(prompt).toContain('Code correctness');
  });

  it('should include task subject in prompt', () => {
    const prompt = buildRoleReviewPrompt('qa-engineer', 'Implement user authentication', [], 'diff');
    expect(prompt).toContain('Implement user authentication');
  });
});

// ============================================================
// AGGREGATE SCORES
// ============================================================

describe('aggregateScores', () => {
  it('should return zeros for empty reviews', () => {
    const result = aggregateScores([]);
    expect(result.score).toBe(0);
    expect(result.verdict).toBe('auto-reject');
  });

  it('should return exact scores for a single review', () => {
    const result = aggregateScores([{
      reviewerRole: 'pl',
      dimensions: { correctness: 8, security: 7, performance: 8, maintainability: 9, testCoverage: 7 },
    }]);
    expect(result.dimensions.correctness).toBe(8);
    expect(result.dimensions.security).toBe(7);
  });

  it('should weight security-specialist reviews higher', () => {
    const result = aggregateScores([
      {
        reviewerRole: 'security-specialist',
        dimensions: { correctness: 6, security: 3, performance: 6, maintainability: 6, testCoverage: 6 },
      },
      {
        reviewerRole: 'fe-dev',
        dimensions: { correctness: 8, security: 8, performance: 8, maintainability: 8, testCoverage: 8 },
      },
    ]);

    // Security-specialist weight 1.5, fe-dev weight 1.0, total 2.5
    // security: (3*1.5 + 8*1.0) / 2.5 = 12.5/2.5 = 5.0
    expect(result.dimensions.security).toBe(5);
  });

  it('should weight qa-engineer reviews at 1.3x', () => {
    const result = aggregateScores([
      {
        reviewerRole: 'qa-engineer',
        dimensions: { correctness: 10, security: 10, performance: 10, maintainability: 10, testCoverage: 10 },
      },
      {
        reviewerRole: 'be-dev',
        dimensions: { correctness: 5, security: 5, performance: 5, maintainability: 5, testCoverage: 5 },
      },
    ]);

    // qa: 1.3, be-dev: 1.0, total: 2.3
    // Each dim: (10*1.3 + 5*1.0) / 2.3 = 18/2.3 ≈ 7.826 → rounded to 7.8
    expect(result.dimensions.correctness).toBeCloseTo(7.8, 0);
  });

  it('should produce correct verdict from aggregated scores', () => {
    const result = aggregateScores([
      {
        reviewerRole: 'qa-engineer',
        dimensions: { correctness: 8, security: 8, performance: 8, maintainability: 8, testCoverage: 8 },
      },
      {
        reviewerRole: 'security-specialist',
        dimensions: { correctness: 7, security: 7, performance: 7, maintainability: 7, testCoverage: 7 },
      },
    ]);

    expect(result.verdict).toBe('pass');
  });
});
