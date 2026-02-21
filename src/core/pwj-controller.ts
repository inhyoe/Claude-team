/**
 * Claude Team - PWJ Cycle Controller
 *
 * Orchestrates the full Planner-Worker-Judge lifecycle:
 * plan → execute → judge → (rework loop) → complete
 *
 * Manages quality gate evaluation, rework cycles, and escalation paths.
 */

import type {
  ExecutionPlan,
  DAGNode,
  RoleAssignment,
  ComplexityScore,
  GateType,
  QualityGateResult,
} from '../shared/types.js';
import type { TaskSpec } from './dag-types.js';
import type {
  GateEvaluationInput,
  GateEvaluationResult,
} from '../quality/gates.js';
import type {
  EscalationDecision,
  EscalationAction,
} from '../quality/escalation.js';
import {
  selectRoles,
  createPWJSequence,
  buildPWJPlan,
  isReadyForJudgment,
  isPWJComplete,
  PWJPhase,
} from './planner-worker-judge.js';
import {
  getReadyNodes,
  markNodeStarted,
  markNodeCompleted,
  markNodeFailed,
} from './dag-engine.js';
import { evaluateGate } from '../quality/gates.js';
import { determineEscalation } from '../quality/escalation.js';
import { MAX_REVIEW_ATTEMPTS } from '../shared/constants.js';
import { nowIso } from '../shared/utils.js';

// ============================================================
// PHASE RESULT INTERFACES
// ============================================================

export interface PlanPhaseResult {
  success: boolean;
  refinedTaskSpecs?: TaskSpec[];
  artifacts?: string[];
}

export interface ExecutePhaseResult {
  completedNodeIds: string[];
  failedNodeIds: string[];
  artifacts?: string[];
}

export interface JudgePhaseResult {
  gateResults: GateEvaluationResult[];
  allPassed: boolean;
  failedTaskIds: string[];
  feedback: string[];
}

export interface ReworkResult {
  success: boolean;
  fixedNodeIds: string[];
  stillFailedNodeIds: string[];
}

// ============================================================
// CYCLE SUMMARY & STATE
// ============================================================

export interface PWJCycleSummary {
  status: 'completed' | 'failed' | 'escalated';
  totalCycles: number;
  reworkCycles: number;
  roles: RoleAssignment[];
  plan: ExecutionPlan | null;
  gateResults: GateEvaluationResult[];
  startedAt: string;
  completedAt: string;
  failureReason?: string;
}

export interface PWJCycleState {
  phase: 'planning' | 'executing' | 'judging' | 'reworking' | 'completed' | 'failed' | 'escalated';
  cycleNumber: number;
  reworkCount: number;
  roles: RoleAssignment[];
  plan: ExecutionPlan | null;
  allGateResults: GateEvaluationResult[];
  failedNodeIds: string[];
  startedAt: string;
  updatedAt: string;
}

// ============================================================
// CYCLE CONFIGURATION
// ============================================================

export interface PWJCycleConfig {
  cwd: string;
  projectId: string;
  complexity: ComplexityScore;
  taskSpecs: TaskSpec[];
  maxReworkCycles?: number;

  // Callbacks for actual agent dispatch
  onPlanPhase?: (phase: PWJPhase) => Promise<PlanPhaseResult>;
  onExecutePhase?: (phase: PWJPhase, plan: ExecutionPlan) => Promise<ExecutePhaseResult>;
  onJudgePhase?: (phase: PWJPhase, plan: ExecutionPlan) => Promise<JudgePhaseResult>;
  onRework?: (failedNodes: DAGNode[], feedback: string[]) => Promise<ReworkResult>;
  onCycleComplete?: (summary: PWJCycleSummary) => void;
  onEscalation?: (decision: EscalationDecision) => Promise<void>;
}

// ============================================================
// PWJ CONTROLLER
// ============================================================

export class PWJController {
  private config: PWJCycleConfig;
  private state: PWJCycleState;

