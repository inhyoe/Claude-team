/**
 * Claude Team - Quality Gates
 *
 * Quality gate definitions and evaluation logic.
 * Gates block kanban transitions until quality thresholds are met.
 */

import type {
  GateType,
  GateVerdict,
  ReviewDimensions,
  QualityGateResult,
  RoleType,
} from '../shared/types.js';
import {
  QUALITY_GATE_THRESHOLDS,
  MAX_REVIEW_ATTEMPTS,
} from '../shared/constants.js';
import { createGateResult, getGateResultsByTask, getLatestGateForTask } from '../persistence/quality-gates-repo.js';

// ============================================================
// GATE DEFINITIONS
// ============================================================

export interface GateDefinition {
  type: GateType;
  reviewerRoles: RoleType[];
  requiredDimensions: (keyof ReviewDimensions)[];
  minScore: number;
  minDimensionScore: number;
  description: string;
}

export const GATE_DEFINITIONS: Record<GateType, GateDefinition> = {
  'design-review': {
    type: 'design-review',
    reviewerRoles: ['pl'],
    requiredDimensions: ['correctness', 'maintainability'],
    minScore: 7.0,
    minDimensionScore: 3,
    description: 'PL reviews architecture and design decisions',
  },
  'code-review': {
    type: 'code-review',
    reviewerRoles: ['qa-engineer', 'pl'],
    requiredDimensions: ['correctness', 'security', 'performance', 'maintainability', 'testCoverage'],
    minScore: 7.0,
    minDimensionScore: 3,
    description: 'Code review with all quality dimensions',
  },
  'qa-review': {
    type: 'qa-review',
    reviewerRoles: ['qa-engineer'],
    requiredDimensions: ['correctness', 'testCoverage'],
    minScore: 7.0,
    minDimensionScore: 3,
    description: 'QA verifies test coverage and correctness',
  },
  'security-review': {
    type: 'security-review',
    reviewerRoles: ['security-specialist'],
    requiredDimensions: ['security'],
    minScore: 7.0,
    minDimensionScore: 5,
    description: 'Security specialist audits for vulnerabilities',
  },
  'pl-approval': {
    type: 'pl-approval',
    reviewerRoles: ['pl'],
    requiredDimensions: ['correctness', 'maintainability'],
    minScore: 6.0,
    minDimensionScore: 3,
    description: 'Final PL approval before deployment',
  },
};

// ============================================================
// SCORING
// ============================================================

/**
 * Calculate the overall score from review dimensions.
 */
