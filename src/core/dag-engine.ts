/**
 * Claude Team - DAG Engine
 *
 * Constructs, validates, and executes DAG-based execution plans.
 * Uses topological sort for layer composition and gate insertion.
 *
 * ARCHITECTURE DECISION: DAG-based File Ownership
 * ────────────────────────────────────────────────
 * Each DAG node owns exclusive file patterns (glob-based). Nodes within the
 * same layer execute in parallel but may NOT share file patterns. Cross-layer
 * execution is sequential (gated). This prevents the merge conflict failures
 * observed in flat-agent architectures (e.g., Cursor's concurrent editing).
 *
 * validateFileOwnership() enforces this at plan construction time.
 * Shared files that must be edited by multiple roles are mediated by PL
 * in a dedicated serialized step, never concurrently.
 */

import { randomUUID } from 'crypto';
import type { DAGNode, DAGEdge, DAGLayer, ExecutionPlan, DAGNodeType, GateType, RoleType } from '../shared/types.js';
import type { TaskSpec, DAGConfig } from './dag-types.js';
import { DEFAULT_DAG_CONFIG } from './dag-types.js';
import { nowIso } from '../shared/utils.js';
import picomatch from 'picomatch';

function generateId(): string {
  return randomUUID();
}

// ============================================================
// TOPOLOGICAL SORT
// ============================================================

/**
 * Kahn's algorithm for topological sort.
 * Returns layers (groups of nodes that can execute in parallel).
 */
export function topologicalSort(nodes: DAGNode[], edges: DAGEdge[]): DAGNode[][] {
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();
  const nodeMap = new Map<string, DAGNode>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjList.set(node.id, []);
    nodeMap.set(node.id, node);
  }

  for (const edge of edges) {
    const targets = adjList.get(edge.from);
    if (targets) targets.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const layers: DAGNode[][] = [];
  let queue = nodes.filter(n => (inDegree.get(n.id) ?? 0) === 0);

  while (queue.length > 0) {
    layers.push([...queue]);

    const nextQueue: DAGNode[] = [];
    for (const node of queue) {
      for (const neighbor of adjList.get(node.id) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) {
          const neighborNode = nodeMap.get(neighbor);
          if (neighborNode) nextQueue.push(neighborNode);
        }
      }
    }
    queue = nextQueue;
  }

  // Cycle detection
  const processedCount = layers.reduce((sum, layer) => sum + layer.length, 0);
  if (processedCount !== nodes.length) {
    throw new Error(`DAG has cycles: processed ${processedCount} of ${nodes.length} nodes`);
  }

  return layers;
}

// ============================================================
// DAG CONSTRUCTION
// ============================================================

/**
 * Build an execution plan from task specifications.
 */
export function buildExecutionPlan(
  projectId: string,
  taskSpecs: TaskSpec[],
  config: DAGConfig = DEFAULT_DAG_CONFIG
): ExecutionPlan {
  const planId = generateId();
  const ts = nowIso();

  // Create DAG nodes from task specs
  const nodes: DAGNode[] = taskSpecs.map(spec => ({
    id: `node-${spec.id}`,
    roleId: spec.assignedRole,
    layerIndex: -1, // computed by topo sort
    nodeType: spec.nodeType,
    status: 'pending',
    dependencies: spec.dependencies.map(d => `node-${d}`),
    taskId: spec.id,
    fileOwnership: spec.filePatterns,
    estimatedDuration: null,
    startedAt: null,
    completedAt: null,
  }));

  // Create edges from dependencies
  const edges: DAGEdge[] = [];
  for (const spec of taskSpecs) {
    for (const dep of spec.dependencies) {
      edges.push({
        from: `node-${dep}`,
        to: `node-${spec.id}`,
        type: 'dependency',
      });
    }
  }

  // Topological sort into layers
  const sortedLayers = topologicalSort(nodes, edges);

  // Assign layer indices and build DAGLayer objects
  const layers: DAGLayer[] = sortedLayers.map((layerNodes, index) => {
    for (const node of layerNodes) {
      node.layerIndex = index;
    }

    // Determine layer type from majority node type
    const typeFreq = new Map<DAGNodeType, number>();
    for (const node of layerNodes) {
      typeFreq.set(node.nodeType, (typeFreq.get(node.nodeType) ?? 0) + 1);
    }
    let majorityType: DAGNodeType = 'execution';
    let maxCount = 0;
    for (const [type, count] of typeFreq) {
      if (count > maxCount) {
        majorityType = type;
        maxCount = count;
      }
    }

    // Insert gate if configured
    const gateType = config.enableGates ? (config.gateMapping[majorityType] ?? null) : null;

    return {
      index,
      nodeType: majorityType,
      nodes: layerNodes,
      gateType,
    };
  });

  // Add gate edges between layers
  for (let i = 0; i < layers.length - 1; i++) {
    if (layers[i].gateType) {
      for (const fromNode of layers[i].nodes) {
        for (const toNode of layers[i + 1].nodes) {
          edges.push({
            from: fromNode.id,
            to: toNode.id,
            type: 'gate',
          });
        }
      }
    }
  }

  // Build nodes map
  const nodesMap = new Map<string, DAGNode>();
  for (const node of nodes) {
    nodesMap.set(node.id, node);
  }

  return {
    id: planId,
    projectId,
    layers,
    nodes: nodesMap,
    edges,
    currentLayerIndex: 0,
    status: 'planning',
    createdAt: ts,
    updatedAt: ts,
  };
}

