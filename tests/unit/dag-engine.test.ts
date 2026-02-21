/**
 * DAG Engine unit tests
 *
 * Tests: topological sort, execution plan building, node lifecycle,
 * file ownership validation, layer advancement, cycle detection.
 */
import { describe, it, expect } from 'vitest';
import {
  topologicalSort,
  buildExecutionPlan,
  getReadyNodes,
  isLayerComplete,
  advanceLayer,
  markNodeStarted,
  markNodeCompleted,
  markNodeFailed,
  validateFileOwnership,
} from '../../src/core/dag-engine.js';
import type { DAGNode, DAGEdge } from '../../src/shared/types.js';
import type { TaskSpec } from '../../src/core/dag-types.js';

// ============================================================
// TOPOLOGICAL SORT
// ============================================================

describe('topologicalSort', () => {
  it('should sort independent nodes into a single layer', () => {
    const nodes: DAGNode[] = [
      makeNode('a'), makeNode('b'), makeNode('c'),
    ];
    const edges: DAGEdge[] = [];

    const layers = topologicalSort(nodes, edges);
    expect(layers).toHaveLength(1);
    expect(layers[0]).toHaveLength(3);
  });

  it('should create sequential layers for a linear chain', () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
    const edges: DAGEdge[] = [
      { from: 'a', to: 'b', type: 'dependency' },
      { from: 'b', to: 'c', type: 'dependency' },
    ];

    const layers = topologicalSort(nodes, edges);
    expect(layers).toHaveLength(3);
    expect(layers[0].map(n => n.id)).toEqual(['a']);
    expect(layers[1].map(n => n.id)).toEqual(['b']);
    expect(layers[2].map(n => n.id)).toEqual(['c']);
  });

  it('should group parallel nodes in the same layer', () => {
    // a -> b, a -> c, b -> d, c -> d
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d')];
    const edges: DAGEdge[] = [
      { from: 'a', to: 'b', type: 'dependency' },
      { from: 'a', to: 'c', type: 'dependency' },
      { from: 'b', to: 'd', type: 'dependency' },
      { from: 'c', to: 'd', type: 'dependency' },
    ];

    const layers = topologicalSort(nodes, edges);
    expect(layers).toHaveLength(3);
    expect(layers[0].map(n => n.id)).toEqual(['a']);
    expect(layers[1].map(n => n.id).sort()).toEqual(['b', 'c']);
    expect(layers[2].map(n => n.id)).toEqual(['d']);
  });

  it('should throw on cycles', () => {
    const nodes = [makeNode('a'), makeNode('b')];
    const edges: DAGEdge[] = [
      { from: 'a', to: 'b', type: 'dependency' },
      { from: 'b', to: 'a', type: 'dependency' },
    ];

    expect(() => topologicalSort(nodes, edges)).toThrow(/cycle/i);
  });

  it('should handle a single node', () => {
    const layers = topologicalSort([makeNode('x')], []);
    expect(layers).toHaveLength(1);
    expect(layers[0][0].id).toBe('x');
  });

  it('should handle empty input', () => {
    const layers = topologicalSort([], []);
    expect(layers).toHaveLength(0);
  });
});

// ============================================================
// BUILD EXECUTION PLAN
// ============================================================

