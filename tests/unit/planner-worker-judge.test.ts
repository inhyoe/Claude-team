/**
 * Planner-Worker-Judge (PWJ) orchestration unit tests
 *
 * Tests: role selection, layer grouping, PWJ sequence creation,
 * plan building, readiness checks, completion detection.
 */
import { describe, it, expect } from 'vitest';
import {
  selectRoles,
  getRoleLayer,
  groupByLayer,
  createPWJSequence,
  buildPWJPlan,
  isReadyForJudgment,
  isPWJComplete,
} from '../../src/core/planner-worker-judge.js';
import type { ComplexityScore, RoleAssignment, TaskSpec } from '../../src/shared/types.js';

// ============================================================
// ROLE SELECTION
// ============================================================

describe('selectRoles', () => {
  it('selects roles for tiny complexity level', () => {
    const complexity: ComplexityScore = {
      level: 'tiny',
      totalScore: 15,
      factors: { files: 5, functions: 3, dependencies: 2, testCoverage: 5 },
    };

    const roles = selectRoles(complexity);

    // Tiny projects get 1 merged role
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.length).toBeLessThanOrEqual(2);
  });

  it('selects roles for small complexity level', () => {
    const complexity: ComplexityScore = {
      level: 'small',
      totalScore: 35,
      factors: { files: 10, functions: 8, dependencies: 7, testCoverage: 10 },
    };

    const roles = selectRoles(complexity);
    expect(roles.length).toBeGreaterThan(0);
    expect(roles.length).toBeLessThanOrEqual(3);
  });

  it('selects roles for medium complexity level', () => {
    const complexity: ComplexityScore = {
      level: 'medium',
      totalScore: 55,
      factors: { files: 15, functions: 12, dependencies: 13, testCoverage: 15 },
    };

    const roles = selectRoles(complexity);
    expect(roles.length).toBeGreaterThan(1);
    expect(roles.length).toBeLessThanOrEqual(4);
  });

  it('selects roles for large complexity level', () => {
    const complexity: ComplexityScore = {
      level: 'large',
      totalScore: 75,
      factors: { files: 20, functions: 18, dependencies: 17, testCoverage: 20 },
    };

    const roles = selectRoles(complexity);
    expect(roles.length).toBeGreaterThan(2);
  });

  it('assigns unique roleIds to each assignment', () => {
    const complexity: ComplexityScore = {
      level: 'medium',
      totalScore: 55,
      factors: { files: 15, functions: 12, dependencies: 13, testCoverage: 15 },
    };

    const roles = selectRoles(complexity);
    const roleIds = roles.map(r => r.roleId);
    const uniqueIds = new Set(roleIds);

    expect(uniqueIds.size).toBe(roles.length);
  });

  it('sets status to active for all roles', () => {
    const complexity: ComplexityScore = {
      level: 'small',
      totalScore: 35,
      factors: { files: 10, functions: 8, dependencies: 7, testCoverage: 10 },
    };

    const roles = selectRoles(complexity);
    roles.forEach(role => {
      expect(role.status).toBe('active');
    });
  });

  it('includes merged roles when configured', () => {
    const complexity: ComplexityScore = {
      level: 'tiny',
      totalScore: 15,
      factors: { files: 5, functions: 3, dependencies: 2, testCoverage: 5 },
    };

    const roles = selectRoles(complexity);

    // At least one role should have merged roles
    const hasMergedRoles = roles.some(r => r.mergedRoles.length > 0);
    expect(hasMergedRoles).toBe(true);
  });
});

// ============================================================
// LAYER OPERATIONS
// ============================================================

