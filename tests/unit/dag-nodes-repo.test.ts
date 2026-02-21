/**
 * DAG Nodes Repository unit tests
 *
 * Tests: creating nodes, retrieving nodes, getting by plan/layer,
 * status updates, bulk save/load, JSON array parsing, deletion.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createDagNode,
  getDagNode,
  getDagNodesByPlan,
  getDagNodesByLayer,
  updateDagNodeStatus,
  deleteDagNodesByPlan,
  savePlanNodes,
  loadPlanNodes,
} from '../../src/persistence/dag-nodes-repo.js';
import type { ExecutionPlan, DAGNode } from '../../src/shared/types.js';
import { initDb, getDb, closeDb } from '../../src/persistence/db.js';

let testDir: string;
const projectId = 'test-proj';
const planId = 'plan-001';

/** Seed a project row so FK constraints pass. */
function seedProject(dir: string): void {
  const db = getDb(dir)!;
  db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, path, session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `).run(projectId, 'Test Project', dir, 'session-dag-test');
}

/** Seed a task row so FK constraints pass for nodes with taskId. */
function seedTask(dir: string, taskId: string): void {
  const db = getDb(dir)!;
  const ts = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO tasks (id, project_id, title, kanban_status, priority, created_at, updated_at, moved_at)
    VALUES (?, ?, ?, 'backlog', 3, ?, ?, ?)
  `).run(taskId, projectId, `Task ${taskId}`, ts, ts, ts);
}

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'ct-dag-nodes-test-'));
  await initDb(testDir);
  seedProject(testDir);
  // Pre-seed tasks
  for (let i = 1; i <= 10; i++) {
    seedTask(testDir, `task-${i}`);
  }
});