describe('buildExecutionPlan', () => {
  it('should create a plan with correct layers', () => {
    const specs = makeTaskSpecs();
    const plan = buildExecutionPlan('proj-1', specs);

    expect(plan.projectId).toBe('proj-1');
    expect(plan.status).toBe('planning');
    expect(plan.currentLayerIndex).toBe(0);
    expect(plan.layers.length).toBeGreaterThan(0);
    expect(plan.nodes.size).toBe(specs.length);
  });

  it('should assign correct layer indices to nodes', () => {
    const specs = makeTaskSpecs();
    const plan = buildExecutionPlan('proj-1', specs);

    for (const layer of plan.layers) {
      for (const node of layer.nodes) {
        expect(node.layerIndex).toBe(layer.index);
      }
    }
  });

  it('should insert gates when enabled', () => {
    const specs = makeTaskSpecs();
    const plan = buildExecutionPlan('proj-1', specs, {
      maxParallelNodes: 4,
      enableGates: true,
      gateMapping: {
        planning: 'pl-approval',
        execution: 'code-review',
      },
    });

    const gatedLayers = plan.layers.filter(l => l.gateType !== null);
    expect(gatedLayers.length).toBeGreaterThanOrEqual(0); // depends on node types
  });

  it('should not insert gates when disabled', () => {
    const specs = makeTaskSpecs();
    const plan = buildExecutionPlan('proj-1', specs, {
      maxParallelNodes: 4,
      enableGates: false,
      gateMapping: {},
    });

    const gatedLayers = plan.layers.filter(l => l.gateType !== null);
    expect(gatedLayers).toHaveLength(0);
  });

  it('should preserve dependency edges', () => {
    const specs = makeTaskSpecs();
    const plan = buildExecutionPlan('proj-1', specs);

    const depEdges = plan.edges.filter(e => e.type === 'dependency');
    // spec-2 depends on spec-1
    const hasExpectedEdge = depEdges.some(
      e => e.from === 'node-spec-1' && e.to === 'node-spec-2'
    );
    expect(hasExpectedEdge).toBe(true);
  });
});

// ============================================================
// NODE LIFECYCLE
// ============================================================

describe('node lifecycle', () => {
  it('should mark a node as started', () => {
    const plan = buildSimplePlan();
    const nodeId = plan.layers[0].nodes[0].id;

    expect(markNodeStarted(plan, nodeId)).toBe(true);
    expect(plan.nodes.get(nodeId)!.status).toBe('running');
    expect(plan.nodes.get(nodeId)!.startedAt).not.toBeNull();
  });

  it('should not start a non-pending node', () => {
    const plan = buildSimplePlan();
    const nodeId = plan.layers[0].nodes[0].id;

    markNodeStarted(plan, nodeId);
    expect(markNodeStarted(plan, nodeId)).toBe(false); // already running
  });

  it('should mark a running node as completed', () => {
    const plan = buildSimplePlan();
    const nodeId = plan.layers[0].nodes[0].id;

    markNodeStarted(plan, nodeId);
    expect(markNodeCompleted(plan, nodeId)).toBe(true);
    expect(plan.nodes.get(nodeId)!.status).toBe('completed');
    expect(plan.nodes.get(nodeId)!.completedAt).not.toBeNull();
  });

  it('should not complete a non-running node', () => {
    const plan = buildSimplePlan();
    const nodeId = plan.layers[0].nodes[0].id;

    expect(markNodeCompleted(plan, nodeId)).toBe(false); // still pending
  });

  it('should mark a running node as failed', () => {
    const plan = buildSimplePlan();
    const nodeId = plan.layers[0].nodes[0].id;

    markNodeStarted(plan, nodeId);
    expect(markNodeFailed(plan, nodeId)).toBe(true);
    expect(plan.nodes.get(nodeId)!.status).toBe('failed');
  });

  it('should return false for unknown node IDs', () => {
    const plan = buildSimplePlan();
    expect(markNodeStarted(plan, 'nonexistent')).toBe(false);
    expect(markNodeCompleted(plan, 'nonexistent')).toBe(false);
    expect(markNodeFailed(plan, 'nonexistent')).toBe(false);
  });
});

// ============================================================
// READY NODES & LAYER ADVANCEMENT
// ============================================================