describe('getRoleLayer', () => {
  it('returns planner layer for PM role', () => {
    expect(getRoleLayer('pm')).toBe('planner');
  });

  it('returns planner layer for PL role', () => {
    expect(getRoleLayer('pl')).toBe('planner');
  });

  it('returns worker layer for BE developer', () => {
    expect(getRoleLayer('be-dev')).toBe('worker');
  });

  it('returns worker layer for FE developer', () => {
    expect(getRoleLayer('fe-dev')).toBe('worker');
  });

  it('returns judge layer for QA engineer', () => {
    expect(getRoleLayer('qa-engineer')).toBe('judge');
  });

  it('returns judge layer for security specialist', () => {
    expect(getRoleLayer('security-specialist')).toBe('judge');
  });

  it('returns worker as default for unknown role', () => {
    // Cast to avoid type error for test purposes
    const unknownRole = 'unknown-role' as any;
    expect(getRoleLayer(unknownRole)).toBe('worker');
  });
});

describe('groupByLayer', () => {
  it('groups roles by their DAG layers', () => {
    const roles: RoleAssignment[] = [
      {
        roleId: 'r1',
        role: 'pm',
        personaName: 'Product Manager',
        agentName: '',
        provider: 'claude',
        model: 'opus',
        isMergedInto: null,
        mergedRoles: [],
        status: 'active',
      },
      {
        roleId: 'r2',
        role: 'be-dev',
        personaName: 'Backend Developer',
        agentName: '',
        provider: 'claude',
        model: 'sonnet',
        isMergedInto: null,
        mergedRoles: [],
        status: 'active',
      },
      {
        roleId: 'r3',
        role: 'qa-engineer',
        personaName: 'QA Engineer',
        agentName: '',
        provider: 'codex',
        model: 'sonnet',
        isMergedInto: null,
        mergedRoles: [],
        status: 'active',
      },
    ];

    const groups = groupByLayer(roles);

    expect(groups.planner).toHaveLength(1);
    expect(groups.planner[0].role).toBe('pm');
    expect(groups.worker).toHaveLength(1);
    expect(groups.worker[0].role).toBe('be-dev');
    expect(groups.judge).toHaveLength(1);
    expect(groups.judge[0].role).toBe('qa-engineer');
  });

  it('returns empty arrays for layers with no roles', () => {
    const roles: RoleAssignment[] = [
      {
        roleId: 'r1',
        role: 'be-dev',
        personaName: 'Backend Developer',
        agentName: '',
        provider: 'claude',
        model: 'sonnet',
        isMergedInto: null,
        mergedRoles: [],
        status: 'active',
      },
    ];

    const groups = groupByLayer(roles);

    expect(groups.planner).toHaveLength(0);
    expect(groups.worker).toHaveLength(1);
    expect(groups.judge).toHaveLength(0);
  });

  it('handles multiple roles in same layer', () => {
    const roles: RoleAssignment[] = [
      {
        roleId: 'r1',
        role: 'be-dev',
        personaName: 'Backend Developer',
        agentName: '',
        provider: 'claude',
        model: 'sonnet',
        isMergedInto: null,
        mergedRoles: [],
        status: 'active',
      },
      {
        roleId: 'r2',
        role: 'fe-dev',
        personaName: 'Frontend Developer',
        agentName: '',
        provider: 'claude',
        model: 'sonnet',
        isMergedInto: null,
        mergedRoles: [],
        status: 'active',
      },
    ];

    const groups = groupByLayer(roles);

    expect(groups.worker).toHaveLength(2);
  });
});

// ============================================================
// PWJ SEQUENCE CREATION
// ============================================================