  constructor(config: PWJCycleConfig) {
    this.config = config;
    const ts = nowIso();
    this.state = {
      phase: 'planning',
      cycleNumber: 1,
      reworkCount: 0,
      roles: [],
      plan: null,
      allGateResults: [],
      failedNodeIds: [],
      startedAt: ts,
      updatedAt: ts,
    };
  }

  /**
   * Run the full PWJ cycle: plan → execute → judge → (rework loop) → complete
   */
  async run(): Promise<PWJCycleSummary> {
    const maxReworkCycles = this.config.maxReworkCycles ?? MAX_REVIEW_ATTEMPTS;
    let taskSpecs = this.config.taskSpecs;

    try {
      // ============================================================
      // PHASE 1: PLANNING
      // ============================================================
      this.state.phase = 'planning';
      this.state.updatedAt = nowIso();

      const roles = selectRoles(this.config.complexity);
      this.state.roles = roles;

      const phases = createPWJSequence(roles, taskSpecs);
      const planPhase = phases.find(p => p.name === 'plan');

      // Execute planning phase if callback provided
      if (planPhase && this.config.onPlanPhase) {
        const planResult = await this.config.onPlanPhase(planPhase);
        if (!planResult.success) {
          return this.fail('Planning phase failed');
        }
        // Use refined task specs if provided
        if (planResult.refinedTaskSpecs && planResult.refinedTaskSpecs.length > 0) {
          taskSpecs = planResult.refinedTaskSpecs;
        }
      }

      // Build the DAG plan
      const { plan } = buildPWJPlan(this.config.projectId, this.config.complexity, taskSpecs);
      this.state.plan = plan;
      this.state.updatedAt = nowIso();

      // ============================================================
      // PHASE 2: EXECUTION
      // ============================================================
      this.state.phase = 'executing';
      this.state.updatedAt = nowIso();

      const execPhase = phases.find(p => p.name === 'execute');
      if (execPhase && this.config.onExecutePhase) {
        const execResult = await this.config.onExecutePhase(execPhase, plan);

        // Update node statuses based on execution result
        for (const nodeId of execResult.completedNodeIds) {
          const node = plan.nodes.get(nodeId);
          if (node && node.status === 'running') {
            markNodeCompleted(plan, nodeId);
          }
        }
        for (const nodeId of execResult.failedNodeIds) {
          const node = plan.nodes.get(nodeId);
          if (node && node.status === 'running') {
            markNodeFailed(plan, nodeId);
          }
        }
      }

      // ============================================================
      // PHASE 3: JUDGE (with rework loop)
      // ============================================================
      const judgePhase = phases.find(p => p.name === 'judge');

      // Loop runs at most maxReworkCycles rework iterations (plus initial judgment).
      // Total judge evaluations = 1 (initial) + reworkCount (up to maxReworkCycles).
      // The <= condition allows the loop to enter at reworkCount == maxReworkCycles so
      // the inner guard (reworkCount >= maxReworkCycles) can trigger escalation after
      // the final judge evaluation, preventing an off-by-one where the last judgment
      // is never executed.
      while (this.state.reworkCount <= maxReworkCycles) {
        this.state.phase = 'judging';
        this.state.updatedAt = nowIso();

        if (judgePhase && this.config.onJudgePhase) {
          const judgeResult = await this.config.onJudgePhase(judgePhase, plan);

          // Track all gate results
          this.state.allGateResults.push(...judgeResult.gateResults);

          if (judgeResult.allPassed) {
            // Success! All gates passed
            this.state.phase = 'completed';
            this.state.updatedAt = nowIso();
            break;
          }

          // Not all passed — check if we can rework
          this.state.failedNodeIds = judgeResult.failedTaskIds;

          if (this.state.reworkCount >= maxReworkCycles) {
            // Exhausted attempts — escalate
            return await this.handleEscalation(judgeResult);
          }

          // Rework: re-execute only failed nodes
          this.state.reworkCount++;
          this.state.phase = 'reworking';
          this.state.updatedAt = nowIso();

          const failedNodes = judgeResult.failedTaskIds
            .map(taskId => {
              // Find node by taskId
              for (const [, node] of plan.nodes) {
                if (node.taskId === taskId) return node;
              }
              return null;
            })
            .filter((n): n is DAGNode => n !== null);

          if (this.config.onRework && failedNodes.length > 0) {
            const reworkResult = await this.config.onRework(failedNodes, judgeResult.feedback);

            // Reset failed nodes to pending for retry
            const nodeIdsToReset = reworkResult.success
              ? reworkResult.fixedNodeIds
              : failedNodes.map(n => n.id);

            this.resetFailedNodes(plan, nodeIdsToReset);

            // If rework failed, escalate
            if (!reworkResult.success) {
              return await this.handleEscalation(judgeResult);
            }
          } else {
            // No rework callback — can't fix, escalate
            return await this.handleEscalation(judgeResult);
          }
        } else {
          // No judge phase — auto-pass
          this.state.phase = 'completed';
          this.state.updatedAt = nowIso();
          break;
        }
      }

      // ============================================================
      // COMPLETE
      // ============================================================
      const summary = this.buildSummary('completed');

      if (this.config.onCycleComplete) {
        this.config.onCycleComplete(summary);
      }

      return summary;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return this.fail(`PWJ cycle failed: ${errorMsg}`);
    }
  }

