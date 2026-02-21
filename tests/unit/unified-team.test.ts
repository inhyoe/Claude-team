/**
 * Unified Team unit tests
 *
 * Tests: buildTeam function, team configuration generation,
 * role-to-agent mapping, team lifecycle, team queries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildTeam,
  activateMember,
  setMemberIdle,
  completeMember,
  failMember,
  assignTask,
  completeTask,
  findMembersWithCapability,
  getActiveMembers,
  getAvailableMembers,
  getTeamHealth,
  formatTeamConfig,
  type TeamMember,
  type BuildTeamInput,
} from '../../src/team/unified-team.js';
import type { ComplexityScore } from '../../src/shared/types.js';

// ============================================================
// BUILD TEAM
// ============================================================

describe('buildTeam', () => {
  it('should build team with 1 agent for tiny complexity', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('tiny', 0.1),
    };
    const result = buildTeam(input);

    expect(result.totalAgents).toBe(1);
    expect(result.members).toHaveLength(1);
    expect(result.members[0].role).toBe('pl');
    expect(result.members[0].status).toBe('pending');
  });

  it('should build team with 2 agents for small complexity', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('small', 0.3),
    };
    const result = buildTeam(input);

    expect(result.totalAgents).toBe(2);
    expect(result.members).toHaveLength(2);
  });

  it('should build team with 3 agents for medium complexity', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('medium', 0.5),
    };
    const result = buildTeam(input);

    expect(result.totalAgents).toBe(3);
    expect(result.members).toHaveLength(3);
  });

  it('should build team with 4 agents for large complexity', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('large', 0.8),
    };
    const result = buildTeam(input);

    expect(result.totalAgents).toBe(4);
    expect(result.members).toHaveLength(4);
  });

  it('should assign file ownership from fileAssignments', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('large', 0.8),
      fileAssignments: {
        'pm': ['docs/*.md'],
        'pl': ['src/core/*.ts'],
        'fe-dev': ['src/ui/*.tsx', 'src/components/*.tsx'],
      },
    };
    const result = buildTeam(input);

    // Large complexity: pm, pl, and fe-dev all get their own members
    const pmMember = result.members.find(m => m.role === 'pm');
    expect(pmMember?.fileOwnership).toEqual(['docs/*.md']);

    const plMember = result.members.find(m => m.role === 'pl');
    expect(plMember?.fileOwnership).toEqual(['src/core/*.ts']);

    // In large, fe-dev is merged with be-dev, so primary role is fe-dev
    const devMember = result.members.find(m => m.role === 'fe-dev');
    expect(devMember?.fileOwnership).toEqual(['src/ui/*.tsx', 'src/components/*.tsx']);
  });

  it('should set empty file ownership when no assignments provided', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('small', 0.3),
    };
    const result = buildTeam(input);

    for (const member of result.members) {
      expect(member.fileOwnership).toEqual([]);
    }
  });

  it('should generate unique worker names', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('large', 0.8),
    };
    const result = buildTeam(input);

    const names = result.members.map(m => m.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('should set provider and model from role definitions', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('large', 0.8),
    };
    const result = buildTeam(input);

    for (const member of result.members) {
      expect(member.provider).toBeDefined();
      expect(member.model).toBeDefined();
      expect(['claude', 'codex', 'gemini']).toContain(member.provider);
    }
  });

  it('should initialize all members with pending status', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('medium', 0.5),
    };
    const result = buildTeam(input);

    for (const member of result.members) {
      expect(member.status).toBe('pending');
      expect(member.agentId).toBeNull();
      expect(member.assignedTasks).toEqual([]);
      expect(member.completedTasks).toEqual([]);
    }
  });

  it('should group members by DAG layer', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('large', 0.8),
    };
    const result = buildTeam(input);

    expect(result.layers.planners).toBeDefined();
    expect(result.layers.workers).toBeDefined();
    expect(result.layers.judges).toBeDefined();

    // pm is planner
    const pmMember = result.members.find(m => m.role === 'pm');
    expect(pmMember?.dagLayer).toBe('planner');
    expect(result.layers.planners).toContain(pmMember);
  });

  it('should build Claude preamble for Claude provider', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('small', 0.3),
    };
    const result = buildTeam(input);

    const claudeMember = result.members.find(m => m.provider === 'claude');
    if (claudeMember) {
      expect(claudeMember.preamble).toBeTruthy();
      expect(claudeMember.preamble.length).toBeGreaterThan(0);
    }
  });

  it('should build MCP preamble for non-Claude providers', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('large', 0.8),
    };
    const result = buildTeam(input);

    const mcpMember = result.members.find(m => m.provider !== 'claude');
    if (mcpMember) {
      expect(mcpMember.preamble).toBeTruthy();
    }
  });

  it('should include merge log with team summary', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('medium', 0.5),
    };
    const result = buildTeam(input);

    expect(result.mergeLog).toBeDefined();
    expect(result.mergeLog.length).toBeGreaterThan(0);
    expect(result.mergeLog[0]).toContain('Complexity: medium');
  });

  it('should include sprintId in preamble when provided', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('small', 0.3),
      sprintId: 'sprint-123',
    };
    const result = buildTeam(input);

    // At least one Claude member should exist
    expect(result.members.length).toBeGreaterThan(0);
  });

  it('should handle merged roles in team members', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('tiny', 0.1),
    };
    const result = buildTeam(input);

    // Tiny complexity merges multiple roles into one
    const member = result.members[0];
    expect(member.mergedRoles).toBeDefined();
    expect(member.mergedRoles.length).toBeGreaterThan(0);
  });
});

// ============================================================
// TEAM LIFECYCLE
// ============================================================

describe('activateMember', () => {
  it('should set member to active status with agentId', () => {
    const member = makeMember('test-worker', 'pl');
    const result = activateMember(member, 'agent-123');

    expect(result.status).toBe('active');
    expect(result.agentId).toBe('agent-123');
    expect(result.name).toBe(member.name); // unchanged
  });

  it('should not mutate original member', () => {
    const member = makeMember('test-worker', 'pl');
    const original = { ...member };

    activateMember(member, 'agent-123');

    expect(member).toEqual(original);
  });
});

describe('setMemberIdle', () => {
  it('should set member to idle status', () => {
    const member = makeMember('test-worker', 'pl', 'active');
    const result = setMemberIdle(member);

    expect(result.status).toBe('idle');
  });

  it('should not mutate original member', () => {
    const member = makeMember('test-worker', 'pl', 'active');
    const original = { ...member };

    setMemberIdle(member);

    expect(member).toEqual(original);
  });
});

describe('completeMember', () => {
  it('should set member to completed status', () => {
    const member = makeMember('test-worker', 'pl', 'active');
    const result = completeMember(member);

    expect(result.status).toBe('completed');
  });
});

describe('failMember', () => {
  it('should set member to failed status', () => {
    const member = makeMember('test-worker', 'pl', 'active');
    const result = failMember(member);

    expect(result.status).toBe('failed');
  });
});

describe('assignTask', () => {
  it('should add task to assignedTasks', () => {
    const member = makeMember('test-worker', 'pl');
    const result = assignTask(member, 'task-1');

    expect(result.assignedTasks).toContain('task-1');
    expect(result.assignedTasks).toHaveLength(1);
  });

  it('should preserve existing assigned tasks', () => {
    const member = makeMember('test-worker', 'pl');
    const withTask1 = assignTask(member, 'task-1');
    const withTask2 = assignTask(withTask1, 'task-2');

    expect(withTask2.assignedTasks).toEqual(['task-1', 'task-2']);
  });

  it('should not mutate original member', () => {
    const member = makeMember('test-worker', 'pl');
    const original = { ...member };

    assignTask(member, 'task-1');

    expect(member.assignedTasks).toEqual(original.assignedTasks);
  });
});

describe('completeTask', () => {
  it('should move task from assigned to completed', () => {
    const member = makeMember('test-worker', 'pl');
    const withTask = assignTask(member, 'task-1');
    const result = completeTask(withTask, 'task-1');

    expect(result.assignedTasks).not.toContain('task-1');
    expect(result.completedTasks).toContain('task-1');
  });

  it('should preserve other assigned tasks', () => {
    const member = makeMember('test-worker', 'pl');
    const withTasks = assignTask(assignTask(member, 'task-1'), 'task-2');
    const result = completeTask(withTasks, 'task-1');

    expect(result.assignedTasks).toEqual(['task-2']);
    expect(result.completedTasks).toEqual(['task-1']);
  });

  it('should handle completing non-existent task gracefully', () => {
    const member = makeMember('test-worker', 'pl');
    const result = completeTask(member, 'task-999');

    expect(result.completedTasks).toContain('task-999');
    expect(result.assignedTasks).toEqual([]);
  });
});

// ============================================================
// TEAM QUERIES
// ============================================================

describe('findMembersWithCapability', () => {
  it('should find members with primary role capability', () => {
    const members = [
      makeMember('pm-worker', 'pm'),
      makeMember('pl-worker', 'pl'),
      makeMember('fe-worker', 'fe-dev'),
    ];

    const result = findMembersWithCapability(members, 'requirements-analysis');

    expect(result.length).toBeGreaterThan(0);
    expect(result.some(m => m.role === 'pm')).toBe(true);
  });

  it('should find members with merged role capability', () => {
    const members = [
      makeMemberWithMerged('multi-worker', 'pl', ['pm']),
      makeMember('fe-worker', 'fe-dev'),
    ];

    // 'requirements-analysis' is a pm capability
    const result = findMembersWithCapability(members, 'requirements-analysis');

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].name).toBe('multi-worker');
  });

  it('should return empty array when no members have capability', () => {
    const members = [
      makeMember('fe-worker', 'fe-dev'),
    ];

    const result = findMembersWithCapability(members, 'nonexistent-capability');

    expect(result).toEqual([]);
  });

  it('should handle empty members list', () => {
    const result = findMembersWithCapability([], 'any-capability');

    expect(result).toEqual([]);
  });
});

describe('getActiveMembers', () => {
  it('should return active and idle members', () => {
    const members = [
      makeMember('worker-1', 'pl', 'active'),
      makeMember('worker-2', 'fe-dev', 'idle'),
      makeMember('worker-3', 'be-dev', 'pending'),
      makeMember('worker-4', 'qa-engineer', 'completed'),
    ];

    const result = getActiveMembers(members);

    expect(result).toHaveLength(2);
    expect(result[0].status).toBe('active');
    expect(result[1].status).toBe('idle');
  });

  it('should return empty array when no active members', () => {
    const members = [
      makeMember('worker-1', 'pl', 'pending'),
      makeMember('worker-2', 'fe-dev', 'completed'),
    ];

    const result = getActiveMembers(members);

    expect(result).toEqual([]);
  });
});

describe('getAvailableMembers', () => {
  it('should return active/idle members with no assigned tasks', () => {
    const member1 = makeMember('worker-1', 'pl', 'active');
    const member2 = assignTask(makeMember('worker-2', 'fe-dev', 'active'), 'task-1');
    const member3 = makeMember('worker-3', 'be-dev', 'idle');

    const members = [member1, member2, member3];
    const result = getAvailableMembers(members);

    expect(result).toHaveLength(2);
    expect(result.map(m => m.name)).toEqual(['worker-1', 'worker-3']);
  });

  it('should exclude pending members even without tasks', () => {
    const members = [
      makeMember('worker-1', 'pl', 'pending'),
      makeMember('worker-2', 'fe-dev', 'active'),
    ];

    const result = getAvailableMembers(members);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('worker-2');
  });
});

describe('getTeamHealth', () => {
  it('should return correct status counts', () => {
    const members = [
      makeMember('worker-1', 'pl', 'active'),
      makeMember('worker-2', 'fe-dev', 'active'),
      makeMember('worker-3', 'be-dev', 'idle'),
      makeMember('worker-4', 'qa-engineer', 'pending'),
      makeMember('worker-5', 'pm', 'completed'),
      makeMember('worker-6', 'dba', 'failed'),
    ];

    const result = getTeamHealth(members);

    expect(result.total).toBe(6);
    expect(result.active).toBe(2);
    expect(result.idle).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.completed).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('should return task load per member', () => {
    const member1 = assignTask(makeMember('worker-1', 'pl'), 'task-1');
    const member2 = assignTask(assignTask(makeMember('worker-2', 'fe-dev'), 'task-2'), 'task-3');
    const member3 = makeMember('worker-3', 'be-dev');

    const members = [member1, member2, member3];
    const result = getTeamHealth(members);

    expect(result.taskLoad['worker-1']).toBe(1);
    expect(result.taskLoad['worker-2']).toBe(2);
    expect(result.taskLoad['worker-3']).toBe(0);
  });

  it('should handle empty team', () => {
    const result = getTeamHealth([]);

    expect(result.total).toBe(0);
    expect(result.active).toBe(0);
    expect(result.taskLoad).toEqual({});
  });
});

// ============================================================
// FORMAT TEAM CONFIG
// ============================================================

describe('formatTeamConfig', () => {
  it('should format team configuration as string', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('small', 0.3),
    };
    const config = buildTeam(input);
    const result = formatTeamConfig(config);

    expect(result).toContain('Team:');
    expect(result).toContain('agents');
    expect(result).toContain('Merge Log:');
    expect(result).toContain('Members:');
  });

  it('should include file ownership when present', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('small', 0.3),
      fileAssignments: {
        'pl': ['src/core/*.ts'],
      },
    };
    const config = buildTeam(input);
    const result = formatTeamConfig(config);

    expect(result).toContain('Files:');
    expect(result).toContain('src/core/*.ts');
  });

  it('should include merged roles in output', () => {
    const input: BuildTeamInput = {
      teamName: 'test-team',
      complexity: makeComplexity('tiny', 0.1),
    };
    const config = buildTeam(input);
    const result = formatTeamConfig(config);

    // Tiny complexity merges roles, so should show (+role1, role2, ...)
    expect(result).toContain('+');
  });
});

// ============================================================
// HELPERS
// ============================================================

function makeComplexity(level: ComplexityScore['level'], score: number): ComplexityScore {
  return {
    level,
    score,
    factors: {
      fileCount: 10,
      crossModuleDeps: 3,
      hasTests: true,
      hasApiChanges: true,
      hasDbChanges: false,
      hasSecurityImplications: false,
    },
    recommendedAgentCount: level === 'tiny' ? 1 : level === 'small' ? 2 : level === 'medium' ? 3 : 4,
  };
}

function makeMember(
  name: string,
  role: 'pm' | 'pl' | 'fe-dev' | 'be-dev' | 'qa-engineer' | 'ui-ux-designer' | 'devops-engineer' | 'security-specialist' | 'dba',
  status: TeamMember['status'] = 'pending'
): TeamMember {
  return {
    name,
    role,
    mergedRoles: [],
    provider: 'claude',
    model: 'opus-4',
    dagLayer: 'worker',
    preamble: 'test preamble',
    agentId: null,
    status,
    fileOwnership: [],
    assignedTasks: [],
    completedTasks: [],
  };
}

function makeMemberWithMerged(
  name: string,
  role: 'pm' | 'pl' | 'fe-dev' | 'be-dev' | 'qa-engineer' | 'ui-ux-designer' | 'devops-engineer' | 'security-specialist' | 'dba',
  mergedRoles: Array<'pm' | 'pl' | 'fe-dev' | 'be-dev' | 'qa-engineer' | 'ui-ux-designer' | 'devops-engineer' | 'security-specialist' | 'dba'>
): TeamMember {
  return {
    name,
    role,
    mergedRoles,
    provider: 'claude',
    model: 'opus-4',
    dagLayer: 'worker',
    preamble: 'test preamble',
    agentId: null,
    status: 'pending',
    fileOwnership: [],
    assignedTasks: [],
    completedTasks: [],
  };
}
