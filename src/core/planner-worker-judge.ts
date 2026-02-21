/**
 * Claude Team - Planner-Worker-Judge (PWJ) Orchestration Pattern
 *
 * Implements the three-layer hierarchy that avoids flat agent failures:
 * - Planner (PM/PL): Define what to do, decompose tasks
 * - Worker (Dev/Design/DevOps/DBA): Execute tasks
 * - Judge (QA/Security): Review and approve work
 */

import type {
  RoleType,
  DAGLayerType,
  ComplexityScore,
  RoleAssignment,
  ExecutionPlan,
} from '../shared/types.js';
import { ROLE_DEFINITIONS, MERGE_CONFIGURATIONS } from '../shared/constants.js';
import type { TaskSpec } from './dag-types.js';
import { buildExecutionPlan } from './dag-engine.js';

// ============================================================
// ROLE SELECTION
// ============================================================

/**
 * Select active roles based on complexity score.
 */
export function selectRoles(complexity: ComplexityScore): RoleAssignment[] {
  const config = MERGE_CONFIGURATIONS[complexity.level];
  const assignments: RoleAssignment[] = [];

  for (const slot of config.layout) {
    const primaryRole = slot.roles[0];
    const def = ROLE_DEFINITIONS[primaryRole];

    assignments.push({
      roleId: `role-${primaryRole}-${Date.now()}`,
      role: primaryRole,
      dagLayer: slot.dagLayer,
      personaName: def.persona,
      agentName: '',
      provider: slot.provider,
      model: slot.model,
      isMergedInto: null,
      mergedRoles: slot.roles.slice(1),
      status: 'active',
    });
  }

  return assignments;
}

/**
 * Get the DAG layer for a role.
 */
export function getRoleLayer(role: RoleType): DAGLayerType {
  return ROLE_DEFINITIONS[role]?.dagLayer ?? 'worker';
}

/**
 * Group roles by their DAG layer.
 */
export function groupByLayer(roles: RoleAssignment[]): Record<DAGLayerType, RoleAssignment[]> {
  const groups: Record<DAGLayerType, RoleAssignment[]> = {
    planner: [],
    worker: [],
    judge: [],
  };

  for (const assignment of roles) {
    const layer = assignment.dagLayer ?? getRoleLayer(assignment.role);
    groups[layer].push(assignment);
  }

  return groups;
}

// ============================================================
// PWJ ORCHESTRATION
// ============================================================

export interface PWJPhase {
  name: 'plan' | 'execute' | 'judge';
  roles: RoleAssignment[];
  tasks: TaskSpec[];
}

/**
 * Create a PWJ execution sequence from roles and task specs.
 */
export function createPWJSequence(
  roles: RoleAssignment[],
  taskSpecs: TaskSpec[]
): PWJPhase[] {
  const groups = groupByLayer(roles);
  const phases: PWJPhase[] = [];

  // Phase 1: Planning
  const planTasks = taskSpecs.filter(t => t.nodeType === 'planning' || t.nodeType === 'design');
  if (groups.planner.length > 0 && planTasks.length > 0) {
    phases.push({
      name: 'plan',
      roles: groups.planner,
      tasks: planTasks,
    });
  }

  // Phase 2: Execution
  const execTasks = taskSpecs.filter(t => t.nodeType === 'execution' || t.nodeType === 'deployment');
  if (groups.worker.length > 0 && execTasks.length > 0) {
    phases.push({
      name: 'execute',
      roles: groups.worker,
      tasks: execTasks,
    });
  }

  // Phase 3: Judgment
  const judgeTasks = taskSpecs.filter(t => t.nodeType === 'verification');
  if (groups.judge.length > 0) {
    // Judges review all execution tasks
    const reviewTasks: TaskSpec[] = judgeTasks.length > 0
      ? judgeTasks
      : execTasks.map(t => ({
          ...t,
          id: `review-${t.id}`,
          title: `Review: ${t.title}`,
          nodeType: 'verification' as const,
          assignedRole: groups.judge[0].role,
          dependencies: [t.id],
        }));

    phases.push({
      name: 'judge',
      roles: groups.judge,
      tasks: reviewTasks,
    });
  }

  return phases;
}

/**
 * Build a full execution plan using PWJ pattern.
 */
export function buildPWJPlan(
  projectId: string,
  complexity: ComplexityScore,
  taskSpecs: TaskSpec[]
): { roles: RoleAssignment[]; plan: ExecutionPlan } {
  const roles = selectRoles(complexity);
  const plan = buildExecutionPlan(projectId, taskSpecs);
  plan.status = 'executing';

  return { roles, plan };
}

/**
 * Check if all workers have completed and it's time for judges.
 */
export function isReadyForJudgment(plan: ExecutionPlan): boolean {
  // Check if all non-verification nodes are completed
  for (const [, node] of plan.nodes) {
    if (node.nodeType !== 'verification' && node.status !== 'completed' && node.status !== 'skipped') {
      return false;
    }
  }
  return true;
}

/**
 * Check if the entire PWJ cycle is complete.
 */
export function isPWJComplete(plan: ExecutionPlan): boolean {
  for (const [, node] of plan.nodes) {
    if (node.status !== 'completed' && node.status !== 'skipped') {
      return false;
    }
  }
  return true;
}
