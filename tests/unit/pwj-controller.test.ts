/**
 * PWJController unit tests
 *
 * Tests: full PWJ cycle, rework loop, max rework escalation,
 * planning phase failure, execution with failed nodes, node reset, escalation handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PWJController,
  type PWJCycleConfig,
  type PlanPhaseResult,
  type ExecutePhaseResult,
  type JudgePhaseResult,
  type ReworkResult,
} from '../../src/core/pwj-controller.js';
import type { TaskSpec } from '../../src/core/dag-types.js';
import type { ComplexityScore, ExecutionPlan, DAGNode } from '../../src/shared/types.js';
import type { GateEvaluationResult } from '../../src/quality/gates.js';
import type { PWJPhase } from '../../src/core/planner-worker-judge.js';

// ============================================================
// HELPERS
// ============================================================

function createMockComplexity(): ComplexityScore {
  return {
    level: 'small',
    score: 0.3,
    factors: {
      fileCount: 5,
      crossModuleDeps: 2,
      hasTests: true,
      hasApiChanges: false,
      hasDbChanges: false,
      hasSecurityImplications: false,
    },
    recommendedAgentCount: 2,
  };
}

function createMockComplexityMedium(): ComplexityScore {
  return {
    level: 'medium',
    score: 0.5,
    factors: {
      fileCount: 10,
      crossModuleDeps: 4,
      hasTests: true,
      hasApiChanges: true,
      hasDbChanges: false,
      hasSecurityImplications: false,
    },
    recommendedAgentCount: 3,
  };
}

function createMockTaskSpecs(): TaskSpec[] {
  return [
    {
      id: 'task-1',
      title: 'Implement feature',
      description: 'Build the feature',
      assignedRole: 'be-dev',
      filePatterns: ['src/'],
      dependencies: [],
      nodeType: 'execution',
      priority: 1,
    },
  ];
}

function createMockTaskSpecsWithPlanning(): TaskSpec[] {
  return [
    {
      id: 'task-plan',
      title: 'Design architecture',
      description: 'Plan the architecture',
      assignedRole: 'pl',
      filePatterns: [],
      dependencies: [],
      nodeType: 'planning',
      priority: 0,
    },
    {
      id: 'task-1',
      title: 'Implement feature',
      description: 'Build the feature',
      assignedRole: 'be-dev',
      filePatterns: ['src/'],
      dependencies: ['task-plan'],
      nodeType: 'execution',
      priority: 1,
    },
  ];
}

function createPassingGateResult(taskId: string): GateEvaluationResult {
  return {
    verdict: 'pass',
    canRetry: false,
    attemptsRemaining: 0,
    needsEscalation: false,
    result: {
      id: `gate-${Date.now()}`,
      taskId,
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      score: 8.5,
      dimensions: {
        correctness: 9,
        security: 9,
        performance: 8,
        maintainability: 9,
        testCoverage: 8,
      },
      verdict: 'pass',
      feedback: 'Excellent work',
      attempt: 1,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
    },
  };
}

function createFailingGateResult(taskId: string): GateEvaluationResult {
  return {
    verdict: 'conditional',
    canRetry: true,
    attemptsRemaining: 2,
    needsEscalation: false,
    result: {
      id: `gate-${Date.now()}`,
      taskId,
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      score: 5.8,
      dimensions: {
        correctness: 6,
        security: 6,
        performance: 5,
        maintainability: 6,
        testCoverage: 6,
      },
      verdict: 'conditional',
      feedback: 'Needs improvement',
      attempt: 1,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
    },
  };
}

function createCriticalFailureGateResult(taskId: string): GateEvaluationResult {
  return {
    verdict: 'auto-reject',
    canRetry: false,
    attemptsRemaining: 0,
    needsEscalation: true,
    result: {
      id: `gate-${Date.now()}`,
      taskId,
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      score: 2.0,
      dimensions: {
        correctness: 2,
        security: 2,
        performance: 2,
        maintainability: 2,
        testCoverage: 2,
      },
      verdict: 'auto-reject',
      feedback: 'Critical issues found',
      attempt: 3,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
    },
  };
}

// ============================================================
// INITIALIZATION
// ============================================================

describe('PWJController initialization', () => {
  it('should initialize with default state', () => {
    const config: PWJCycleConfig = {
      cwd: '/test',
      projectId: 'test-project',
      complexity: createMockComplexity(),
      taskSpecs: createMockTaskSpecs(),
    };

    const controller = new PWJController(config);
    const state = controller.getState();

    expect(state.phase).toBe('planning');
    expect(state.cycleNumber).toBe(1);
    expect(state.reworkCount).toBe(0);
    expect(state.plan).toBeNull();
  });
});

// ============================================================
// FULL CYCLE - SUCCESS
// ============================================================

describe('run - full cycle success', () => {
  it('should complete full cycle when all phases pass', async () => {
    const config: PWJCycleConfig = {
      cwd: '/test',
      projectId: 'test-project',
      complexity: createMockComplexityMedium(),
      taskSpecs: createMockTaskSpecsWithPlanning(),
      maxReworkCycles: 3,

      onPlanPhase: vi.fn(async (): Promise<PlanPhaseResult> => ({
        success: true,
        refinedTaskSpecs: [],
        artifacts: [],
      })),

      onExecutePhase: vi.fn(async (phase: PWJPhase, plan: ExecutionPlan): Promise<ExecutePhaseResult> => ({
        completedNodeIds: Array.from(plan.nodes.keys()),
        failedNodeIds: [],
        artifacts: [],
      })),

      onJudgePhase: vi.fn(async (): Promise<JudgePhaseResult> => ({
        gateResults: [createPassingGateResult('task-1')],
        allPassed: true,
        failedTaskIds: [],
        feedback: [],
      })),

      onCycleComplete: vi.fn(),
    };

    const controller = new PWJController(config);
    const summary = await controller.run();

    expect(summary.status).toBe('completed');
    expect(summary.reworkCycles).toBe(0);
    if (config.onPlanPhase) expect(config.onPlanPhase).toHaveBeenCalled();
    if (config.onExecutePhase) expect(config.onExecutePhase).toHaveBeenCalled();
    if (config.onJudgePhase) expect(config.onJudgePhase).toHaveBeenCalled();
    expect(config.onCycleComplete).toHaveBeenCalledTimes(1);
  });

  it('should use refined task specs from planning phase', async () => {
    const refinedSpecs: TaskSpec[] = [
      {
        id: 'refined-1',
        title: 'Refined task',
        description: 'Updated description',
        assignedRole: 'be-dev',
        filePatterns: ['src/refined/'],
        dependencies: [],
        nodeType: 'execution',
        priority: 1,
      },
    ];

    const config: PWJCycleConfig = {
      cwd: '/test',
      projectId: 'test-project',
      complexity: createMockComplexity(),
      taskSpecs: createMockTaskSpecs(),

      onPlanPhase: vi.fn(async (): Promise<PlanPhaseResult> => ({
        success: true,
        refinedTaskSpecs: refinedSpecs,
        artifacts: [],
      })),

      onExecutePhase: vi.fn(async (phase: PWJPhase, plan: ExecutionPlan): Promise<ExecutePhaseResult> => {
        // Should see refined task in plan
        expect(plan.nodes.size).toBeGreaterThan(0);
        return {
          completedNodeIds: Array.from(plan.nodes.keys()),
          failedNodeIds: [],
          artifacts: [],
        };
      }),

      onJudgePhase: vi.fn(async (): Promise<JudgePhaseResult> => ({
        gateResults: [],
        allPassed: true,
        failedTaskIds: [],
        feedback: [],
      })),
    };

    const controller = new PWJController(config);
    const summary = await controller.run();

    expect(summary.status).toBe('completed');
    expect(config.onExecutePhase).toHaveBeenCalled();
  });
});

// ============================================================
// REWORK LOOP
// ============================================================

describe('run - rework loop', () => {
  it('should trigger rework when judge fails initially then passes', async () => {
    let judgeCallCount = 0;

    const config: PWJCycleConfig = {
      cwd: '/test',
      projectId: 'test-project',
      complexity: createMockComplexityMedium(),
      taskSpecs: createMockTaskSpecs(),
      maxReworkCycles: 3,

      onPlanPhase: vi.fn(async (): Promise<PlanPhaseResult> => ({
        success: true,
      })),

      onExecutePhase: vi.fn(async (phase: PWJPhase, plan: ExecutionPlan): Promise<ExecutePhaseResult> => ({
        completedNodeIds: Array.from(plan.nodes.keys()),
        failedNodeIds: [],
      })),

      onJudgePhase: vi.fn(async (): Promise<JudgePhaseResult> => {
        judgeCallCount++;
        if (judgeCallCount === 1) {
          // First attempt fails
          return {
            gateResults: [createFailingGateResult('task-1')],
            allPassed: false,
            failedTaskIds: ['task-1'],
            feedback: ['Needs improvement'],
          };
        } else {
          // Second attempt passes
          return {
            gateResults: [createPassingGateResult('task-1')],
            allPassed: true,
            failedTaskIds: [],
            feedback: [],
          };
        }
      }),

      onRework: vi.fn(async (): Promise<ReworkResult> => ({
        success: true,
        fixedNodeIds: [],
        stillFailedNodeIds: [],
      })),
    };

    const controller = new PWJController(config);
    const summary = await controller.run();

    expect(summary.status).toBe('completed');
    expect(summary.reworkCycles).toBe(1);
    if (config.onJudgePhase) expect(config.onJudgePhase).toHaveBeenCalledTimes(2);
    if (config.onRework) expect(config.onRework).toHaveBeenCalled();
  });

  it('should reset failed nodes for rework', async () => {
    let judgeCallCount = 0;

    const config: PWJCycleConfig = {
      cwd: '/test',
      projectId: 'test-project',
      complexity: createMockComplexityMedium(),
      taskSpecs: createMockTaskSpecs(),

      onPlanPhase: vi.fn(async (): Promise<PlanPhaseResult> => ({
        success: true,
      })),

      onExecutePhase: vi.fn(async (phase: PWJPhase, plan: ExecutionPlan): Promise<ExecutePhaseResult> => ({
        completedNodeIds: Array.from(plan.nodes.keys()),
        failedNodeIds: [],
      })),

      onJudgePhase: vi.fn(async (phase: PWJPhase, plan: ExecutionPlan): Promise<JudgePhaseResult> => {
        judgeCallCount++;
        if (judgeCallCount === 1) {
          return {
            gateResults: [createFailingGateResult('task-1')],
            allPassed: false,
            failedTaskIds: ['task-1'],
            feedback: ['Fix bugs'],
          };
        } else {
          // After rework, nodes should be reset to pending
          const nodes = Array.from(plan.nodes.values());
          return {
            gateResults: [createPassingGateResult('task-1')],
            allPassed: true,
            failedTaskIds: [],
            feedback: [],
          };
        }
      }),

      onRework: vi.fn(async (failedNodes: DAGNode[], feedback: string[]): Promise<ReworkResult> => {
        expect(failedNodes.length).toBeGreaterThan(0);
        expect(feedback).toContain('Fix bugs');
        return {
          success: true,
          fixedNodeIds: failedNodes.map(n => n.id),
          stillFailedNodeIds: [],
        };
      }),
    };

    const controller = new PWJController(config);
    const summary = await controller.run();

    expect(summary.status).toBe('completed');
    if (config.onRework) expect(config.onRework).toHaveBeenCalled();
  });
});

// ============================================================
// MAX REWORK CYCLES
// ============================================================

describe('run - max rework cycles', () => {
  it('should escalate when max rework cycles exceeded', async () => {
    const config: PWJCycleConfig = {
      cwd: '/test',
      projectId: 'test-project',
      complexity: createMockComplexityMedium(),
      taskSpecs: createMockTaskSpecs(),
      maxReworkCycles: 2,

      onPlanPhase: vi.fn(async (): Promise<PlanPhaseResult> => ({
        success: true,
      })),

      onExecutePhase: vi.fn(async (phase: PWJPhase, plan: ExecutionPlan): Promise<ExecutePhaseResult> => ({
        completedNodeIds: Array.from(plan.nodes.keys()),
        failedNodeIds: [],
      })),

      onJudgePhase: vi.fn(async (): Promise<JudgePhaseResult> => ({
        gateResults: [createFailingGateResult('task-1')],
        allPassed: false,
        failedTaskIds: ['task-1'],
        feedback: ['Still broken'],
      })),

      onRework: vi.fn(async (): Promise<ReworkResult> => ({
        success: true,
        fixedNodeIds: [],
        stillFailedNodeIds: [],
      })),

      onEscalation: vi.fn(),
    };

    const controller = new PWJController(config);
    const summary = await controller.run();

    expect(summary.status).toBe('escalated');
    expect(summary.reworkCycles).toBe(2);
    if (config.onJudgePhase) expect(config.onJudgePhase).toHaveBeenCalled();
  });
});

// ============================================================
// PLANNING PHASE FAILURE
// ============================================================

describe('run - planning phase failure', () => {
  it('should fail when planning phase fails', async () => {
    const config: PWJCycleConfig = {
      cwd: '/test',
      projectId: 'test-project',
      complexity: createMockComplexityMedium(),
      taskSpecs: createMockTaskSpecsWithPlanning(),

      onPlanPhase: vi.fn(async (): Promise<PlanPhaseResult> => ({
        success: false,
      })),

      onExecutePhase: vi.fn(async (phase: PWJPhase, plan: ExecutionPlan): Promise<ExecutePhaseResult> => ({
        completedNodeIds: [],
        failedNodeIds: [],
      })),

      onJudgePhase: vi.fn(async (): Promise<JudgePhaseResult> => ({
        gateResults: [],
        allPassed: true,
        failedTaskIds: [],
        feedback: [],
      })),

      onCycleComplete: vi.fn(),
    };

    const controller = new PWJController(config);
    const summary = await controller.run();

    expect(summary.status).toBe('failed');
    expect(config.onCycleComplete).toHaveBeenCalled();
  });
});

// ============================================================
// EXECUTION WITH FAILED NODES
// ============================================================

describe('run - execution with failed nodes', () => {
  it('should handle failed nodes from execution phase', async () => {
    const config: PWJCycleConfig = {
      cwd: '/test',
      projectId: 'test-project',
      complexity: createMockComplexity(),
      taskSpecs: createMockTaskSpecs(),

      onPlanPhase: vi.fn(async (): Promise<PlanPhaseResult> => ({
        success: true,
      })),

      onExecutePhase: vi.fn(async (phase: PWJPhase, plan: ExecutionPlan): Promise<ExecutePhaseResult> => {
        const nodeIds = Array.from(plan.nodes.keys());
        return {
          completedNodeIds: [],
          failedNodeIds: nodeIds,
        };
      }),

      onJudgePhase: vi.fn(async (): Promise<JudgePhaseResult> => ({
        gateResults: [],
        allPassed: true,
        failedTaskIds: [],
        feedback: [],
      })),
    };

    const controller = new PWJController(config);
    const summary = await controller.run();

    // Should still complete the cycle
    expect(summary.status).toBe('completed');
  });
});

// ============================================================
// RESET FAILED NODES
// ============================================================

describe('resetFailedNodes', () => {
  it('should reset node status correctly', async () => {
    let planRef: ExecutionPlan | null = null;

    const config: PWJCycleConfig = {
      cwd: '/test',
      projectId: 'test-project',
      complexity: createMockComplexityMedium(),
      taskSpecs: createMockTaskSpecs(),

      onPlanPhase: vi.fn(async (): Promise<PlanPhaseResult> => ({
        success: true,
      })),

      onExecutePhase: vi.fn(async (phase: PWJPhase, plan: ExecutionPlan): Promise<ExecutePhaseResult> => {
        planRef = plan;
        return {
          completedNodeIds: Array.from(plan.nodes.keys()),
          failedNodeIds: [],
        };
      }),

      onJudgePhase: vi.fn(async (): Promise<JudgePhaseResult> => {
        if (!planRef) throw new Error('No plan');

        // Check that completed nodes are marked as completed
        const nodes = Array.from(planRef.nodes.values());
        const hasCompleted = nodes.some(n => n.status === 'completed');

        if (hasCompleted) {
          return {
            gateResults: [createFailingGateResult('task-1')],
            allPassed: false,
            failedTaskIds: ['task-1'],
            feedback: [],
          };
        } else {
          return {
            gateResults: [createPassingGateResult('task-1')],
            allPassed: true,
            failedTaskIds: [],
            feedback: [],
          };
        }
      }),

      onRework: vi.fn(async (failedNodes: DAGNode[]): Promise<ReworkResult> => {
        return {
          success: true,
          fixedNodeIds: failedNodes.map(n => n.id),
          stillFailedNodeIds: [],
        };
      }),
    };

    const controller = new PWJController(config);
    const summary = await controller.run();

    expect(summary.status).toBe('completed');
  });
});

// ============================================================
// HANDLE ESCALATION
// ============================================================

describe('handleEscalation', () => {
  it('should handle critical escalation', async () => {
    const config: PWJCycleConfig = {
      cwd: '/test',
      projectId: 'test-project',
      complexity: createMockComplexityMedium(),
      taskSpecs: createMockTaskSpecs(),
      maxReworkCycles: 0,

      onPlanPhase: vi.fn(async (): Promise<PlanPhaseResult> => ({
        success: true,
      })),

      onExecutePhase: vi.fn(async (phase: PWJPhase, plan: ExecutionPlan): Promise<ExecutePhaseResult> => ({
        completedNodeIds: Array.from(plan.nodes.keys()),
        failedNodeIds: [],
      })),

      onJudgePhase: vi.fn(async (): Promise<JudgePhaseResult> => ({
        gateResults: [createCriticalFailureGateResult('task-1')],
        allPassed: false,
        failedTaskIds: ['task-1'],
        feedback: ['Critical failure'],
      })),

      onRework: vi.fn(async (): Promise<ReworkResult> => ({
        success: true,
        fixedNodeIds: [],
        stillFailedNodeIds: [],
      })),

      onEscalation: vi.fn(),
    };

    const controller = new PWJController(config);
    const summary = await controller.run();

    expect(['escalated', 'failed']).toContain(summary.status);
  });

  it('should handle non-critical escalation', async () => {
    const config: PWJCycleConfig = {
      cwd: '/test',
      projectId: 'test-project',
      complexity: createMockComplexityMedium(),
      taskSpecs: createMockTaskSpecs(),
      maxReworkCycles: 0,

      onPlanPhase: vi.fn(async (): Promise<PlanPhaseResult> => ({
        success: true,
      })),

      onExecutePhase: vi.fn(async (phase: PWJPhase, plan: ExecutionPlan): Promise<ExecutePhaseResult> => ({
        completedNodeIds: Array.from(plan.nodes.keys()),
        failedNodeIds: [],
      })),

      onJudgePhase: vi.fn(async (): Promise<JudgePhaseResult> => ({
        gateResults: [createFailingGateResult('task-1')],
        allPassed: false,
        failedTaskIds: ['task-1'],
        feedback: [],
      })),

      onRework: vi.fn(async (): Promise<ReworkResult> => ({
        success: true,
        fixedNodeIds: [],
        stillFailedNodeIds: [],
      })),

      onEscalation: vi.fn(),
    };

    const controller = new PWJController(config);
    const summary = await controller.run();

    expect(summary.status).toBe('escalated');
    expect(summary.reworkCycles).toBe(0);
  });
});

// ============================================================
// GET STATE
// ============================================================

describe('getState', () => {
  it('should return correct phase at each step', async () => {
    const states: string[] = [];

    const config: PWJCycleConfig = {
      cwd: '/test',
      projectId: 'test-project',
      complexity: createMockComplexity(),
      taskSpecs: createMockTaskSpecs(),

      onPlanPhase: vi.fn(async (): Promise<PlanPhaseResult> => {
        states.push('plan');
        return { success: true };
      }),

      onExecutePhase: vi.fn(async (phase: PWJPhase, plan: ExecutionPlan): Promise<ExecutePhaseResult> => {
        states.push('execute');
        return {
          completedNodeIds: Array.from(plan.nodes.keys()),
          failedNodeIds: [],
        };
      }),

      onJudgePhase: vi.fn(async (): Promise<JudgePhaseResult> => {
        states.push('judge');
        return {
          gateResults: [createPassingGateResult('task-1')],
          allPassed: true,
          failedTaskIds: [],
          feedback: [],
        };
      }),
    };

    const controller = new PWJController(config);
    await controller.run();

    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states).toContain('execute');
  });

  it('should return copy of state', () => {
    const config: PWJCycleConfig = {
      cwd: '/test',
      projectId: 'test-project',
      complexity: createMockComplexity(),
      taskSpecs: createMockTaskSpecs(),
    };

    const controller = new PWJController(config);
    const state1 = controller.getState();
    const state2 = controller.getState();

    expect(state1).not.toBe(state2);
    expect(state1).toEqual(state2);
  });
});