// ============================================================
// DAG EXECUTION HELPERS
// ============================================================

/**
 * Get nodes ready to execute in the current layer.
 */
export function getReadyNodes(plan: ExecutionPlan): DAGNode[] {
  const layer = plan.layers[plan.currentLayerIndex];
  if (!layer) return [];

  return layer.nodes.filter(node => {
    if (node.status !== 'pending') return false;

    // Check all dependencies are completed
    return node.dependencies.every(depId => {
      const dep = plan.nodes.get(depId);
      return dep?.status === 'completed';
    });
  });
}

/**
 * Check if the current layer is complete (all nodes done or failed).
 */
export function isLayerComplete(plan: ExecutionPlan): boolean {
  const layer = plan.layers[plan.currentLayerIndex];
  if (!layer) return true;

  return layer.nodes.every(n => n.status === 'completed' || n.status === 'failed' || n.status === 'skipped');
}

/**
 * Advance to the next layer if current is complete.
 */
export function advanceLayer(plan: ExecutionPlan): boolean {
  if (!isLayerComplete(plan)) return false;

  if (plan.currentLayerIndex < plan.layers.length - 1) {
    plan.currentLayerIndex++;
    plan.updatedAt = nowIso();
    return true;
  }

  // All layers complete
  plan.status = 'completed';
  plan.updatedAt = nowIso();
  return false;
}

/**
 * Mark a node as started.
 */
export function markNodeStarted(plan: ExecutionPlan, nodeId: string): boolean {
  const node = plan.nodes.get(nodeId);
  if (!node || node.status !== 'pending') return false;

  node.status = 'running';
  node.startedAt = nowIso();
  plan.updatedAt = nowIso();
  return true;
}

/**
 * Mark a node as completed.
 */
export function markNodeCompleted(plan: ExecutionPlan, nodeId: string): boolean {
  const node = plan.nodes.get(nodeId);
  if (!node || node.status !== 'running') return false;

  node.status = 'completed';
  node.completedAt = nowIso();
  plan.updatedAt = nowIso();
  return true;
}

/**
 * Mark a node as failed.
 */
export function markNodeFailed(plan: ExecutionPlan, nodeId: string): boolean {
  const node = plan.nodes.get(nodeId);
  if (!node || node.status !== 'running') return false;

  node.status = 'failed';
  node.completedAt = nowIso();
  plan.updatedAt = nowIso();
  return true;
}

/**
 * Validate that a plan has no file ownership conflicts within the same layer.
 */
export function validateFileOwnership(plan: ExecutionPlan): string[] {
  const conflicts: string[] = [];

  for (const layer of plan.layers) {
    const ownershipMap = new Map<string, string[]>();

    for (const node of layer.nodes) {
      for (const pattern of node.fileOwnership) {
        const existing = ownershipMap.get(pattern) ?? [];
        existing.push(node.id);
        ownershipMap.set(pattern, existing);
      }
    }

    // Check for exact duplicates
    for (const [pattern, owners] of ownershipMap) {
      if (owners.length > 1) {
        conflicts.push(`Layer ${layer.index}: pattern "${pattern}" owned by ${owners.join(', ')}`);
      }
    }

    // Check for glob pattern overlaps
    const patternsByNode = new Map<string, string[]>();
    for (const node of layer.nodes) {
      if (node.fileOwnership.length > 0) {
        patternsByNode.set(node.id, node.fileOwnership);
      }
    }

    const nodeIds = Array.from(patternsByNode.keys());
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        const nodeA = nodeIds[i];
        const nodeB = nodeIds[j];
        const patternsA = patternsByNode.get(nodeA)!;
        const patternsB = patternsByNode.get(nodeB)!;

        for (const patternA of patternsA) {
          for (const patternB of patternsB) {
            // Skip if already caught as exact duplicates
            if (patternA === patternB) continue;

            // Check if patterns overlap using picomatch.
            // NOTE: This checks if one glob's text matches the other, not true set intersection.
            // Two globs like "src/a*/*.ts" and "src/ab*/*.ts" that share files won't be detected.
            // This is a best-effort heuristic sufficient for typical file ownership patterns.
            const isMatcherA = picomatch(patternA);
            const isMatcherB = picomatch(patternB);

            if (isMatcherA(patternB) || isMatcherB(patternA)) {
              conflicts.push(`Layer ${layer.index}: overlapping patterns "${patternA}" (${nodeA}) and "${patternB}" (${nodeB})`);
            }
          }
        }
      }
    }
  }

  return conflicts;
}
