/**
 * Claude Team - Escalation Logic
 *
 * Handles quality gate failures and escalation to PL/PM.
 * Implements the 3-strike retry policy and escalation paths.
 */

import type {
  RoleType,
  GateType,
  GateVerdict,
  QualityGateResult,
} from '../shared/types.js';
import { MAX_REVIEW_ATTEMPTS } from '../shared/constants.js';
import { getGateResultsByTask } from '../persistence/quality-gates-repo.js';
import { getTask } from '../persistence/tasks-repo.js';

// ============================================================
// ESCALATION TYPES
// ============================================================

export type EscalationAction =
  | 'retry'           // Send back to worker for fixes
  | 'upgrade-model'   // Re-review with opus model
  | 'escalate-pl'     // Escalate to PL for decision
  | 'escalate-pm'     // Escalate to PM (critical priority)
  | 'split-task'      // Recommend splitting the task
  | 'accept-risk'     // Accept with documented risk
  | 'abandon';        // Mark task as failed

export interface EscalationDecision {
  action: EscalationAction;
  reason: string;
  targetRole: RoleType;
  context: {
    taskId: string;
    gateType: GateType;
    attempt: number;
    lastVerdict: GateVerdict;
    lastScore: number;
    history: QualityGateResult[];
  };
  suggestedGuidance?: string;
}

// ============================================================
// ESCALATION LOGIC
// ============================================================

/**
 * Determine the escalation action based on gate result history.
 */
export function determineEscalation(
  cwd: string,
  taskId: string,
  gateType: GateType,
  latestResult: QualityGateResult
): EscalationDecision {
  const history = getGateResultsByTask(cwd, taskId)
    .filter(r => r.gateType === gateType);

  const attempt = history.length;
  const context = {
    taskId,
    gateType,
    attempt,
    lastVerdict: latestResult.verdict,
    lastScore: latestResult.score,
    history,
  };

  // Auto-reject: immediately escalate
  if (latestResult.verdict === 'auto-reject') {
    return {
      action: 'escalate-pl',
      reason: `Auto-reject (score ${latestResult.score.toFixed(1)}). Fundamental quality issues detected.`,
      targetRole: 'pl',
      context,
      suggestedGuidance: 'Consider splitting the task or reassigning to a different worker.',
    };
  }

  // First failure: retry with feedback
  // attempt <= 1 covers both attempt=0 (no DB history yet) and attempt=1
  if (attempt <= 1 && latestResult.verdict !== 'pass') {
    return {
      action: 'retry',
      reason: `First attempt ${latestResult.verdict} (score ${latestResult.score.toFixed(1)}). Worker should address review feedback.`,
      targetRole: getOriginalWorker(cwd, taskId, history),
      context,
      suggestedGuidance: extractKeyIssues(latestResult),
    };
  }

  // Second failure: conditional → upgrade model, reject → retry with stronger guidance
  if (attempt === 2 && latestResult.verdict !== 'pass') {
    if (latestResult.verdict === 'conditional') {
      return {
        action: 'upgrade-model',
        reason: `Second conditional verdict. Re-reviewing with opus model for higher accuracy.`,
        targetRole: latestResult.reviewerRole,
        context,
      };
    }
    return {
      action: 'retry',
      reason: `Second attempt rejected (score ${latestResult.score.toFixed(1)}). Final retry with detailed guidance.`,
      targetRole: getOriginalWorker(cwd, taskId, history),
      context,
      suggestedGuidance: buildDetailedGuidance(history),
    };
  }

  // Third failure: escalate to PL
  if (attempt >= MAX_REVIEW_ATTEMPTS && latestResult.verdict !== 'pass') {
    const scoresTrend = history.map(r => r.score);
    const improving = scoresTrend.length >= 2 &&
      scoresTrend[scoresTrend.length - 1] > scoresTrend[scoresTrend.length - 2];

    if (improving) {
      return {
        action: 'escalate-pl',
        reason: `${attempt} attempts exhausted but scores improving (${scoresTrend.map(s => s.toFixed(1)).join(' -> ')}). PL should decide: one more attempt or accept.`,
        targetRole: 'pl',
        context,
        suggestedGuidance: 'Scores are trending up. Consider allowing one more attempt or accepting with documented caveats.',
      };
    }

    return {
      action: 'escalate-pl',
      reason: `${attempt} attempts exhausted, no improvement. PL must decide: split task, reassign, or accept risk.`,
      targetRole: 'pl',
      context,
      suggestedGuidance: 'Recommend splitting the task into smaller, more manageable pieces.',
    };
  }

  // Default: no escalation needed (pass)
  return {
    action: 'accept-risk',
    reason: 'No escalation needed.',
    targetRole: 'pl',
    context,
  };
}

