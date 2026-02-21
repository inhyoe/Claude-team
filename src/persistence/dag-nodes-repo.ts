/**
 * Claude Team - DAG Nodes Repository
 *
 * CRUD operations for DAG execution nodes.
 */

import { getDb } from './db.js';
import type { DAGNode, DAGNodeStatus, ExecutionPlan } from '../shared/types.js';
import { nowIso, safeParseJson } from '../shared/utils.js';

function rowToDAGNode(row: Record<string, unknown>): DAGNode {
  return {
    id: row.id as string,
    roleId: row.role_id as string,
    layerIndex: row.layer_index as number,
    nodeType: row.node_type as 'planning' | 'design' | 'execution' | 'verification' | 'deployment',
    status: row.status as DAGNodeStatus,
    dependencies: row.dependencies ? safeParseJson<string[]>(row.dependencies as string, []) : [],
    taskId: (row.task_id as string) ?? null,
    fileOwnership: row.file_ownership ? safeParseJson<string[]>(row.file_ownership as string, []) : [],
    estimatedDuration: null, // Not stored in DB, computed at runtime
    startedAt: (row.started_at as string) ?? null,
    completedAt: (row.completed_at as string) ?? null,
  };
}

export function createDagNode(
  cwd: string,
  projectId: string,
  planId: string,
  node: {
    id: string;
    roleId: string;
    layerIndex: number;
    nodeType: 'planning' | 'design' | 'execution' | 'verification' | 'deployment';
    dependencies?: string[];
    taskId?: string;
    fileOwnership?: string[];
  }
): DAGNode | null {
  const db = getDb(cwd);
  if (!db) return null;

  try {
    db.prepare(`
      INSERT INTO dag_nodes (id, project_id, execution_plan_id, role_id, layer_index,
        node_type, status, dependencies, task_id, file_ownership, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL)
    `).run(
      node.id,
      projectId,
      planId,
      node.roleId,
      node.layerIndex,
      node.nodeType,
      node.dependencies ? JSON.stringify(node.dependencies) : null,
      node.taskId ?? null,
      node.fileOwnership ? JSON.stringify(node.fileOwnership) : null
    );

    return getDagNode(cwd, node.id);
  } catch (error) {
    console.error('[dag-nodes-repo] Failed to create DAG node:', error);
    return null;
  }
}

export function getDagNode(cwd: string, nodeId: string): DAGNode | null {
  const db = getDb(cwd);
  if (!db) return null;

  try {
    const row = db.prepare('SELECT * FROM dag_nodes WHERE id = ?').get(nodeId) as Record<string, unknown> | undefined;
    return row ? rowToDAGNode(row) : null;
  } catch {
    return null;
  }
}

export function getDagNodesByPlan(cwd: string, planId: string): DAGNode[] {
  const db = getDb(cwd);
  if (!db) return [];

  try {
    const rows = db.prepare('SELECT * FROM dag_nodes WHERE execution_plan_id = ? ORDER BY layer_index ASC, id ASC')
      .all(planId) as Record<string, unknown>[];
    return rows.map(rowToDAGNode);
  } catch {
    return [];
  }
}

export function getDagNodesByLayer(cwd: string, planId: string, layerIndex: number): DAGNode[] {
  const db = getDb(cwd);
  if (!db) return [];

  try {
    const rows = db.prepare('SELECT * FROM dag_nodes WHERE execution_plan_id = ? AND layer_index = ? ORDER BY id ASC')
      .all(planId, layerIndex) as Record<string, unknown>[];
    return rows.map(rowToDAGNode);
  } catch {
    return [];
  }
}

export function updateDagNodeStatus(
  cwd: string,
  nodeId: string,
  status: DAGNodeStatus,
  startedAt?: string,
  completedAt?: string
): boolean {
  const db = getDb(cwd);
  if (!db) return false;

  try {
    // Check if node exists first
    const exists = db.prepare('SELECT id FROM dag_nodes WHERE id = ?').get(nodeId);
    if (!exists) return false;

    const updates: string[] = ['status = ?'];
    const params: unknown[] = [status];

    if (startedAt !== undefined) {
      updates.push('started_at = ?');
      params.push(startedAt);
    }

    if (completedAt !== undefined) {
      updates.push('completed_at = ?');
      params.push(completedAt);
    }

    params.push(nodeId);

    db.prepare(`UPDATE dag_nodes SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return true;
  } catch (error) {
    console.error('[dag-nodes-repo] Failed to update DAG node status:', error);
    return false;
  }
}

export function deleteDagNodesByPlan(cwd: string, planId: string): boolean {
  const db = getDb(cwd);
  if (!db) return false;

  try {
    db.prepare('DELETE FROM dag_nodes WHERE execution_plan_id = ?').run(planId);
    return true;
  } catch (error) {
    console.error('[dag-nodes-repo] Failed to delete DAG nodes:', error);
    return false;
  }
}

export function savePlanNodes(cwd: string, projectId: string, plan: ExecutionPlan): boolean {
  const db = getDb(cwd);
  if (!db) return false;

  try {
    const saveAll = db.transaction(() => {
      // Delete existing nodes for this plan
      db.prepare('DELETE FROM dag_nodes WHERE execution_plan_id = ?').run(plan.id);

      // Insert all nodes from the plan
      const insertStmt = db.prepare(`
        INSERT INTO dag_nodes (id, project_id, execution_plan_id, role_id, layer_index,
          node_type, status, dependencies, task_id, file_ownership, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const node of plan.nodes.values()) {
        insertStmt.run(
          node.id,
          projectId,
          plan.id,
          node.roleId,
          node.layerIndex,
          node.nodeType,
          node.status,
          node.dependencies.length > 0 ? JSON.stringify(node.dependencies) : null,
          node.taskId ?? null,
          node.fileOwnership.length > 0 ? JSON.stringify(node.fileOwnership) : null,
          node.startedAt ?? null,
          node.completedAt ?? null
        );
      }
    });

    saveAll();
    return true;
  } catch (error) {
    console.error('[dag-nodes-repo] Failed to save plan nodes:', error);
    return false;
  }
}

export function loadPlanNodes(cwd: string, planId: string): Map<string, DAGNode> | null {
  const db = getDb(cwd);
  if (!db) return null;

  try {
    const rows = db.prepare('SELECT * FROM dag_nodes WHERE execution_plan_id = ?')
      .all(planId) as Record<string, unknown>[];

    // Return empty Map when no rows found (plan exists but has no nodes)
    if (rows.length === 0) return new Map<string, DAGNode>();

    const nodesMap = new Map<string, DAGNode>();
    for (const row of rows) {
      const node = rowToDAGNode(row);
      nodesMap.set(node.id, node);
    }

    return nodesMap;
  } catch (error) {
    console.error('[dag-nodes-repo] Failed to load plan nodes:', error);
    return null;
  }
}
