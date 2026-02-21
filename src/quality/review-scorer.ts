/**
 * Claude Team - Review Scorer
 *
 * Codex-powered review scoring logic.
 * Parses Codex review output into structured ReviewDimensions.
 */

import type {
  RoleType,
  GateType,
  GateVerdict,
  ReviewDimensions,
} from '../shared/types.js';
import { ROLE_DEFINITIONS } from '../shared/constants.js';
import { calculateScore, determineVerdict } from './gates.js';

// ============================================================
// CODEX REVIEW PROMPT
// ============================================================

/**
 * Build a review prompt for Codex to analyze code changes.
 */
export function buildCodexReviewPrompt(
  reviewType: GateType,
  changedFiles: string[],
  diffContent: string,
  context?: string
): string {
  return `You are a code reviewer performing a ${reviewType}.

## Files Changed
${changedFiles.map(f => `- ${f}`).join('\n')}

## Diff
\`\`\`
${diffContent}
\`\`\`

${context ? `## Additional Context\n${context}\n` : ''}

## Instructions
Review the code changes and provide a structured quality assessment.
Score each dimension from 1-10 where:
- 1-3: Serious issues, needs significant rework
- 4-6: Acceptable but improvements needed
- 7-8: Good quality, minor suggestions
- 9-10: Excellent, production-ready

Respond with ONLY valid JSON in this exact format:
{
  "correctness": <1-10>,
  "security": <1-10>,
  "performance": <1-10>,
  "maintainability": <1-10>,
  "testCoverage": <1-10>,
  "feedback": "<detailed feedback string>"
}`;
}

// ============================================================
// RESPONSE PARSING
// ============================================================

export interface ParsedReviewResponse {
  dimensions: ReviewDimensions;
  feedback: string;
  score: number;
  verdict: GateVerdict;
  parseError?: string;
}

/**
 * Parse a Codex review response into structured dimensions.
 * Handles both clean JSON and JSON embedded in markdown.
 */
export function parseCodexResponse(response: string): ParsedReviewResponse {
  try {
    // Try to extract JSON from the response (greedy to handle nested objects)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return createDefaultResponse('No JSON found in response');
    }

    // Try parsing the full match first; if it fails (e.g. trailing text),
    // progressively trim from the end to find valid JSON
    let parsed: Record<string, unknown> | null = null;
    let candidate = jsonMatch[0];
    for (let i = 0; i < 5 && candidate.length > 1; i++) {
      try {
        parsed = JSON.parse(candidate);
        break;
      } catch {
        // Trim to the previous closing brace
        const lastBrace = candidate.lastIndexOf('}', candidate.length - 2);
        if (lastBrace <= 0) break;
        candidate = candidate.slice(0, lastBrace + 1);
      }
    }

    if (!parsed || typeof parsed !== 'object') {
      return createDefaultResponse('Could not parse JSON from response');
    }

    const dimensions: ReviewDimensions = {
      correctness: clampScore(parsed.correctness ?? 5),
      security: clampScore(parsed.security ?? 5),
      performance: clampScore(parsed.performance ?? 5),
      maintainability: clampScore(parsed.maintainability ?? 5),
      testCoverage: clampScore(parsed.testCoverage ?? parsed.test_coverage ?? 5),
    };

    const feedback = typeof parsed.feedback === 'string'
      ? parsed.feedback
      : 'No feedback provided';

    const score = calculateScore(dimensions);
    const verdict = determineVerdict(score, dimensions);

    return { dimensions, feedback, score, verdict };
  } catch (err) {
    return createDefaultResponse(
      `Parse error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Clamp a score to the valid 1-10 range.
 */
function clampScore(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (isNaN(num)) return 5;
  return Math.max(1, Math.min(10, Math.round(num)));
}

/**
 * Create a default conservative response when parsing fails.
 */
function createDefaultResponse(parseError: string): ParsedReviewResponse {
  // Conservative defaults: parse failure should trigger reject, not pass
  const dimensions: ReviewDimensions = {
    correctness: 3,
    security: 3,
    performance: 3,
    maintainability: 3,
    testCoverage: 3,
  };
  const score = calculateScore(dimensions);
  const verdict = determineVerdict(score, dimensions);
  return {
    dimensions,
    feedback: `Review parse failed: ${parseError}. Manual review required.`,
    score,
    verdict,
    parseError,
  };
}

// ============================================================
// ROLE-SPECIFIC REVIEW BUILDERS
// ============================================================

/**
 * Build a review prompt tailored to a specific reviewer role.
 */
export function buildRoleReviewPrompt(
  reviewerRole: RoleType,
  taskSubject: string,
  changedFiles: string[],
  diffContent: string
): string {
  const roleDef = ROLE_DEFINITIONS[reviewerRole];
  const roleContext = roleDef
    ? `You are ${roleDef.persona}, the ${roleDef.description}.`
    : `You are a ${reviewerRole} reviewer.`;

  const focusAreas = getFocusAreas(reviewerRole);

  return `${roleContext}

## Task Being Reviewed
${taskSubject}

## Files Changed
${changedFiles.map(f => `- ${f}`).join('\n')}

## Focus Areas for ${reviewerRole}
${focusAreas.map(f => `- ${f}`).join('\n')}

## Diff
\`\`\`
${diffContent}
\`\`\`

## Instructions
Score each dimension from 1-10. Focus especially on your role's key areas.
Respond with ONLY valid JSON:
{
  "correctness": <1-10>,
  "security": <1-10>,
  "performance": <1-10>,
  "maintainability": <1-10>,
  "testCoverage": <1-10>,
  "feedback": "<detailed feedback>"
}`;
}

/**
 * Get focus areas for a reviewer role.
 */
function getFocusAreas(role: RoleType): string[] {
  switch (role) {
    case 'qa-engineer':
      return [
        'Test coverage completeness',
        'Edge case handling',
        'Error handling correctness',
        'Regression risk assessment',
        'Test quality and readability',
      ];
    case 'security-specialist':
      return [
        'Input validation and sanitization',
        'Authentication and authorization',
        'Injection vulnerabilities (SQL, XSS, command)',
        'Sensitive data exposure',
        'Dependency vulnerabilities',
      ];
    case 'pl':
      return [
        'Architecture alignment',
        'API design consistency',
        'Code maintainability',
        'Performance implications',
        'Technical debt impact',
      ];
    default:
      return [
        'Code correctness',
        'Error handling',
        'Performance',
        'Maintainability',
      ];
  }
}

// ============================================================
// SCORE AGGREGATION
// ============================================================

/**
 * Aggregate multiple review scores into a final score.
 * Uses weighted average based on reviewer role authority.
 */
export function aggregateScores(
  reviews: Array<{ reviewerRole: RoleType; dimensions: ReviewDimensions }>
): { dimensions: ReviewDimensions; score: number; verdict: GateVerdict } {
  if (reviews.length === 0) {
    const dims: ReviewDimensions = { correctness: 0, security: 0, performance: 0, maintainability: 0, testCoverage: 0 };
    return { dimensions: dims, score: 0, verdict: 'auto-reject' };
  }

  const weights: Record<string, number> = {
    'security-specialist': 1.5,
    'qa-engineer': 1.3,
    'pl': 1.2,
    'default': 1.0,
  };

  let totalWeight = 0;
  const weighted: ReviewDimensions = {
    correctness: 0,
    security: 0,
    performance: 0,
    maintainability: 0,
    testCoverage: 0,
  };

  for (const review of reviews) {
    const w = weights[review.reviewerRole] ?? weights['default'];
    totalWeight += w;

    weighted.correctness += review.dimensions.correctness * w;
    weighted.security += review.dimensions.security * w;
    weighted.performance += review.dimensions.performance * w;
    weighted.maintainability += review.dimensions.maintainability * w;
    weighted.testCoverage += review.dimensions.testCoverage * w;
  }

  const dimensions: ReviewDimensions = {
    correctness: Math.round((weighted.correctness / totalWeight) * 10) / 10,
    security: Math.round((weighted.security / totalWeight) * 10) / 10,
    performance: Math.round((weighted.performance / totalWeight) * 10) / 10,
    maintainability: Math.round((weighted.maintainability / totalWeight) * 10) / 10,
    testCoverage: Math.round((weighted.testCoverage / totalWeight) * 10) / 10,
  };

  const score = calculateScore(dimensions);
  const verdict = determineVerdict(score, dimensions);

  return { dimensions, score, verdict };
}
