/**
 * Claude Team - Quality Gate Hook
 *
 * Automatically triggers quality gate evaluation when tasks
 * transition to review status via the DAG↔Kanban sync.
 *
 * Reference: Augment Code "Autonomous Quality Gates" pattern (2026)
 * "Deterministic gates that block progression until quality thresholds are met"
 */

import type { GateType, RoleType, ReviewDimensions, QualityGateResult } from '../shared/types.js';
import { evaluateGate, hasPassedGate } from '../quality/gates.js';
import type { GateEvaluationInput, GateEvaluationResult } from '../quality/gates.js';
import { determineEscalation } from '../quality/escalation.js';
import type { EscalationDecision } from '../quality/escalation.js';
import { updateTaskReviewScore } from '../persistence/tasks-repo.js';
import type { HookRegistry } from './lifecycle.js';

export interface QualityGateHookConfig {
  cwd: string;
  projectId: string;
  defaultGateType?: GateType;     // default: 'code-review'
  defaultReviewerRole?: RoleType;  // default: 'qa-engineer'

  // Callback to get review dimensions (from external reviewer like Codex)
  onReviewRequested?: (taskId: string, gateType: GateType) => Promise<{
    dimensions: ReviewDimensions;
    feedback: string;
  } | null>;

  // Callback when escalation is needed
  onEscalation?: (decision: EscalationDecision) => Promise<void>;
}

/**
 * Create a quality gate hook that auto-evaluates tasks entering review.
 */
export function createQualityGateHook(config: QualityGateHookConfig, hooks: HookRegistry): { detach: () => void } {
  const gateType = config.defaultGateType ?? 'code-review';
  const reviewerRole = config.defaultReviewerRole ?? 'qa-engineer';
  const unsubs: Array<() => void> = [];

  // When a node completes (work is done), trigger quality gate
  unsubs.push(hooks.on('node:completed', async (event) => {
    const { taskId } = event.data as { taskId: string | null };
    if (!taskId) return;

    // Skip if already passed this gate
    if (hasPassedGate(config.cwd, taskId, gateType)) return;

    // Request review dimensions from external source
    if (!config.onReviewRequested) return;

    const reviewData = await config.onReviewRequested(taskId, gateType);
    if (!reviewData) return;

    // Evaluate the gate
    const gateInput: GateEvaluationInput = {
      cwd: config.cwd,
      projectId: config.projectId,
      taskId,
      gateType,
      reviewerRole,
      dimensions: reviewData.dimensions,
      feedback: reviewData.feedback,
    };

    const result = evaluateGate(gateInput);

    // Update task review score
    updateTaskReviewScore(config.cwd, taskId, result.result.score);

    // Emit gate events
    if (result.verdict === 'pass') {
      await hooks.emitGateEvent('gate:passed', taskId, gateType, {
        score: result.result.score,
        verdict: result.verdict,
      });
    } else {
      await hooks.emitGateEvent('gate:failed', taskId, gateType, {
        score: result.result.score,
        verdict: result.verdict,
        canRetry: result.canRetry,
        attemptsRemaining: result.attemptsRemaining,
      });

      // Check if escalation is needed
      if (result.needsEscalation) {
        const escalation = determineEscalation(config.cwd, taskId, gateType, result.result);

        await hooks.emit({
          type: 'escalation:triggered',
          timestamp: new Date().toISOString(),
          data: {
            taskId,
            action: escalation.action,
            reason: escalation.reason,
            targetRole: escalation.targetRole,
          },
        });

        if (config.onEscalation) {
          await config.onEscalation(escalation);
        }
      }
    }
  }));

  return {
    detach() {
      for (const unsub of unsubs) unsub();
    }
  };
}