describe('createPWJSequence', () => {
  it('creates plan-execute-judge sequence for full project', () => {
    const roles: RoleAssignment[] = [
      {
        roleId: 'r1',
        role: 'pl',
        personaName: 'Project Lead',
        agentName: '',
        provider: 'claude',
        model: 'opus',
        isMergedInto: null,
        mergedRoles: [],
        status: 'active',
      },
      {
        roleId: 'r2',
        role: 'be-dev',
        personaName: 'Backend Developer',
        agentName: '',
        provider: 'claude',
        model: 'sonnet',
        isMergedInto: null,
        mergedRoles: [],
        status: 'active',
      },
      {
        roleId: 'r3',
        role: 'qa-engineer',
        personaName: 'QA Engineer',
        agentName: '',
        provider: 'codex',
        model: 'sonnet',
        isMergedInto: null,
        mergedRoles: [],
        status: 'active',
      },
    ];

    const taskSpecs: TaskSpec[] = [
      {
        id: 'task-1',
        title: 'Design architecture',
        nodeType: 'planning',
        assignedRole: 'pl',
        dependencies: [],
        priority: 1,
      },
      {
        id: 'task-2',
        title: 'Implement backend',
        nodeType: 'execution',
        assignedRole: 'be-dev',
        dependencies: ['task-1'],
        priority: 2,
      },
      {
        id: 'task-3',
        title: 'Test implementation',
        nodeType: 'verification',
        assignedRole: 'qa-engineer',
        dependencies: ['task-2'],
        priority: 3,
      },
    ];

    const sequence = createPWJSequence(roles, taskSpecs);

    expect(sequence).toHaveLength(3);
    expect(sequence[0].name).toBe('plan');
    expect(sequence[1].name).toBe('execute');
    expect(sequence[2].name).toBe('judge');
  });

  it('creates auto-generated review tasks when no verification tasks exist', () => {
    const roles: RoleAssignment[] = [
      {
        roleId: 'r1',
        role: 'be-dev',
        personaName: 'Backend Developer',
        agentName: '',
        provider: 'claude',
        model: 'sonnet',
        isMergedInto: null,
        mergedRoles: [],
        status: 'active',
      },
      {
        roleId: 'r2',
        role: 'qa-engineer',
        personaName: 'QA Engineer',
        agentName: '',
        provider: 'codex',
        model: 'sonnet',
        isMergedInto: null,
        mergedRoles: [],
        status: 'active',
      },
    ];

    const taskSpecs: TaskSpec[] = [
      {
        id: 'task-1',
        title: 'Implement feature',
        nodeType: 'execution',
        assignedRole: 'be-dev',
        dependencies: [],
        priority: 1,
      },
    ];

    const sequence = createPWJSequence(roles, taskSpecs);

    const judgePhase = sequence.find(p => p.name === 'judge');
    expect(judgePhase).toBeDefined();
    expect(judgePhase!.tasks.length).toBeGreaterThan(0);
    expect(judgePhase!.tasks[0].title).toContain('Review:');
  });

  it('skips plan phase when no planning tasks and no planners', () => {
    const roles: RoleAssignment[] = [
      {
        roleId: 'r1',
        role: 'be-dev',
        personaName: 'Backend Developer',
        agentName: '',
        provider: 'claude',
        model: 'sonnet',
        isMergedInto: null,
        mergedRoles: [],
        status: 'active',
      },
    ];

    const taskSpecs: TaskSpec[] = [
      {
        id: 'task-1',
        title: 'Implement feature',
        nodeType: 'execution',
        assignedRole: 'be-dev',
        dependencies: [],
        priority: 1,
      },
    ];

    const sequence = createPWJSequence(roles, taskSpecs);

    const planPhase = sequence.find(p => p.name === 'plan');
    expect(planPhase).toBeUndefined();
  });

  it('includes design tasks in plan phase', () => {
    const roles: RoleAssignment[] = [
      {
        roleId: 'r1',
        role: 'pl',
        personaName: 'Project Lead',
        agentName: '',
        provider: 'claude',
        model: 'opus',
        isMergedInto: null,
        mergedRoles: [],
        status: 'active',
      },
    ];

    const taskSpecs: TaskSpec[] = [
      {
        id: 'task-1',
        title: 'Design UI',
        nodeType: 'design',
        assignedRole: 'pl',
        dependencies: [],
        priority: 1,
      },
    ];

    const sequence = createPWJSequence(roles, taskSpecs);

    const planPhase = sequence.find(p => p.name === 'plan');
    expect(planPhase).toBeDefined();
    expect(planPhase!.tasks).toHaveLength(1);
    expect(planPhase!.tasks[0].nodeType).toBe('design');
  });

  it('includes deployment tasks in execute phase', () => {
    const roles: RoleAssignment[] = [
      {
        roleId: 'r1',
        role: 'devops-engineer',
        personaName: 'DevOps Engineer',
        agentName: '',
        provider: 'codex',
        model: 'sonnet',
        isMergedInto: null,
        mergedRoles: [],
        status: 'active',
      },
    ];

    const taskSpecs: TaskSpec[] = [
      {
        id: 'task-1',
        title: 'Deploy to production',
        nodeType: 'deployment',
        assignedRole: 'devops-engineer',
        dependencies: [],
        priority: 1,
      },
    ];

    const sequence = createPWJSequence(roles, taskSpecs);

    const execPhase = sequence.find(p => p.name === 'execute');
    expect(execPhase).toBeDefined();
    expect(execPhase!.tasks).toHaveLength(1);
    expect(execPhase!.tasks[0].nodeType).toBe('deployment');
  });
});

