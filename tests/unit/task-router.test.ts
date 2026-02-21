/**
 * Task Router unit tests
 *
 * Tests: routing decisions, scoring, batch routing, provider routing, file ownership matching.
 */
import { describe, it, expect } from 'vitest';
import {
  routeTask,
  routeTasks,
  getDelegationTool,
  getFallbackProvider,
  formatRoutingDecisions,
} from '../../src/team/task-router.js';
import type { TeamMember } from '../../src/team/unified-team.js';
import type { KanbanItem, RoleType, ProviderType } from '../../src/shared/types.js';

// ============================================================
// HELPERS
// ============================================================

function makeMember(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    name: 'be-dev-morgan',
    role: 'be-dev' as RoleType,
    mergedRoles: [],
    provider: 'claude' as ProviderType,
    model: 'sonnet',
    dagLayer: 'worker',
    preamble: '',
    agentId: null,
    status: 'active',
    fileOwnership: [],
    assignedTasks: [],
    completedTasks: [],
    ...overrides,
  };
}

function makeTask(overrides: Partial<KanbanItem> = {}): KanbanItem {
  return {
    id: 'task-1',
    taskId: 'task-1',
    title: 'Implement API endpoint',
    status: 'todo',
    assignedRole: null,
    priority: 3,
    complexityScore: 0.5,
    fileOwnership: [],
    reviewScore: null,
    sprintId: null,
    dagNodeId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    movedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================
// ROUTE TASK
// ============================================================

describe('routeTask', () => {
  it('should route task to matching role member', () => {
    const members = [
      makeMember({ name: 'fe-sam', role: 'fe-dev' }),
      makeMember({ name: 'be-morgan', role: 'be-dev' }),
    ];
    const task = makeTask({ assignedRole: 'be-dev' });

    const result = routeTask({ members, task });
    expect(result).not.toBeNull();
    expect(result!.assignedTo.role).toBe('be-dev');
  });

  it('should return null when no members available', () => {
    const members = [
      makeMember({ status: 'completed' }),
      makeMember({ name: 'other', status: 'failed' }),
    ];
    const task = makeTask();

    const result = routeTask({ members, task });
    expect(result).toBeNull();
  });

  it('should prefer members with file ownership overlap', () => {
    const members = [
      makeMember({ name: 'fe-sam', role: 'fe-dev', fileOwnership: ['src/ui/**'] }),
      makeMember({ name: 'be-morgan', role: 'be-dev', fileOwnership: ['src/api/**'] }),
    ];
    const task = makeTask({ fileOwnership: ['src/api/users.ts'] });

    const result = routeTask({ members, task });
    expect(result).not.toBeNull();
    expect(result!.assignedTo.name).toBe('be-morgan');
  });

  it('should consider merged roles for matching', () => {
    const members = [
      makeMember({ name: 'fe-sam', role: 'fe-dev', mergedRoles: ['ui-ux-designer'] }),
    ];
    const task = makeTask({ assignedRole: 'ui-ux-designer' });

    const result = routeTask({ members, task });
    expect(result).not.toBeNull();
    expect(result!.assignedTo.role).toBe('fe-dev');
  });

  it('should prefer idle/active members over loaded ones', () => {
    const members = [
      makeMember({ name: 'loaded', role: 'be-dev', assignedTasks: ['t1', 't2'] }),
      makeMember({ name: 'free', role: 'be-dev', assignedTasks: [] }),
    ];
    const task = makeTask({ assignedRole: 'be-dev' });

    const result = routeTask({ members, task });
    expect(result!.assignedTo.name).toBe('free');
  });

  it('should include fallback members in result', () => {
    const members = [
      makeMember({ name: 'a', role: 'fe-dev' }),
      makeMember({ name: 'b', role: 'be-dev' }),
      makeMember({ name: 'c', role: 'be-dev' }),
    ];
    const task = makeTask({ assignedRole: 'be-dev' });

    const result = routeTask({ members, task });
    expect(result).not.toBeNull();
    expect(result!.fallbackMembers.length).toBeGreaterThan(0);
  });

  it('should include confidence score between 0 and 1', () => {
    const members = [makeMember()];
    const task = makeTask({ assignedRole: 'be-dev' });

    const result = routeTask({ members, task });
    expect(result!.confidence).toBeGreaterThanOrEqual(0);
    expect(result!.confidence).toBeLessThanOrEqual(1);
  });
});

// ============================================================
// BATCH ROUTING
// ============================================================

describe('routeTasks', () => {
  it('should route multiple tasks to different members', () => {
    const members = [
      makeMember({ name: 'fe-sam', role: 'fe-dev' }),
      makeMember({ name: 'be-morgan', role: 'be-dev' }),
    ];
    const tasks = [
      makeTask({ id: 't1', taskId: 't1', assignedRole: 'fe-dev', priority: 1 }),
      makeTask({ id: 't2', taskId: 't2', assignedRole: 'be-dev', priority: 2 }),
    ];

    const decisions = routeTasks(members, tasks);
    expect(decisions).toHaveLength(2);

    const assignedNames = decisions.map(d => d.assignedTo.name);
    expect(new Set(assignedNames).size).toBe(2); // No duplicate assignments
  });

  it('should prioritize higher priority tasks first', () => {
    const members = [
      makeMember({ name: 'worker', role: 'be-dev' }),
    ];
    const tasks = [
      makeTask({ id: 'low', taskId: 'low', priority: 5 }),
      makeTask({ id: 'high', taskId: 'high', priority: 1 }),
    ];

    const decisions = routeTasks(members, tasks);
    // Only 1 member, so only 1 task routed — should be the high priority one
    expect(decisions).toHaveLength(1);
    expect(decisions[0].taskId).toBe('high');
  });

  it('should stop when no available members remain', () => {
    const members = [makeMember({ name: 'single' })];
    const tasks = [
      makeTask({ id: 't1', taskId: 't1' }),
      makeTask({ id: 't2', taskId: 't2' }),
      makeTask({ id: 't3', taskId: 't3' }),
    ];

    const decisions = routeTasks(members, tasks);
    expect(decisions).toHaveLength(1);
  });
});

// ============================================================
// PROVIDER ROUTING
// ============================================================

describe('getDelegationTool', () => {
  it('should return Task for claude members', () => {
    const member = makeMember({ provider: 'claude' });
    expect(getDelegationTool(member)).toBe('Task');
  });

  it('should return ask_codex for codex members', () => {
    const member = makeMember({ provider: 'codex' });
    expect(getDelegationTool(member)).toBe('ask_codex');
  });

  it('should return ask_gemini for gemini members', () => {
    const member = makeMember({ provider: 'gemini' });
    expect(getDelegationTool(member)).toBe('ask_gemini');
  });
});

describe('getFallbackProvider', () => {
  it('should fallback claude to itself (no external fallback)', () => {
    expect(getFallbackProvider('claude')).toBe('claude');
  });

  it('should fallback codex to claude', () => {
    expect(getFallbackProvider('codex')).toBe('claude');
  });
});

// ============================================================
// FORMATTING
// ============================================================

describe('formatRoutingDecisions', () => {
  it('should format decisions as readable string', () => {
    const members = [makeMember({ name: 'be-morgan', role: 'be-dev' })];
    const task = makeTask({ assignedRole: 'be-dev' });
    const decision = routeTask({ members, task });

    const formatted = formatRoutingDecisions([decision!]);
    expect(formatted).toContain('be-morgan');
    expect(formatted).toContain('be-dev');
    expect(formatted).toContain('%');
  });
});