export function calculateScore(dimensions: ReviewDimensions): number {
  const values = [
    dimensions.correctness,
    dimensions.security,
    dimensions.performance,
    dimensions.maintainability,
    dimensions.testCoverage,
  ];
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Determine the verdict based on score and dimension minimums.
 * When gateType is provided, uses per-gate thresholds from GATE_DEFINITIONS
 * for the pass check (minScore, minDimensionScore). Falls back to global
 * QUALITY_GATE_THRESHOLDS for conditional/reject/auto-reject tiers.
 */
export function determineVerdict(score: number, dimensions: ReviewDimensions, gateType?: GateType): GateVerdict {
  const minDim = Math.min(
    dimensions.correctness,
    dimensions.security,
    dimensions.performance,
    dimensions.maintainability,
    dimensions.testCoverage
  );

  // Use per-gate thresholds for pass when available, else global
  const gateDef = gateType ? GATE_DEFINITIONS[gateType] : undefined;
  const passMinScore = gateDef?.minScore ?? QUALITY_GATE_THRESHOLDS['pass'].minScore;
  const passMinDim = gateDef?.minDimensionScore ?? QUALITY_GATE_THRESHOLDS['pass'].minDimension;

  if (score >= passMinScore && minDim >= passMinDim) {
    return 'pass';
  }
  if (score >= QUALITY_GATE_THRESHOLDS['conditional'].minScore && minDim >= QUALITY_GATE_THRESHOLDS['conditional'].minDimension) {
    return 'conditional';
  }
  if (score >= QUALITY_GATE_THRESHOLDS['reject'].minScore && minDim >= QUALITY_GATE_THRESHOLDS['reject'].minDimension) {
    return 'reject';
  }
  return 'auto-reject';
}

// ============================================================
// GATE EVALUATION
// ============================================================

export interface GateEvaluationInput {
  cwd: string;
  projectId: string;
  taskId: string;
  gateType: GateType;
  reviewerRole: RoleType;
  dimensions: ReviewDimensions;
  feedback: string;
}

export interface GateEvaluationResult {
  result: QualityGateResult;
  verdict: GateVerdict;
  canRetry: boolean;
  attemptsRemaining: number;
  needsEscalation: boolean;
}

/**
 * Evaluate a quality gate for a task.
 * Records the result and returns the verdict with retry info.
 */
export function evaluateGate(input: GateEvaluationInput): GateEvaluationResult {
  const { cwd, projectId, taskId, gateType, reviewerRole, dimensions, feedback } = input;

  const score = calculateScore(dimensions);
  const verdict = determineVerdict(score, dimensions, gateType);

  // Get previous attempts
  const previousResults = getGateResultsByTask(cwd, taskId);
  const sameGateResults = previousResults.filter(r => r.gateType === gateType);
  const attempt = sameGateResults.length + 1;

  // Record gate result
  const gateId = `gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const recorded = createGateResult(cwd, projectId, {
    id: gateId,
    gateType,
    reviewerRole,
    taskId,
    score,
    dimensions,
    verdict,
    feedback,
    attempt,
    maxAttempts: MAX_REVIEW_ATTEMPTS,
  });

  const result: QualityGateResult = recorded ?? {
    id: gateId,
    gateType,
    reviewerRole,
    taskId,
    score,
    dimensions,
    verdict,
    feedback,
    attempt,
    maxAttempts: MAX_REVIEW_ATTEMPTS,
    createdAt: new Date().toISOString(),
  };

  const canRetry = verdict !== 'pass' && attempt < MAX_REVIEW_ATTEMPTS;
  const attemptsRemaining = Math.max(0, MAX_REVIEW_ATTEMPTS - attempt);
  const needsEscalation = verdict === 'auto-reject' || (!canRetry && verdict !== 'pass');

  return {
    result,
    verdict,
    canRetry,
    attemptsRemaining,
    needsEscalation,
  };
}

// ============================================================
// GATE STATUS QUERIES
// ============================================================

/**
 * Check if a task has passed a specific gate type.
 */
export function hasPassedGate(cwd: string, taskId: string, gateType: GateType): boolean {
  const latest = getLatestGateForTask(cwd, taskId, gateType) as QualityGateResult | null;
  return latest !== null && latest.verdict === 'pass';
}

/**
 * Check if a task has exhausted all retry attempts for a gate.
 */
export function isGateExhausted(cwd: string, taskId: string, gateType: GateType): boolean {
  const results = getGateResultsByTask(cwd, taskId);
  const sameGate = results.filter(r => r.gateType === gateType);
  return sameGate.length >= MAX_REVIEW_ATTEMPTS && !sameGate.some(r => r.verdict === 'pass');
}

/**
 * Get a summary of gate results for a task.
 */
export function getGateSummary(cwd: string, taskId: string): {
  gates: Record<GateType, { passed: boolean; attempts: number; lastScore: number | null }>;
  allPassed: boolean;
  anyExhausted: boolean;
} {
  const results = getGateResultsByTask(cwd, taskId);
  const gateTypes: GateType[] = ['design-review', 'code-review', 'qa-review', 'security-review', 'pl-approval'];

  const gates = {} as Record<GateType, { passed: boolean; attempts: number; lastScore: number | null }>;
  let allPassed = true;
  let anyExhausted = false;
  let anyEvaluated = false;

  for (const gt of gateTypes) {
    const gateResults = results.filter(r => r.gateType === gt);
    const passed = gateResults.some(r => r.verdict === 'pass');
    const lastResult: QualityGateResult | undefined = gateResults[gateResults.length - 1];

    gates[gt] = {
      passed,
      attempts: gateResults.length,
      lastScore: lastResult !== undefined ? lastResult.score : null,
    };

    if (gateResults.length > 0) {
      anyEvaluated = true;
      if (!passed) allPassed = false;
    }
    if (gateResults.length >= MAX_REVIEW_ATTEMPTS && !passed) anyExhausted = true;
  }

  // No gates evaluated means nothing has passed
  if (!anyEvaluated) allPassed = false;

  return { gates, allPassed, anyExhausted };
}

/**
 * Determine which gates a task still needs to pass.
 */
export function getPendingGates(
  cwd: string,
  taskId: string,
  requiredGates: GateType[]
): GateType[] {
  return requiredGates.filter(gt => !hasPassedGate(cwd, taskId, gt));
}

/**
 * Format a gate result as a human-readable summary.
 */
export function formatGateResult(result: QualityGateResult): string {
  const dims = result.dimensions;
  return [
    `Gate: ${result.gateType} | Verdict: ${result.verdict.toUpperCase()} | Score: ${result.score.toFixed(1)}/10`,
    `  Correctness: ${dims.correctness} | Security: ${dims.security} | Performance: ${dims.performance}`,
    `  Maintainability: ${dims.maintainability} | Test Coverage: ${dims.testCoverage}`,
    `  Attempt: ${result.attempt}/${result.maxAttempts}`,
    result.feedback ? `  Feedback: ${result.feedback}` : '',
  ].filter(Boolean).join('\n');
}
