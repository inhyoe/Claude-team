/**
 * Claude Team - Task Router
 *
 * Routes tasks to appropriate team members based on:
 * - Role capabilities
 * - File ownership
 * - Current availability
 * - Provider affinity
 */

import type {
  RoleType,
  KanbanItem,
  ProviderType,
} from '../shared/types.js';
import { ROLE_DEFINITIONS, PROVIDER_TOOL_MAP, PROVIDER_FALLBACK } from '../shared/constants.js';
import { matchesOwnership } from '../core/file-ownership.js';
import type { TeamMember } from './unified-team.js';

// ============================================================
// ROUTING TYPES
// ============================================================

export interface RoutingDecision {
  taskId: string;
  assignedTo: TeamMember;
  reason: string;
  confidence: number; // 0-1
  fallbackMembers: TeamMember[];
}

export interface RoutingContext {
  members: TeamMember[];
  task: KanbanItem;
  taskDescription?: string;
  requiredCapabilities?: string[];
  preferredProvider?: ProviderType;
}

// ============================================================
// TASK ROUTER
// ============================================================

/**
 * Route a task to the best available team member.
 */
export function routeTask(ctx: RoutingContext): RoutingDecision | null {
  const { members, task, taskDescription, requiredCapabilities, preferredProvider } = ctx;

  // Score each member for this task
  const scored = members
    .filter(m => m.status === 'active' || m.status === 'idle')
    .map(m => ({
      member: m,
      score: scoreMember(m, task, taskDescription, requiredCapabilities, preferredProvider),
    }))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  const best = scored[0];
  const fallbacks = scored.slice(1, 4).map(s => s.member);

  return {
    taskId: task.taskId,
    assignedTo: best.member,
    reason: explainRouting(best.member, task),
    confidence: best.score,
    fallbackMembers: fallbacks,
  };
}

/**
 * Route multiple tasks to team members (batch routing).
 */
export function routeTasks(
  members: TeamMember[],
  tasks: KanbanItem[],
  taskDescriptions?: Map<string, string>
): RoutingDecision[] {
  const decisions: RoutingDecision[] = [];
  const assignedMembers = new Set<string>();

  // Sort tasks by priority (lower = higher priority)
  const sortedTasks = [...tasks].sort((a, b) => a.priority - b.priority);

  for (const task of sortedTasks) {
    const availableMembers = members.filter(m =>
      !assignedMembers.has(m.name) &&
      (m.status === 'active' || m.status === 'idle') &&
      m.assignedTasks.length === 0
    );

    if (availableMembers.length === 0) break;

    const decision = routeTask({
      members: availableMembers,
      task,
      taskDescription: taskDescriptions?.get(task.taskId),
    });

    if (decision) {
      decisions.push(decision);
      assignedMembers.add(decision.assignedTo.name);
    }
  }

  return decisions;
}

// ============================================================
// SCORING
// ============================================================

/**
 * Score a team member's fitness for a task (0-1).
 */
function scoreMember(
  member: TeamMember,
  task: KanbanItem,
  taskDescription?: string,
  requiredCapabilities?: string[],
  preferredProvider?: ProviderType
): number {
  let score = 0;
  let factors = 0;

  // 1. Role match (0.3 weight)
  if (task.assignedRole && task.assignedRole === member.role) {
    score += 0.3;
  } else if (task.assignedRole && member.mergedRoles.includes(task.assignedRole)) {
    score += 0.2;
  }
  factors += 0.3;

  // 2. File ownership match (0.25 weight)
  const fileScore = calculateFileOwnershipScore(member, task);
  score += fileScore * 0.25;
  factors += 0.25;

  // 3. Capability match (0.2 weight)
  if (requiredCapabilities && requiredCapabilities.length > 0) {
    const capScore = calculateCapabilityScore(member, requiredCapabilities);
    score += capScore * 0.2;
  } else if (taskDescription) {
    const capScore = inferCapabilityScore(member, taskDescription);
    score += capScore * 0.2;
  }
  factors += 0.2;

  // 4. Availability (0.15 weight) - fewer assigned tasks = higher score
  const loadScore = member.assignedTasks.length === 0 ? 1.0 :
    member.assignedTasks.length === 1 ? 0.5 : 0.1;
  score += loadScore * 0.15;
  factors += 0.15;

  // 5. Provider preference (0.1 weight)
  if (preferredProvider && member.provider === preferredProvider) {
    score += 0.1;
  }
  factors += 0.1;

  return Math.min(1, score / factors);
}

