/**
 * Claude Team - Unified Team Management
 *
 * Role-aware team member management.
 * Extends OMC's team concept with role assignments, merging, and lifecycle.
 */

import type {
  RoleType,
  RoleAssignment,
  ComplexityScore,
  ProviderType,
  ModelType,
  DAGLayerType,
  ProjectState,
} from '../shared/types.js';
import { ROLE_DEFINITIONS } from '../shared/constants.js';
import { mergeRoles, type MergeResult } from '../agents/role-merger.js';
import { buildRolePreamble, buildMcpRolePreamble } from '../agents/preamble.js';

// ============================================================
// TEAM MEMBER
// ============================================================

export interface TeamMember {
  name: string;
  role: RoleType;
  mergedRoles: RoleType[];
  provider: ProviderType;
  model: ModelType;
  dagLayer: DAGLayerType;
  preamble: string;
  agentId: string | null;
  status: 'pending' | 'active' | 'idle' | 'completed' | 'failed';
  fileOwnership: string[];
  assignedTasks: string[];
  completedTasks: string[];
}

// ============================================================
// TEAM BUILDER
// ============================================================

export interface BuildTeamInput {
  teamName: string;
  complexity: ComplexityScore;
  fileAssignments?: Record<string, string[]>; // role -> file patterns
  sprintId?: string;
}

export interface TeamConfiguration {
  members: TeamMember[];
  mergeLog: string[];
  totalAgents: number;
  layers: {
    planners: TeamMember[];
    workers: TeamMember[];
    judges: TeamMember[];
  };
}

/**
 * Build a team configuration based on complexity analysis.
 * Returns optimized team with merged roles (1-4 agents).
 */
export function buildTeam(input: BuildTeamInput): TeamConfiguration {
  const { teamName, complexity, fileAssignments, sprintId } = input;

  // Get merged role assignments based on complexity
  const mergeResult: MergeResult = mergeRoles(complexity);

  // Build team members from role assignments
  const members: TeamMember[] = mergeResult.assignments.map((assignment, index) => {
    const roleDef = ROLE_DEFINITIONS[assignment.role];
    const workerName = generateWorkerName(assignment.role, index);

    // Get file ownership
    const fileOwnership = fileAssignments?.[assignment.role] ?? [];

    // Build role-specific preamble
    const preamble = assignment.provider === 'claude'
      ? buildRolePreamble(
          assignment.role,
          workerName,
          teamName,
          assignment.mergedRoles,
          fileOwnership,
          sprintId
        )
      : buildMcpRolePreamble(
          assignment.role,
          '', // task subject filled at dispatch time
          '', // task description filled at dispatch time
          '', // working directory filled at dispatch time
          assignment.mergedRoles
        );

    return {
      name: workerName,
      role: assignment.role,
      mergedRoles: assignment.mergedRoles,
      provider: assignment.provider,
      model: assignment.model,
      dagLayer: roleDef?.dagLayer ?? 'worker',
      preamble,
      agentId: null,
      status: 'pending' as const,
      fileOwnership,
      assignedTasks: [],
      completedTasks: [],
    };
  });

  // Group by DAG layer
  const planners = members.filter(m => m.dagLayer === 'planner');
  const workers = members.filter(m => m.dagLayer === 'worker');
  const judges = members.filter(m => m.dagLayer === 'judge');

  return {
    members,
    mergeLog: mergeResult.mergeLog,
    totalAgents: members.length,
    layers: { planners, workers, judges },
  };
}

// ============================================================
// TEAM LIFECYCLE
// ============================================================

/**
 * Activate a team member (mark as active, record agent ID).
 */
export function activateMember(member: TeamMember, agentId: string): TeamMember {
  return { ...member, agentId, status: 'active' };
}

/**
 * Mark a team member as idle (finished current work).
 */
export function setMemberIdle(member: TeamMember): TeamMember {
  return { ...member, status: 'idle' };
}

/**
 * Mark a team member as completed.
 */
export function completeMember(member: TeamMember): TeamMember {
  return { ...member, status: 'completed' };
}

/**
 * Mark a team member as failed.
 */
export function failMember(member: TeamMember): TeamMember {
  return { ...member, status: 'failed' };
}

/**
 * Assign a task to a team member.
 */
export function assignTask(member: TeamMember, taskId: string): TeamMember {
  return {
    ...member,
    assignedTasks: [...member.assignedTasks, taskId],
  };
}

/**
 * Mark a task as completed for a team member.
 */
export function completeTask(member: TeamMember, taskId: string): TeamMember {
  return {
    ...member,
    assignedTasks: member.assignedTasks.filter(t => t !== taskId),
    completedTasks: [...member.completedTasks, taskId],
  };
}

// ============================================================
// TEAM QUERIES
// ============================================================

/**
 * Find team members that can handle a specific capability.
 */
export function findMembersWithCapability(
  members: TeamMember[],
  capability: string
): TeamMember[] {
  return members.filter(m => {
    const roleDef = ROLE_DEFINITIONS[m.role];
    if (!roleDef) return false;

    // Check primary role
    if (roleDef.capabilities.includes(capability)) return true;

    // Check merged roles
    for (const merged of m.mergedRoles) {
      const mergedDef = ROLE_DEFINITIONS[merged];
      if (mergedDef?.capabilities.includes(capability)) return true;
    }

    return false;
  });
}

/**
 * Get active team members.
 */
export function getActiveMembers(members: TeamMember[]): TeamMember[] {
  return members.filter(m => m.status === 'active' || m.status === 'idle');
}

/**
 * Get available members (active but not fully loaded).
 */
export function getAvailableMembers(members: TeamMember[]): TeamMember[] {
  return members.filter(m =>
    (m.status === 'active' || m.status === 'idle') &&
    m.assignedTasks.length === 0
  );
}

/**
 * Get team health summary.
 */
export function getTeamHealth(members: TeamMember[]): {
  total: number;
  active: number;
  idle: number;
  completed: number;
  failed: number;
  pending: number;
  taskLoad: Record<string, number>;
} {
  const taskLoad: Record<string, number> = {};
  for (const m of members) {
    taskLoad[m.name] = m.assignedTasks.length;
  }

  return {
    total: members.length,
    active: members.filter(m => m.status === 'active').length,
    idle: members.filter(m => m.status === 'idle').length,
    completed: members.filter(m => m.status === 'completed').length,
    failed: members.filter(m => m.status === 'failed').length,
    pending: members.filter(m => m.status === 'pending').length,
    taskLoad,
  };
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Generate a worker name from role and index.
 */
function generateWorkerName(role: RoleType, index: number): string {
  const roleDef = ROLE_DEFINITIONS[role];
  if (!roleDef) return `worker-${index}`;
  return `${role}-${roleDef.persona.toLowerCase()}`;
}

/**
 * Format team configuration for display.
 */
export function formatTeamConfig(config: TeamConfiguration): string {
  const lines: string[] = [
    `Team: ${config.totalAgents} agents`,
    '',
    'Merge Log:',
    ...config.mergeLog.map(l => `  ${l}`),
    '',
    'Members:',
  ];

  for (const m of config.members) {
    const merged = m.mergedRoles.length > 0
      ? ` (+${m.mergedRoles.join(', ')})`
      : '';
    lines.push(`  ${m.name}: ${m.role}${merged} [${m.dagLayer}/${m.provider}/${m.model}]`);
    if (m.fileOwnership.length > 0) {
      lines.push(`    Files: ${m.fileOwnership.join(', ')}`);
    }
  }

  return lines.join('\n');
}