// ============================================================
// PLAN BUILDING
// ============================================================

describe('buildPWJPlan', () => {
  it('builds execution plan with roles and tasks', () => {
    const complexity: ComplexityScore = {
      level: 'medium',
      totalScore: 55,
      factors: { files: 15, functions: 12, dependencies: 13, testCoverage: 15 },
    };

    const taskSpecs: TaskSpec[] = [
      {
        id: 'task-1',
        title: 'Plan feature',
        nodeType: 'planning',
        assignedRole: 'pl',
        dependencies: [],
        priority: 1,
      },
      {
        id: 'task-2',
        title: 'Implement feature',
        nodeType: 'execution',
        assignedRole: 'be-dev',
        dependencies: ['task-1'],
        priority: 2,
      },
    ];

    const result = buildPWJPlan('proj-1', complexity, taskSpecs);

    expect(result.roles.length).toBeGreaterThan(0);
    expect(result.plan.projectId).toBe('proj-1');
    expect(result.plan.nodes.size).toBe(taskSpecs.length);
    expect(result.plan.status).toBe('executing');
  });

  it('creates nodes with correct dependencies', () => {
    const complexity: ComplexityScore = {
      level: 'small',
      totalScore: 35,
      factors: { files: 10, functions: 8, dependencies: 7, testCoverage: 10 },
    };

    const taskSpecs: TaskSpec[] = [
      {
        id: 'task-1',
        title: 'Task 1',
        nodeType: 'execution',
        assignedRole: 'be-dev',
        dependencies: [],
        priority: 1,
      },
      {
        id: 'task-2',
        title: 'Task 2',
        nodeType: 'execution',
        assignedRole: 'be-dev',
        dependencies: ['task-1'],
        priority: 2,
      },
    ];

    const result = buildPWJPlan('proj-2', complexity, taskSpecs);

    // DAG engine prefixes node IDs with 'node-'
    const node2 = result.plan.nodes.get('node-task-2');
    expect(node2).toBeDefined();
    expect(node2!.dependencies).toContain('node-task-1');
  });
});

// ============================================================
// READINESS AND COMPLETION CHECKS
// ============================================================