// ============================================================
// PL DECISION HELPERS
// ============================================================

export type PLDecision = 'retry' | 'split' | 'redesign' | 'accept';

export interface PLDecisionInput {
  taskId: string;
  gateType: GateType;
  history: QualityGateResult[];
  decision: PLDecision;
  reason: string;
}

/**
 * Apply PL's decision after escalation.
 * Returns the action to take.
 */
export function applyPLDecision(input: PLDecisionInput): {
  action: EscalationAction;
  guidance: string;
} {
  switch (input.decision) {
    case 'retry':
      return {
        action: 'retry',
        guidance: `PL authorized additional retry. Reason: ${input.reason}`,
      };
    case 'split':
      return {
        action: 'split-task',
        guidance: `PL decided to split task. Original issues: ${summarizeIssues(input.history)}`,
      };
    case 'redesign':
      return {
        action: 'escalate-pm',
        guidance: `PL escalated to PM for redesign. Reason: ${input.reason}`,
      };
    case 'accept':
      return {
        action: 'accept-risk',
        guidance: `PL accepted with risk. Documented reason: ${input.reason}`,
      };
  }
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Get the role that originally produced the reviewed work.
 * Queries the task's assigned_role from the DB, falling back to history inspection.
 */
function getOriginalWorker(cwd: string, taskId: string, history: QualityGateResult[]): RoleType {
  // Primary: look up the task's assigned role from DB
  const task = getTask(cwd, taskId);
  if (task?.assignedRole) {
    return task.assignedRole;
  }

  // Fallback: inspect history for a non-reviewer role
  const reviewerRoles: RoleType[] = ['qa-engineer', 'security-specialist', 'pl', 'pm'];
  for (const result of history) {
    if (result.reviewerRole && !reviewerRoles.includes(result.reviewerRole)) {
      return result.reviewerRole;
    }
  }

  // When the original worker is unknown, escalate to PL for reassignment
  return 'pl';
}

/**
 * Extract key issues from feedback.
 */
function extractKeyIssues(result: QualityGateResult): string {
  const weakDims: string[] = [];
  const dims = result.dimensions;

  if (dims.correctness < 5) weakDims.push(`correctness(${dims.correctness})`);
  if (dims.security < 5) weakDims.push(`security(${dims.security})`);
  if (dims.performance < 5) weakDims.push(`performance(${dims.performance})`);
  if (dims.maintainability < 5) weakDims.push(`maintainability(${dims.maintainability})`);
  if (dims.testCoverage < 5) weakDims.push(`testCoverage(${dims.testCoverage})`);

  return weakDims.length > 0
    ? `Focus on weak dimensions: ${weakDims.join(', ')}. ${result.feedback}`
    : result.feedback;
}

/**
 * Build detailed guidance from multiple review attempts.
 */
function buildDetailedGuidance(history: QualityGateResult[]): string {
  const feedbacks = history.map((r, i) =>
    `Attempt ${i + 1} (score ${r.score.toFixed(1)}): ${r.feedback}`
  );
  return `Review history:\n${feedbacks.join('\n')}\n\nAddress ALL previously identified issues before resubmitting.`;
}

/**
 * Summarize issues across all review attempts.
 */
function summarizeIssues(history: QualityGateResult[]): string {
  const allFeedback = history.map(r => r.feedback).filter(Boolean);
  return allFeedback.join('; ') || 'No specific issues recorded.';
}

/**
 * Format an escalation decision for display.
 */
export function formatEscalation(decision: EscalationDecision): string {
  return [
    `ESCALATION: ${decision.action.toUpperCase()}`,
    `Task: ${decision.context.taskId} | Gate: ${decision.context.gateType}`,
    `Attempt: ${decision.context.attempt}/${MAX_REVIEW_ATTEMPTS}`,
    `Last Score: ${decision.context.lastScore.toFixed(1)} (${decision.context.lastVerdict})`,
    `Reason: ${decision.reason}`,
    decision.suggestedGuidance ? `Guidance: ${decision.suggestedGuidance}` : '',
    `Target: ${decision.targetRole}`,
  ].filter(Boolean).join('\n');
}