  /**
   * Get the current state of the cycle.
   */
  getState(): PWJCycleState {
    return { ...this.state };
  }

  /**
   * Reset failed nodes back to pending for rework.
   */
  private resetFailedNodes(plan: ExecutionPlan, nodeIds: string[]): void {
    for (const nodeId of nodeIds) {
      const node = plan.nodes.get(nodeId);
      if (node) {
        node.status = 'pending';
        node.completedAt = null;
        node.startedAt = null;
      }
    }
    plan.updatedAt = nowIso();
  }

  /**
   * Handle escalation when rework cycles are exhausted.
   */
  private async handleEscalation(judgeResult: JudgePhaseResult): Promise<PWJCycleSummary> {
    this.state.phase = 'escalated';
    this.state.updatedAt = nowIso();

    // Determine escalation for each failed task
    const escalationDecisions: EscalationDecision[] = [];

    for (const gateResult of judgeResult.gateResults) {
      if (gateResult.verdict !== 'pass') {
        const decision = determineEscalation(
          this.config.cwd,
          gateResult.result.taskId,
          gateResult.result.gateType,
          gateResult.result
        );

        escalationDecisions.push(decision);

        // Invoke escalation callback for critical actions
        if (this.config.onEscalation &&
            (decision.action === 'escalate-pl' || decision.action === 'escalate-pm')) {
          await this.config.onEscalation(decision);
        }
      }
    }

    // Determine overall status
    const hasCriticalEscalation = escalationDecisions.some(
      d => d.action === 'escalate-pm' || d.action === 'abandon'
    );

    const status = hasCriticalEscalation ? 'failed' : 'escalated';

    const summary = this.buildSummary(status);

    if (this.config.onCycleComplete) {
      this.config.onCycleComplete(summary);
    }

    return summary;
  }

  /**
   * Build a summary of the PWJ cycle.
   */
  private buildSummary(status: 'completed' | 'failed' | 'escalated'): PWJCycleSummary {
    const ts = nowIso();

    return {
      status,
      totalCycles: 1 + this.state.reworkCount,
      reworkCycles: this.state.reworkCount,
      roles: this.state.roles,
      plan: this.state.plan,
      gateResults: this.state.allGateResults,
      startedAt: this.state.startedAt,
      completedAt: ts,
    };
  }

  /**
   * Mark the cycle as failed and return summary.
   */
  private fail(reason: string): PWJCycleSummary {
    this.state.phase = 'failed';
    this.state.updatedAt = nowIso();

    const summary = { ...this.buildSummary('failed'), failureReason: reason };

    if (this.config.onCycleComplete) {
      this.config.onCycleComplete(summary);
    }

    return summary;
  }
}

// ============================================================
// FACTORY
// ============================================================

/**
 * Create a new PWJ controller instance.
 */
export function createPWJController(config: PWJCycleConfig): PWJController {
  return new PWJController(config);
}