describe('isReadyForJudgment', () => {
  it('returns true when all non-verification nodes are completed', () => {
    const complexity: ComplexityScore = {
      level: 'small',
      totalScore: 35,
      factors: { files: 10, functions: 8, dependencies: 7, testCoverage: 10 },
    };

    const taskSpecs: TaskSpec[] = [
      {
        id: 'task-1',
        title: 'Execute',
        nodeType: 'execution',
        assignedRole: 'be-dev',
        dependencies: [],
        priority: 1,
      },
      {
        id: 'task-2',
        title: 'Verify',
        nodeType: 'verification',
        assignedRole: 'qa-engineer',
        dependencies: ['task-1'],
        priority: 2,
      },
    ];

    const { plan } = buildPWJPlan('proj-3', complexity, taskSpecs);

    // Mark execution task as completed (DAG engine prefixes with 'node-')
    const execNode = plan.nodes.get('node-task-1');
    if (execNode) {
      execNode.status = 'completed';
    }

    expect(isReadyForJudgment(plan)).toBe(true);
  });

  it('returns false when execution nodes are still in progress', () => {
    const complexity: ComplexityScore = {
      level: 'small',
      totalScore: 35,
      factors: { files: 10, functions: 8, dependencies: 7, testCoverage: 10 },
    };

    const taskSpecs: TaskSpec[] = [
      {
        id: 'task-1',
        title: 'Execute',
        nodeType: 'execution',
        assignedRole: 'be-dev',
        dependencies: [],
        priority: 1,
      },
    ];

    const { plan } = buildPWJPlan('proj-4', complexity, taskSpecs);

    expect(isReadyForJudgment(plan)).toBe(false);
  });

  it('returns true when execution nodes are skipped', () => {
    const complexity: ComplexityScore = {
      level: 'small',
      totalScore: 35,
      factors: { files: 10, functions: 8, dependencies: 7, testCoverage: 10 },
    };

    const taskSpecs: TaskSpec[] = [
      {
        id: 'task-1',
        title: 'Execute',
        nodeType: 'execution',
        assignedRole: 'be-dev',
        dependencies: [],
        priority: 1,
      },
    ];

    const { plan } = buildPWJPlan('proj-5', complexity, taskSpecs);

    const execNode = plan.nodes.get('node-task-1');
    if (execNode) {
      execNode.status = 'skipped';
    }

    expect(isReadyForJudgment(plan)).toBe(true);
  });
});

describe('isPWJComplete', () => {
  it('returns true when all nodes are completed', () => {
    const complexity: ComplexityScore = {
      level: 'small',
      totalScore: 35,
      factors: { files: 10, functions: 8, dependencies: 7, testCoverage: 10 },
    };

    const taskSpecs: TaskSpec[] = [
      {
        id: 'task-1',
        title: 'Execute',
        nodeType: 'execution',
        assignedRole: 'be-dev',
        dependencies: [],
        priority: 1,
      },
    ];

    const { plan } = buildPWJPlan('proj-6', complexity, taskSpecs);

    plan.nodes.forEach(node => {
      node.status = 'completed';
    });

    expect(isPWJComplete(plan)).toBe(true);
  });

  it('returns false when any node is not completed or skipped', () => {
    const complexity: ComplexityScore = {
      level: 'small',
      totalScore: 35,
      factors: { files: 10, functions: 8, dependencies: 7, testCoverage: 10 },
    };

    const taskSpecs: TaskSpec[] = [
      {
        id: 'task-1',
        title: 'Task 1',
        nodeType: 'execution',
        assignedRole: 'be-dev',
        dependencies: [],
        priority: 1,
      },
      {
        id: 'task-2',
        title: 'Task 2',
        nodeType: 'execution',
        assignedRole: 'be-dev',
        dependencies: [],
        priority: 2,
      },
    ];

    const { plan } = buildPWJPlan('proj-7', complexity, taskSpecs);

    const node1 = plan.nodes.get('task-1');
    if (node1) {
      node1.status = 'completed';
    }
    // task-2 remains pending

    expect(isPWJComplete(plan)).toBe(false);
  });

  it('returns true when all nodes are either completed or skipped', () => {
    const complexity: ComplexityScore = {
      level: 'small',
      totalScore: 35,
      factors: { files: 10, functions: 8, dependencies: 7, testCoverage: 10 },
    };

    const taskSpecs: TaskSpec[] = [
      {
        id: 'task-1',
        title: 'Task 1',
        nodeType: 'execution',
        assignedRole: 'be-dev',
        dependencies: [],
        priority: 1,
      },
      {
        id: 'task-2',
        title: 'Task 2',
        nodeType: 'execution',
        assignedRole: 'be-dev',
        dependencies: [],
        priority: 2,
      },
    ];

    const { plan } = buildPWJPlan('proj-8', complexity, taskSpecs);

    const node1 = plan.nodes.get('node-task-1');
    const node2 = plan.nodes.get('node-task-2');
    if (node1) node1.status = 'completed';
    if (node2) node2.status = 'skipped';

    expect(isPWJComplete(plan)).toBe(true);
  });
});