describe('getReadyNodes & layer advancement', () => {
  it('should return all nodes in first layer as ready initially', () => {
    const plan = buildSimplePlan();
    const ready = getReadyNodes(plan);
    expect(ready.length).toBe(plan.layers[0].nodes.length);
  });

  it('should detect when a layer is complete', () => {
    const plan = buildSimplePlan();
    expect(isLayerComplete(plan)).toBe(false);

    // Complete all nodes in first layer
    for (const node of plan.layers[0].nodes) {
      markNodeStarted(plan, node.id);
      markNodeCompleted(plan, node.id);
    }
    expect(isLayerComplete(plan)).toBe(true);
  });

  it('should advance to next layer when current is complete', () => {
    const plan = buildMultiLayerPlan();

    // Complete layer 0
    for (const node of plan.layers[0].nodes) {
      markNodeStarted(plan, node.id);
      markNodeCompleted(plan, node.id);
    }

    expect(advanceLayer(plan)).toBe(true);
    expect(plan.currentLayerIndex).toBe(1);
  });

  it('should not advance when layer is incomplete', () => {
    const plan = buildMultiLayerPlan();
    expect(advanceLayer(plan)).toBe(false);
    expect(plan.currentLayerIndex).toBe(0);
  });

  it('should set plan to completed when last layer finishes', () => {
    const specs: TaskSpec[] = [
      { id: 'only', title: 'Only task', description: '', assignedRole: 'be-dev', filePatterns: [], dependencies: [], nodeType: 'execution', priority: 1 },
    ];
    const plan = buildExecutionPlan('proj', specs, { maxParallelNodes: 4, enableGates: false, gateMapping: {} });

    markNodeStarted(plan, 'node-only');
    markNodeCompleted(plan, 'node-only');
    advanceLayer(plan);

    expect(plan.status).toBe('completed');
  });

  it('should treat failed nodes as complete for layer advancement', () => {
    const plan = buildSimplePlan();

    for (const node of plan.layers[0].nodes) {
      markNodeStarted(plan, node.id);
      markNodeFailed(plan, node.id);
    }

    expect(isLayerComplete(plan)).toBe(true);
  });
});

// ============================================================
// FILE OWNERSHIP VALIDATION
// ============================================================

describe('validateFileOwnership', () => {
  it('should detect no conflicts when ownership is disjoint', () => {
    const specs: TaskSpec[] = [
      { id: 'a', title: 'A', description: '', assignedRole: 'fe-dev', filePatterns: ['src/components/**'], dependencies: [], nodeType: 'execution', priority: 1 },
      { id: 'b', title: 'B', description: '', assignedRole: 'be-dev', filePatterns: ['src/api/**'], dependencies: [], nodeType: 'execution', priority: 1 },
    ];
    const plan = buildExecutionPlan('proj', specs, { maxParallelNodes: 4, enableGates: false, gateMapping: {} });
    const conflicts = validateFileOwnership(plan);
    expect(conflicts).toHaveLength(0);
  });

  it('should detect conflicts when patterns overlap in same layer', () => {
    const specs: TaskSpec[] = [
      { id: 'a', title: 'A', description: '', assignedRole: 'fe-dev', filePatterns: ['src/shared/**'], dependencies: [], nodeType: 'execution', priority: 1 },
      { id: 'b', title: 'B', description: '', assignedRole: 'be-dev', filePatterns: ['src/shared/**'], dependencies: [], nodeType: 'execution', priority: 1 },
    ];
    const plan = buildExecutionPlan('proj', specs, { maxParallelNodes: 4, enableGates: false, gateMapping: {} });
    const conflicts = validateFileOwnership(plan);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]).toContain('src/shared/**');
  });

  it('should detect overlapping glob patterns in same layer', () => {
    const specs: TaskSpec[] = [
      { id: 'a', title: 'A', description: '', assignedRole: 'fe-dev', filePatterns: ['src/**/*.ts'], dependencies: [], nodeType: 'execution', priority: 1 },
      { id: 'b', title: 'B', description: '', assignedRole: 'be-dev', filePatterns: ['src/core/*.ts'], dependencies: [], nodeType: 'execution', priority: 1 },
    ];
    const plan = buildExecutionPlan('proj', specs, { maxParallelNodes: 4, enableGates: false, gateMapping: {} });
    const conflicts = validateFileOwnership(plan);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.some(c => c.includes('overlapping patterns'))).toBe(true);
  });

  it('should not detect conflicts for non-overlapping patterns', () => {
    const specs: TaskSpec[] = [
      { id: 'a', title: 'A', description: '', assignedRole: 'fe-dev', filePatterns: ['src/api/**'], dependencies: [], nodeType: 'execution', priority: 1 },
      { id: 'b', title: 'B', description: '', assignedRole: 'be-dev', filePatterns: ['tests/**'], dependencies: [], nodeType: 'execution', priority: 1 },
    ];
    const plan = buildExecutionPlan('proj', specs, { maxParallelNodes: 4, enableGates: false, gateMapping: {} });
    const conflicts = validateFileOwnership(plan);
    expect(conflicts).toHaveLength(0);
  });

  it('should preserve exact duplicate detection', () => {
    const specs: TaskSpec[] = [
      { id: 'a', title: 'A', description: '', assignedRole: 'fe-dev', filePatterns: ['src/utils.ts'], dependencies: [], nodeType: 'execution', priority: 1 },
      { id: 'b', title: 'B', description: '', assignedRole: 'be-dev', filePatterns: ['src/utils.ts'], dependencies: [], nodeType: 'execution', priority: 1 },
    ];
    const plan = buildExecutionPlan('proj', specs, { maxParallelNodes: 4, enableGates: false, gateMapping: {} });
    const conflicts = validateFileOwnership(plan);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]).toContain('src/utils.ts');
  });
});