afterEach(() => {
  if (testDir) {
    closeDb(testDir);
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================
// CREATE & RETRIEVE
// ============================================================

describe('createDagNode', () => {
  it('creates a DAG node with minimal fields', () => {
    const node = createDagNode(testDir, projectId, planId, {
      id: 'node-1',
      roleId: 'role-pm',
      layerIndex: 0,
      nodeType: 'planning',
    });

    expect(node).not.toBeNull();
    expect(node?.id).toBe('node-1');
    expect(node?.roleId).toBe('role-pm');
    expect(node?.layerIndex).toBe(0);
    expect(node?.nodeType).toBe('planning');
    expect(node?.status).toBe('pending');
    expect(node?.dependencies).toEqual([]);
    expect(node?.taskId).toBeNull();
    expect(node?.fileOwnership).toEqual([]);
    expect(node?.startedAt).toBeNull();
    expect(node?.completedAt).toBeNull();
  });

  it('creates a DAG node with all optional fields', () => {
    const node = createDagNode(testDir, projectId, planId, {
      id: 'node-2',
      roleId: 'role-fe',
      layerIndex: 1,
      nodeType: 'execution',
      dependencies: ['node-1'],
      taskId: 'task-1',
      fileOwnership: ['src/**/*.ts', 'tests/**/*.test.ts'],
    });

    expect(node).not.toBeNull();
    expect(node?.id).toBe('node-2');
    expect(node?.dependencies).toEqual(['node-1']);
    expect(node?.taskId).toBe('task-1');
    expect(node?.fileOwnership).toEqual(['src/**/*.ts', 'tests/**/*.test.ts']);
  });

  it('returns null when database is not initialized', () => {
    const node = createDagNode('/nonexistent', projectId, planId, {
      id: 'node-fail',
      roleId: 'role-pm',
      layerIndex: 0,
      nodeType: 'planning',
    });

    expect(node).toBeNull();
  });
});

describe('getDagNode', () => {
  it('retrieves a node by ID', () => {
    createDagNode(testDir, projectId, planId, {
      id: 'node-3',
      roleId: 'role-qa',
      layerIndex: 2,
      nodeType: 'verification',
    });

    const node = getDagNode(testDir, 'node-3');
    expect(node).not.toBeNull();
    expect(node?.id).toBe('node-3');
    expect(node?.roleId).toBe('role-qa');
    expect(node?.nodeType).toBe('verification');
  });

  it('returns null when node does not exist', () => {
    const node = getDagNode(testDir, 'nonexistent');
    expect(node).toBeNull();
  });

  it('returns null when database is not initialized', () => {
    const node = getDagNode('/nonexistent', 'node-3');
    expect(node).toBeNull();
  });
});

// ============================================================
// QUERY BY PLAN & LAYER
// ============================================================

describe('getDagNodesByPlan', () => {
  it('retrieves all nodes for a plan ordered by layer and id', () => {
    createDagNode(testDir, projectId, planId, {
      id: 'node-layer-0',
      roleId: 'role-pm',
      layerIndex: 0,
      nodeType: 'planning',
    });

    createDagNode(testDir, projectId, planId, {
      id: 'node-layer-1-a',
      roleId: 'role-fe',
      layerIndex: 1,
      nodeType: 'execution',
    });

    createDagNode(testDir, projectId, planId, {
      id: 'node-layer-1-b',
      roleId: 'role-be',
      layerIndex: 1,
      nodeType: 'execution',
    });

    const nodes = getDagNodesByPlan(testDir, planId);
    expect(nodes).toHaveLength(3);
    expect(nodes[0].id).toBe('node-layer-0');
    expect(nodes[1].layerIndex).toBe(1);
    expect(nodes[2].layerIndex).toBe(1);
  });

  it('returns empty array when plan has no nodes', () => {
    const nodes = getDagNodesByPlan(testDir, 'nonexistent-plan');
    expect(nodes).toEqual([]);
  });

  it('returns empty array when database is not initialized', () => {
    const nodes = getDagNodesByPlan('/nonexistent', planId);
    expect(nodes).toEqual([]);
  });
});

describe('getDagNodesByLayer', () => {
  it('retrieves nodes for a specific layer', () => {
    createDagNode(testDir, projectId, planId, {
      id: 'node-4',
      roleId: 'role-pm',
      layerIndex: 0,
      nodeType: 'planning',
    });

    createDagNode(testDir, projectId, planId, {
      id: 'node-5',
      roleId: 'role-fe',
      layerIndex: 1,
      nodeType: 'execution',
    });

    createDagNode(testDir, projectId, planId, {
      id: 'node-6',
      roleId: 'role-be',
      layerIndex: 1,
      nodeType: 'execution',
    });

    const layer1Nodes = getDagNodesByLayer(testDir, planId, 1);
    expect(layer1Nodes).toHaveLength(2);
    expect(layer1Nodes[0].id).toBe('node-5');
    expect(layer1Nodes[1].id).toBe('node-6');
    expect(layer1Nodes.every(n => n.layerIndex === 1)).toBe(true);
  });

  it('returns empty array when layer has no nodes', () => {
    const nodes = getDagNodesByLayer(testDir, planId, 99);
    expect(nodes).toEqual([]);
  });
});

// ============================================================
// STATUS UPDATES
// ============================================================

describe('updateDagNodeStatus', () => {
  it('updates node status only', () => {
    createDagNode(testDir, projectId, planId, {
      id: 'node-7',
      roleId: 'role-pm',
      layerIndex: 0,
      nodeType: 'planning',
    });

    const success = updateDagNodeStatus(testDir, 'node-7', 'running');
    expect(success).toBe(true);

    const node = getDagNode(testDir, 'node-7');
    expect(node?.status).toBe('running');
    expect(node?.startedAt).toBeNull();
    expect(node?.completedAt).toBeNull();
  });

  it('updates status with startedAt timestamp', () => {
    createDagNode(testDir, projectId, planId, {
      id: 'node-8',
      roleId: 'role-fe',
      layerIndex: 1,
      nodeType: 'execution',
    });

    const timestamp = new Date().toISOString();
    const success = updateDagNodeStatus(testDir, 'node-8', 'running', timestamp);
    expect(success).toBe(true);

    const node = getDagNode(testDir, 'node-8');
    expect(node?.status).toBe('running');
    expect(node?.startedAt).toBe(timestamp);
  });

  it('updates status with completedAt timestamp', () => {
    createDagNode(testDir, projectId, planId, {
      id: 'node-9',
      roleId: 'role-qa',
      layerIndex: 2,
      nodeType: 'verification',
    });

    const startTime = new Date().toISOString();
    updateDagNodeStatus(testDir, 'node-9', 'running', startTime);

    const endTime = new Date().toISOString();
    const success = updateDagNodeStatus(testDir, 'node-9', 'completed', undefined, endTime);
    expect(success).toBe(true);

    const node = getDagNode(testDir, 'node-9');
    expect(node?.status).toBe('completed');
    expect(node?.startedAt).toBe(startTime);
    expect(node?.completedAt).toBe(endTime);
  });

  it('updates status with both timestamps', () => {
    createDagNode(testDir, projectId, planId, {
      id: 'node-10',
      roleId: 'role-be',
      layerIndex: 1,
      nodeType: 'execution',
    });

    const startTime = new Date().toISOString();
    const endTime = new Date().toISOString();
    const success = updateDagNodeStatus(testDir, 'node-10', 'completed', startTime, endTime);
    expect(success).toBe(true);

    const node = getDagNode(testDir, 'node-10');
    expect(node?.status).toBe('completed');
    expect(node?.startedAt).toBe(startTime);
    expect(node?.completedAt).toBe(endTime);
  });

  it('returns false when node does not exist', () => {
    const success = updateDagNodeStatus(testDir, 'nonexistent', 'completed');
    expect(success).toBe(false);
  });
});

// ============================================================
// DELETION
// ============================================================

describe('deleteDagNodesByPlan', () => {
  it('deletes all nodes for a plan', () => {
    createDagNode(testDir, projectId, planId, {
      id: 'node-del-1',
      roleId: 'role-pm',
      layerIndex: 0,
      nodeType: 'planning',
    });

    createDagNode(testDir, projectId, planId, {
      id: 'node-del-2',
      roleId: 'role-fe',
      layerIndex: 1,
      nodeType: 'execution',
    });

    const nodesBefore = getDagNodesByPlan(testDir, planId);
    expect(nodesBefore.length).toBeGreaterThan(0);

    const success = deleteDagNodesByPlan(testDir, planId);
    expect(success).toBe(true);

    const nodesAfter = getDagNodesByPlan(testDir, planId);
    expect(nodesAfter).toEqual([]);
  });

  it('returns true even when plan has no nodes', () => {
    const success = deleteDagNodesByPlan(testDir, 'empty-plan');
    expect(success).toBe(true);
  });
});

// ============================================================
// BULK SAVE/LOAD
// ============================================================

describe('savePlanNodes', () => {
  it('saves all nodes from an ExecutionPlan', () => {
    const plan: ExecutionPlan = {
      id: 'plan-bulk',
      projectId,
      layers: [],
      nodes: new Map<string, DAGNode>([
        ['node-bulk-1', {
          id: 'node-bulk-1',
          roleId: 'role-pm',
          layerIndex: 0,
          nodeType: 'planning',
          status: 'pending',
          dependencies: [],
          taskId: null,
          fileOwnership: [],
          estimatedDuration: null,
          startedAt: null,
          completedAt: null,
        }],
        ['node-bulk-2', {
          id: 'node-bulk-2',
          roleId: 'role-fe',
          layerIndex: 1,
          nodeType: 'execution',
          status: 'pending',
          dependencies: ['node-bulk-1'],
          taskId: 'task-2',
          fileOwnership: ['src/**/*.tsx'],
          estimatedDuration: 30,
          startedAt: null,
          completedAt: null,
        }],
      ]),
      edges: [],
      currentLayerIndex: 0,
      status: 'planning',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const success = savePlanNodes(testDir, projectId, plan);
    expect(success).toBe(true);

    const nodes = getDagNodesByPlan(testDir, 'plan-bulk');
    expect(nodes).toHaveLength(2);

    const node1 = nodes.find(n => n.id === 'node-bulk-1');
    expect(node1?.roleId).toBe('role-pm');
    expect(node1?.nodeType).toBe('planning');

    const node2 = nodes.find(n => n.id === 'node-bulk-2');
    expect(node2?.dependencies).toEqual(['node-bulk-1']);
    expect(node2?.taskId).toBe('task-2');
    expect(node2?.fileOwnership).toEqual(['src/**/*.tsx']);
  });

  it('replaces existing nodes when saving to same plan', () => {
    // First save
    const plan1: ExecutionPlan = {
      id: 'plan-replace',
      projectId,
      layers: [],
      nodes: new Map<string, DAGNode>([
        ['node-old', {
          id: 'node-old',
          roleId: 'role-pm',
          layerIndex: 0,
          nodeType: 'planning',
          status: 'pending',
          dependencies: [],
          taskId: null,
          fileOwnership: [],
          estimatedDuration: null,
          startedAt: null,
          completedAt: null,
        }],
      ]),
      edges: [],
      currentLayerIndex: 0,
      status: 'planning',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    savePlanNodes(testDir, projectId, plan1);
    expect(getDagNodesByPlan(testDir, 'plan-replace')).toHaveLength(1);

    // Second save with different nodes
    const plan2: ExecutionPlan = {
      ...plan1,
      nodes: new Map<string, DAGNode>([
        ['node-new-1', {
          id: 'node-new-1',
          roleId: 'role-fe',
          layerIndex: 0,
          nodeType: 'execution',
          status: 'pending',
          dependencies: [],
          taskId: null,
          fileOwnership: [],
          estimatedDuration: null,
          startedAt: null,
          completedAt: null,
        }],
        ['node-new-2', {
          id: 'node-new-2',
          roleId: 'role-be',
          layerIndex: 1,
          nodeType: 'execution',
          status: 'pending',
          dependencies: ['node-new-1'],
          taskId: null,
          fileOwnership: [],
          estimatedDuration: null,
          startedAt: null,
          completedAt: null,
        }],
      ]),
    };

    savePlanNodes(testDir, projectId, plan2);

    const nodes = getDagNodesByPlan(testDir, 'plan-replace');
    expect(nodes).toHaveLength(2);
    expect(nodes.find(n => n.id === 'node-old')).toBeUndefined();
    expect(nodes.find(n => n.id === 'node-new-1')).toBeDefined();
    expect(nodes.find(n => n.id === 'node-new-2')).toBeDefined();
  });
});

describe('loadPlanNodes', () => {
  it('loads nodes and reconstructs Map format', () => {
    createDagNode(testDir, projectId, 'plan-load', {
      id: 'node-load-1',
      roleId: 'role-pm',
      layerIndex: 0,
      nodeType: 'planning',
      dependencies: [],
    });

    createDagNode(testDir, projectId, 'plan-load', {
      id: 'node-load-2',
      roleId: 'role-fe',
      layerIndex: 1,
      nodeType: 'execution',
      dependencies: ['node-load-1'],
      taskId: 'task-3',
      fileOwnership: ['src/**/*.ts'],
    });

    const nodesMap = loadPlanNodes(testDir, 'plan-load');
    expect(nodesMap).not.toBeNull();
    expect(nodesMap?.size).toBe(2);

    const node1 = nodesMap?.get('node-load-1');
    expect(node1?.roleId).toBe('role-pm');
    expect(node1?.dependencies).toEqual([]);

    const node2 = nodesMap?.get('node-load-2');
    expect(node2?.dependencies).toEqual(['node-load-1']);
    expect(node2?.taskId).toBe('task-3');
    expect(node2?.fileOwnership).toEqual(['src/**/*.ts']);
  });

  it('returns empty Map when plan has no nodes', () => {
    const nodesMap = loadPlanNodes(testDir, 'empty-plan');
    expect(nodesMap).not.toBeNull();
    expect(nodesMap?.size).toBe(0);
  });

  it('returns null when database is not initialized', () => {
    const nodesMap = loadPlanNodes('/nonexistent', 'plan-load');
    expect(nodesMap).toBeNull();
  });
});

// ============================================================
// JSON ARRAY PARSING
// ============================================================

describe('JSON array parsing', () => {
  it('correctly parses dependencies array', () => {
    createDagNode(testDir, projectId, planId, {
      id: 'node-deps',
      roleId: 'role-fe',
      layerIndex: 1,
      nodeType: 'execution',
      dependencies: ['node-a', 'node-b', 'node-c'],
    });

    const node = getDagNode(testDir, 'node-deps');
    expect(node?.dependencies).toEqual(['node-a', 'node-b', 'node-c']);
  });

  it('correctly parses fileOwnership array', () => {
    createDagNode(testDir, projectId, planId, {
      id: 'node-files',
      roleId: 'role-be',
      layerIndex: 1,
      nodeType: 'execution',
      fileOwnership: ['src/api/**/*.ts', 'src/db/**/*.ts', 'tests/api/**/*.test.ts'],
    });

    const node = getDagNode(testDir, 'node-files');
    expect(node?.fileOwnership).toEqual(['src/api/**/*.ts', 'src/db/**/*.ts', 'tests/api/**/*.test.ts']);
  });

  it('handles empty arrays correctly', () => {
    createDagNode(testDir, projectId, planId, {
      id: 'node-empty',
      roleId: 'role-pm',
      layerIndex: 0,
      nodeType: 'planning',
      dependencies: [],
      fileOwnership: [],
    });

    const node = getDagNode(testDir, 'node-empty');
    expect(node?.dependencies).toEqual([]);
    expect(node?.fileOwnership).toEqual([]);
  });
});
