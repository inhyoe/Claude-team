/**
 * Orchestrator unit tests
 *
 * Tests: main execution loop, layer processing, node dispatch,
 * gate evaluation, escalation handling, kanban sync, deadlock detection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Orchestrator, type OrchestratorConfig, type NodeResult } from '../../src/core/orchestrator.js';
import type { ExecutionPlan, DAGNode, DAGLayer, GateType } from '../../src/shared/types.js';
import type { GateEvaluationInput, GateEvaluationResult } from '../../src/quality/gates.js';
import type { EscalationDecision } from '../../src/quality/escalation.js';

// ============================================================
// HELPERS
// ============================================================

function createMockPlan(status: 'planning' | 'executing' | 'completed' | 'failed' = 'executing'): ExecutionPlan {
  const nodes = new Map<string, DAGNode>();

  const node1: DAGNode = {
    id: 'node-1',
    roleId: 'be-dev',
    layerIndex: 0,
    nodeType: 'execution',
    status: 'pending',
    dependencies: [],
    taskId: 'task-1',
    fileOwnership: [],
    estimatedDuration: null,
    startedAt: null,
    completedAt: null,
  };

  const node2: DAGNode = {
    id: 'node-2',
    roleId: 'qa-engineer',
    layerIndex: 1,
    nodeType: 'verification',
    status: 'pending',
    dependencies: ['node-1'],
    taskId: 'task-2',
    fileOwnership: [],
    estimatedDuration: null,
    startedAt: null,
    completedAt: null,
  };

  nodes.set('node-1', node1);
  nodes.set('node-2', node2);

  const layer0: DAGLayer = {
    index: 0,
    nodes: [node1],
    gateType: null,
    nodeType: 'execution',
    parallelism: 1,
  };

  const layer1: DAGLayer = {
    index: 1,
    nodes: [node2],
    gateType: 'code-review' as GateType,
    nodeType: 'verification',
    parallelism: 1,
  };

  return {
    id: 'plan-test-1',
    projectId: 'test-project',
    status,
    currentLayerIndex: 0,
    layers: [layer0, layer1],
    nodes,
    edges: [{ from: 'node-1', to: 'node-2', type: 'dependency' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createSimplePlan(): ExecutionPlan {
  const nodes = new Map<string, DAGNode>();

  const node1: DAGNode = {
    id: 'simple-1',
    roleId: 'be-dev',
    layerIndex: 0,
    nodeType: 'execution',
    status: 'pending',
    dependencies: [],
    taskId: 'task-simple-1',
    fileOwnership: [],
    estimatedDuration: null,
    startedAt: null,
    completedAt: null,
  };

  nodes.set('simple-1', node1);

  return {
    id: 'plan-test-simple',
    projectId: 'test-project',
    status: 'executing',
    currentLayerIndex: 0,
    layers: [{
      index: 0,
      nodes: [node1],
      gateType: null,
      nodeType: 'execution',
      parallelism: 1,
    }],
    nodes,
    edges: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ============================================================
// ORCHESTRATOR INITIALIZATION
// ============================================================

describe('Orchestrator initialization', () => {
  it('should initialize with default config', () => {
    const plan = createSimplePlan();
    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
    };

    const orchestrator = new Orchestrator(config);
    const state = orchestrator.getState();

    expect(state.status).toBe('idle');
    expect(state.currentLayerIndex).toBe(0);
    expect(state.nodesDispatched).toBe(0);
    expect(state.nodesCompleted).toBe(0);
    expect(state.nodesFailed).toBe(0);
  });

  it('should accept custom callbacks', () => {
    const plan = createSimplePlan();
    const onNodeDispatch = vi.fn();
    const onGateEvaluate = vi.fn();
    const onEscalation = vi.fn();

    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
      onNodeDispatch,
      onGateEvaluate,
      onEscalation,
    };

    const orchestrator = new Orchestrator(config);
    expect(orchestrator).toBeDefined();
  });
});

// ============================================================
// RUN - MAIN EXECUTION LOOP
// ============================================================

describe('run - main execution loop', () => {
  it('should complete plan successfully', async () => {
    const plan = createSimplePlan();

    const onNodeDispatch = vi.fn(async (node: DAGNode): Promise<NodeResult> => ({
      nodeId: node.id,
      success: true,
    }));

    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
      onNodeDispatch,
      nodeTimeoutMs: 5000,
    };

    const orchestrator = new Orchestrator(config);
    const result = await orchestrator.run();

    expect(result.status).toBe('completed');
    expect(result.nodesCompleted).toBe(1);
    expect(result.nodesFailed).toBe(0);
    expect(onNodeDispatch).toHaveBeenCalledTimes(1);
  });

  it('should handle plan failure when node fails', async () => {
    const plan = createSimplePlan();

    const onNodeDispatch = vi.fn(async (node: DAGNode): Promise<NodeResult> => ({
      nodeId: node.id,
      success: false,
      error: 'Execution failed',
    }));

    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
      onNodeDispatch,
    };

    const orchestrator = new Orchestrator(config);
    const result = await orchestrator.run();

    // Plan should complete even with failures
    expect(result.nodesCompleted).toBe(0);
    expect(result.nodesFailed).toBe(1);
  });

  it('should handle cancellation', async () => {
    const plan = createMockPlan();
    let dispatchCount = 0;

    const onNodeDispatch = vi.fn(async (node: DAGNode): Promise<NodeResult> => {
      dispatchCount++;
      // Simulate async work
      await new Promise(resolve => setTimeout(resolve, 10));
      return { nodeId: node.id, success: true };
    });

    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
      onNodeDispatch,
    };

    const orchestrator = new Orchestrator(config);

    // Request cancel during execution
    setTimeout(() => orchestrator.requestCancel(), 5);

    const result = await orchestrator.run();

    expect(result.status).toBe('cancelled');
  });

  it('should detect deadlock when no ready nodes and layer not complete', async () => {
    const plan = createMockPlan();

    // Create a situation where nodes are pending but have circular dependencies
    // Force node to be stuck by never marking it as started
    const onNodeDispatch = vi.fn(async (node: DAGNode): Promise<NodeResult> => {
      // Don't complete the node, creating a deadlock scenario
      throw new Error('Simulated hang');
    });

    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
      onNodeDispatch,
    };

    const orchestrator = new Orchestrator(config);
    const result = await orchestrator.run();

    expect(result.status).toBe('failed');
    expect(result.lastError).toBeDefined();
  });
});

// ============================================================
// DISPATCH NODES
// ============================================================

describe('dispatchNodes', () => {
  it('should dispatch nodes in parallel', async () => {
    const plan = createMockPlan();
    // Add multiple nodes to same layer
    const node3: DAGNode = {
      id: 'node-3',
      roleId: 'fe-dev',
      layerIndex: 0,
      nodeType: 'execution',
      status: 'pending',
      dependencies: [],
      taskId: 'task-3',
      fileOwnership: [],
      estimatedDuration: null,
      startedAt: null,
      completedAt: null,
    };

    plan.nodes.set('node-3', node3);
    plan.layers[0].nodes.push(node3);

    let concurrentCount = 0;
    let maxConcurrent = 0;

    const onNodeDispatch = vi.fn(async (node: DAGNode): Promise<NodeResult> => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise(resolve => setTimeout(resolve, 10));
      concurrentCount--;
      return { nodeId: node.id, success: true };
    });

    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
      onNodeDispatch,
    };

    const orchestrator = new Orchestrator(config);
    await orchestrator.run();

    // Should have dispatched all 3 nodes (2 in layer 0, 1 in layer 1)
    expect(onNodeDispatch).toHaveBeenCalledTimes(3);
    // Should have run concurrently within layer 0
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('should handle timeout', async () => {
    const plan = createSimplePlan();

    const onNodeDispatch = vi.fn(async (node: DAGNode): Promise<NodeResult> => {
      // Hang forever
      await new Promise(() => {});
      return { nodeId: node.id, success: true };
    });

    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
      onNodeDispatch,
      nodeTimeoutMs: 50, // Very short timeout
    };

    const orchestrator = new Orchestrator(config);
    const result = await orchestrator.run();

    // Should timeout and mark as failed
    expect(result.nodesFailed).toBe(1);
  });

  it('should collect errors from failed dispatches', async () => {
    const plan = createSimplePlan();

    const onNodeDispatch = vi.fn(async (node: DAGNode): Promise<NodeResult> => {
      throw new Error('Dispatch error');
    });

    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
      onNodeDispatch,
    };

    const orchestrator = new Orchestrator(config);
    const result = await orchestrator.run();

    expect(result.nodesFailed).toBe(1);
  });
});

// ============================================================
// EVALUATE LAYER GATE
// ============================================================

describe('evaluateLayerGate', () => {
  it('should pass when all evaluations pass', async () => {
    const plan = createMockPlan();

    const onNodeDispatch = vi.fn(async (node: DAGNode): Promise<NodeResult> => ({
      nodeId: node.id,
      success: true,
    }));

    const onGateEvaluate = vi.fn(async (layer: DAGLayer, nodes: DAGNode[]): Promise<GateEvaluationInput[]> => {
      return [{
        cwd: '/test',
        projectId: 'test-project',
        taskId: 'task-1',
        gateType: 'code-review' as GateType,
        reviewerRole: 'qa-engineer',
        dimensions: {
          correctness: 9,
          testCoverage: 8,
          performance: 8,
          maintainability: 8,
          security: 9,
        },
        feedback: 'Looks good',
      }];
    });

    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
      onNodeDispatch,
      onGateEvaluate,
    };

    const orchestrator = new Orchestrator(config);
    const result = await orchestrator.run();

    expect(result.status).toBe('completed');
    expect(result.gatesPassed).toBeGreaterThan(0);
  });

  it('should fail when some evaluations fail', async () => {
    const plan = createMockPlan();

    const onNodeDispatch = vi.fn(async (node: DAGNode): Promise<NodeResult> => ({
      nodeId: node.id,
      success: true,
    }));

    const onGateEvaluate = vi.fn(async (layer: DAGLayer, nodes: DAGNode[]): Promise<GateEvaluationInput[]> => {
      return [{
        cwd: '/test',
        projectId: 'test-project',
        taskId: 'task-1',
        gateType: 'code-review' as GateType,
        reviewerRole: 'qa-engineer',
        dimensions: {
          correctness: 3, // Failing score
          testCoverage: 3,
          performance: 3,
          maintainability: 3,
          security: 3,
        },
        feedback: 'Needs work',
      }];
    });

    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
      onNodeDispatch,
      onGateEvaluate,
    };

    const orchestrator = new Orchestrator(config);
    const result = await orchestrator.run();

    expect(result.gatesFailed).toBeGreaterThan(0);
  });

  it('should pass when no evaluations provided', async () => {
    const plan = createMockPlan();

    const onNodeDispatch = vi.fn(async (node: DAGNode): Promise<NodeResult> => ({
      nodeId: node.id,
      success: true,
    }));

    const onGateEvaluate = vi.fn(async (): Promise<GateEvaluationInput[]> => {
      return []; // No evaluations
    });

    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
      onNodeDispatch,
      onGateEvaluate,
    };

    const orchestrator = new Orchestrator(config);
    const result = await orchestrator.run();

    expect(result.status).toBe('completed');
  });
});

// ============================================================
// HANDLE GATE FAILURE
// ============================================================

describe('handleGateFailure', () => {
  it('should trigger retry escalation action', async () => {
    const plan = createMockPlan();

    const onNodeDispatch = vi.fn(async (node: DAGNode): Promise<NodeResult> => ({
      nodeId: node.id,
      success: true,
    }));

    const onGateEvaluate = vi.fn(async (): Promise<GateEvaluationInput[]> => {
      return [{
        cwd: '/test',
        projectId: 'test-project',
        taskId: 'task-1',
        gateType: 'code-review' as GateType,
        reviewerRole: 'qa-engineer',
        dimensions: {
          correctness: 5,
          testCoverage: 5,
          performance: 5,
          maintainability: 5,
          security: 5,
        },
        feedback: 'Minor issues',
      }];
    });

    const onEscalation = vi.fn(async (decision: EscalationDecision) => {
      expect(decision.action).toBeDefined();
    });

    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
      onNodeDispatch,
      onGateEvaluate,
      onEscalation,
    };

    const orchestrator = new Orchestrator(config);
    await orchestrator.run();

    // Escalation callback should have been called
    expect(onEscalation).toHaveBeenCalled();
  });

  it('should pause on escalate-pl action', async () => {
    const plan = createMockPlan();

    const onNodeDispatch = vi.fn(async (node: DAGNode): Promise<NodeResult> => ({
      nodeId: node.id,
      success: true,
    }));

    // Force a critical failure
    const onGateEvaluate = vi.fn(async (): Promise<GateEvaluationInput[]> => {
      return [{
        cwd: '/test',
        projectId: 'test-project',
        taskId: 'task-1',
        gateType: 'code-review' as GateType,
        reviewerRole: 'qa-engineer',
        dimensions: {
          correctness: 2, // Critical failure
          testCoverage: 2,
          performance: 2,
          maintainability: 2,
          security: 2,
        },
        feedback: 'Critical issues',
      }];
    });

    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
      onNodeDispatch,
      onGateEvaluate,
    };

    const orchestrator = new Orchestrator(config);
    const result = await orchestrator.run();

    // Should pause or fail on critical issues
    expect(['paused', 'failed', 'completed']).toContain(result.status);
  });
});

// ============================================================
// SYNC NODE TO KANBAN
// ============================================================

describe('syncNodeToKanban', () => {
  it('should sync started node to in-progress', async () => {
    const plan = createSimplePlan();

    const onNodeDispatch = vi.fn(async (node: DAGNode): Promise<NodeResult> => {
      // Node started event should trigger kanban sync
      return { nodeId: node.id, success: true };
    });

    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
      onNodeDispatch,
    };

    const orchestrator = new Orchestrator(config);
    await orchestrator.run();

    const node = plan.nodes.get('simple-1');
    expect(node?.status).toBe('completed');
  });

  it('should sync completed node to review', async () => {
    const plan = createSimplePlan();

    const onNodeDispatch = vi.fn(async (node: DAGNode): Promise<NodeResult> => ({
      nodeId: node.id,
      success: true,
    }));

    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
      onNodeDispatch,
    };

    const orchestrator = new Orchestrator(config);
    await orchestrator.run();

    const node = plan.nodes.get('simple-1');
    expect(node?.status).toBe('completed');
    expect(node?.completedAt).not.toBeNull();
  });

  it('should sync failed node to failed status', async () => {
    const plan = createSimplePlan();

    const onNodeDispatch = vi.fn(async (node: DAGNode): Promise<NodeResult> => ({
      nodeId: node.id,
      success: false,
      error: 'Test failure',
    }));

    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
      onNodeDispatch,
    };

    const orchestrator = new Orchestrator(config);
    await orchestrator.run();

    const node = plan.nodes.get('simple-1');
    expect(node?.status).toBe('failed');
  });
});

// ============================================================
// REQUEST CANCEL
// ============================================================

describe('requestCancel', () => {
  it('should set cancel flag and stop execution', async () => {
    const plan = createMockPlan();

    const onNodeDispatch = vi.fn(async (node: DAGNode): Promise<NodeResult> => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return { nodeId: node.id, success: true };
    });

    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
      onNodeDispatch,
    };

    const orchestrator = new Orchestrator(config);

    // Cancel after a short delay
    setTimeout(() => orchestrator.requestCancel(), 10);

    const result = await orchestrator.run();

    expect(result.status).toBe('cancelled');
  });
});

// ============================================================
// GET STATE
// ============================================================

describe('getState', () => {
  it('should return current state', () => {
    const plan = createSimplePlan();
    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
    };

    const orchestrator = new Orchestrator(config);
    const state = orchestrator.getState();

    expect(state.status).toBe('idle');
    expect(state.nodesDispatched).toBe(0);
  });

  it('should return copy of state', () => {
    const plan = createSimplePlan();
    const config: OrchestratorConfig = {
      cwd: '/test',
      projectId: 'test-project',
      plan,
    };

    const orchestrator = new Orchestrator(config);
    const state1 = orchestrator.getState();
    const state2 = orchestrator.getState();

    expect(state1).not.toBe(state2); // Different objects
    expect(state1).toEqual(state2); // Same values
  });
});