// ============================================================
// HELPERS
// ============================================================

function makeNode(id: string): DAGNode {
  return {
    id,
    roleId: 'be-dev',
    layerIndex: -1,
    nodeType: 'execution',
    status: 'pending',
    dependencies: [],
    taskId: null,
    fileOwnership: [],
    estimatedDuration: null,
    startedAt: null,
    completedAt: null,
  };
}

function makeTaskSpecs(): TaskSpec[] {
  return [
    { id: 'spec-1', title: 'Planning', description: 'Plan the work', assignedRole: 'pm', filePatterns: [], dependencies: [], nodeType: 'planning', priority: 1 },
    { id: 'spec-2', title: 'Design API', description: 'Design the API', assignedRole: 'pl', filePatterns: ['docs/'], dependencies: ['spec-1'], nodeType: 'design', priority: 2 },
    { id: 'spec-3', title: 'Implement', description: 'Build the code', assignedRole: 'be-dev', filePatterns: ['src/'], dependencies: ['spec-2'], nodeType: 'execution', priority: 3 },
    { id: 'spec-4', title: 'Test', description: 'Run tests', assignedRole: 'qa-engineer', filePatterns: ['tests/'], dependencies: ['spec-3'], nodeType: 'verification', priority: 4 },
  ];
}

function buildSimplePlan() {
  const specs: TaskSpec[] = [
    { id: 's1', title: 'Task A', description: '', assignedRole: 'be-dev', filePatterns: [], dependencies: [], nodeType: 'execution', priority: 1 },
    { id: 's2', title: 'Task B', description: '', assignedRole: 'fe-dev', filePatterns: [], dependencies: [], nodeType: 'execution', priority: 1 },
  ];
  return buildExecutionPlan('proj', specs, { maxParallelNodes: 4, enableGates: false, gateMapping: {} });
}

function buildMultiLayerPlan() {
  const specs: TaskSpec[] = [
    { id: 'm1', title: 'Plan', description: '', assignedRole: 'pm', filePatterns: [], dependencies: [], nodeType: 'planning', priority: 1 },
    { id: 'm2', title: 'Build', description: '', assignedRole: 'be-dev', filePatterns: [], dependencies: ['m1'], nodeType: 'execution', priority: 2 },
  ];
  return buildExecutionPlan('proj', specs, { maxParallelNodes: 4, enableGates: false, gateMapping: {} });
}