/**
 * Calculate file ownership overlap score.
 */
function calculateFileOwnershipScore(member: TeamMember, task: KanbanItem): number {
  if (member.fileOwnership.length === 0 || task.fileOwnership.length === 0) return 0.5;

  let matches = 0;
  for (const taskFile of task.fileOwnership) {
    if (matchesOwnership(taskFile, member.fileOwnership)) {
      matches++;
    }
  }

  return task.fileOwnership.length > 0 ? matches / task.fileOwnership.length : 0;
}

/**
 * Calculate capability match score.
 */
function calculateCapabilityScore(member: TeamMember, required: string[]): number {
  const memberCaps = getMemberCapabilities(member);
  let matches = 0;
  for (const req of required) {
    if (memberCaps.includes(req)) matches++;
  }
  return required.length > 0 ? matches / required.length : 0;
}

/**
 * Infer capability needs from task description and score member match.
 */
function inferCapabilityScore(member: TeamMember, description: string): number {
  const memberCaps = getMemberCapabilities(member);
  const desc = description.toLowerCase();
  let matches = 0;
  let total = 0;

  // Keyword-based capability inference
  const capKeywords: Record<string, string[]> = {
    'frontend-implementation': ['frontend', 'ui', 'component', 'react', 'vue', 'css', 'html'],
    'api-implementation': ['api', 'endpoint', 'rest', 'graphql', 'route', 'handler'],
    'database-queries': ['database', 'query', 'sql', 'migration', 'schema'],
    'test-strategy': ['test', 'testing', 'spec', 'coverage', 'assertion'],
    'security-audit': ['security', 'auth', 'encryption', 'vulnerability', 'xss', 'injection'],
    'ci-cd': ['deploy', 'ci', 'cd', 'pipeline', 'docker', 'kubernetes'],
    'ui-design': ['design', 'layout', 'wireframe', 'prototype', 'ux'],
    'architecture-design': ['architecture', 'system design', 'refactor', 'structure'],
  };

  for (const [cap, keywords] of Object.entries(capKeywords)) {
    if (keywords.some(k => desc.includes(k))) {
      total++;
      if (memberCaps.includes(cap)) matches++;
    }
  }

  return total > 0 ? matches / total : 0.5;
}

/**
 * Get all capabilities of a member (including merged roles).
 */
function getMemberCapabilities(member: TeamMember): string[] {
  const caps: string[] = [];

  const primaryDef = ROLE_DEFINITIONS[member.role];
  if (primaryDef) caps.push(...primaryDef.capabilities);

  for (const merged of member.mergedRoles) {
    const mergedDef = ROLE_DEFINITIONS[merged];
    if (mergedDef) caps.push(...mergedDef.capabilities);
  }

  return caps;
}

// ============================================================
// PROVIDER ROUTING
// ============================================================

/**
 * Determine the delegation tool for a team member.
 */
export function getDelegationTool(member: TeamMember): string {
  return PROVIDER_TOOL_MAP[member.provider];
}

/**
 * Get fallback provider if primary is unavailable.
 */
export function getFallbackProvider(provider: ProviderType): ProviderType {
  return PROVIDER_FALLBACK[provider];
}

// ============================================================
// EXPLANATION
// ============================================================

/**
 * Explain why a member was chosen for a task.
 */
function explainRouting(member: TeamMember, task: KanbanItem): string {
  const reasons: string[] = [];

  if (task.assignedRole === member.role) {
    reasons.push(`role match (${member.role})`);
  } else if (task.assignedRole && member.mergedRoles.includes(task.assignedRole)) {
    reasons.push(`merged role match (${task.assignedRole} in ${member.role})`);
  }

  if (member.fileOwnership.length > 0 && task.fileOwnership.length > 0) {
    reasons.push('file ownership overlap');
  }

  if (member.assignedTasks.length === 0) {
    reasons.push('available (no current tasks)');
  }

  return reasons.length > 0 ? reasons.join(', ') : 'best available match';
}

/**
 * Format routing decisions for display.
 */
export function formatRoutingDecisions(decisions: RoutingDecision[]): string {
  return decisions.map(d =>
    `Task ${d.taskId} -> ${d.assignedTo.name} (${d.assignedTo.role}) [confidence: ${(d.confidence * 100).toFixed(0)}%] - ${d.reason}`
  ).join('\n');
}
