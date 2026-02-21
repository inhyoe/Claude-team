/**
 * Claude Team - DAG Types
 *
 * Serializable versions of DAG types for persistence and IPC.
 */

import type { DAGNode, DAGEdge, DAGLayer, DAGNodeType, DAGNodeStatus, GateType, RoleType } from '../shared/types.js';

export interface SerializableDAGNode {
  id: string;
  roleId: string;
  layerIndex: number;
  nodeType: DAGNodeType;
  status: DAGNodeStatus;
  dependencies: string[];
  taskId: string | null;
  fileOwnership: string[];
  startedAt: string | null;
  completedAt: string | null;
}

export interface SerializableExecutionPlan {
  id: string;
  projectId: string;
  layers: Array<{
    index: number;
    nodeType: DAGNodeType;
    nodeIds: string[];
    gateType: GateType | null;
  }>;
  nodes: SerializableDAGNode[];
  edges: DAGEdge[];
  currentLayerIndex: number;
  status: 'planning' | 'executing' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
}

/**
 * Task specification for DAG construction.
 */
export interface TaskSpec {
  id: string;
  title: string;
  description: string;
  assignedRole: RoleType;
  filePatterns: string[];
  dependencies: string[]; // other task spec IDs
  nodeType: DAGNodeType;
  priority: number;
}

/**
 * Configuration for DAG construction.
 */
export interface DAGConfig {
  maxParallelNodes: number;  // max concurrent nodes per layer (default: 4)
  enableGates: boolean;      // whether to insert quality gates between layers
  gateMapping: Partial<Record<DAGNodeType, GateType>>;
}

export const DEFAULT_DAG_CONFIG: DAGConfig = {
  maxParallelNodes: 4,
  enableGates: true,
  gateMapping: {
    'planning': 'pl-approval',
    'design': 'design-review',
    'execution': 'code-review',
    'verification': 'qa-review',
  },
};

export { DAGNode, DAGEdge, DAGLayer, DAGNodeType, DAGNodeStatus };
