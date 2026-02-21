/**
 * Claude Team - Tasks Repository
 *
 * CRUD operations for kanban task items.
 */

import { getDb } from './db.js';
import type { KanbanItem, KanbanStatus, RoleType } from '../shared/types.js';
import { nowIso, safeParseJson } from '../shared/utils.js';

function rowToKanbanItem(row: Record<string, unknown>): KanbanItem {
  return {
    id: row.id as string,
    taskId: row.id as string,
    title: row.title as string,
    status: row.kanban_status as KanbanStatus,
    assignedRole: (row.assigned_role as RoleType) ?? null,
    priority: row.priority as number,
    complexityScore: row.complexity_score as number,
    fileOwnership: row.file_ownership ? safeParseJson<string[]>(row.file_ownership as string, []) : [],
    reviewScore: (row.review_score as number) ?? null,
    sprintId: (row.sprint_id as string) ?? null,
    dagNodeId: (row.dag_node_id as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    movedAt: row.moved_at as string,
  };
}

export function createTask(
  cwd: string,
  projectId: string,
  task: {
    id: string;
    title: string;
    description?: string;
    priority?: number;
    assignedRole?: RoleType;
    complexityScore?: number;
    fileOwnership?: string[];
    sprintId?: string;
    dagNodeId?: string;
  }
): KanbanItem | null {
  const db = getDb(cwd);
  if (!db) return null;

  const ts = nowIso();
  try {
    db.prepare(`
      INSERT INTO tasks (id, project_id, title, description, kanban_status, assigned_role,
        priority, complexity_score, file_ownership, sprint_id, dag_node_id,
        created_at, updated_at, moved_at)
      VALUES (?, ?, ?, ?, 'backlog', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, projectId, task.title, task.description ?? null,
      task.assignedRole ?? null, task.priority ?? 3,
      task.complexityScore ?? 0, task.fileOwnership ? JSON.stringify(task.fileOwnership) : null,
      task.sprintId ?? null, task.dagNodeId ?? null,
      ts, ts, ts
    );

    return getTask(cwd, task.id);
  } catch (error) {
    console.error('[tasks-repo] Failed to create task:', error);
    return null;
  }
}

export function getTask(cwd: string, taskId: string): KanbanItem | null {
  const db = getDb(cwd);
  if (!db) return null;

  try {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
    return row ? rowToKanbanItem(row) : null;
  } catch {
    return null;
  }
}

export function getTasksByProject(cwd: string, projectId: string): KanbanItem[] {
  const db = getDb(cwd);
  if (!db) return [];

  try {
    const rows = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY priority ASC, created_at ASC')
      .all(projectId) as Record<string, unknown>[];
    return rows.map(rowToKanbanItem);
  } catch {
    return [];
  }
}

export function getTasksByStatus(cwd: string, projectId: string, status: KanbanStatus): KanbanItem[] {
  const db = getDb(cwd);
  if (!db) return [];

  try {
    const rows = db.prepare('SELECT * FROM tasks WHERE project_id = ? AND kanban_status = ? ORDER BY priority ASC')
      .all(projectId, status) as Record<string, unknown>[];
    return rows.map(rowToKanbanItem);
  } catch {
    return [];
  }
}

export function getTasksByRole(cwd: string, projectId: string, role: RoleType): KanbanItem[] {
  const db = getDb(cwd);
  if (!db) return [];

  try {
    const rows = db.prepare('SELECT * FROM tasks WHERE project_id = ? AND assigned_role = ? ORDER BY priority ASC')
      .all(projectId, role) as Record<string, unknown>[];
    return rows.map(rowToKanbanItem);
  } catch {
    return [];
  }
}

export function updateTaskStatus(
  cwd: string,
  taskId: string,
  status: KanbanStatus,
  movedBy: RoleType,
  reason?: string
): boolean {
  const db = getDb(cwd);
  if (!db) return false;

  const ts = nowIso();
  try {
    const current = db.prepare('SELECT kanban_status FROM tasks WHERE id = ?').get(taskId) as { kanban_status: string } | undefined;
    if (!current) return false;

    const update = db.transaction(() => {
      db.prepare('UPDATE tasks SET kanban_status = ?, updated_at = ?, moved_at = ? WHERE id = ?')
        .run(status, ts, ts, taskId);

      db.prepare('INSERT INTO kanban_history (task_id, from_status, to_status, moved_by, reason, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
        .run(taskId, current.kanban_status, status, movedBy, reason ?? null, ts);
    });

    update();
    return true;
  } catch (error) {
    console.error('[tasks-repo] Failed to update task status:', error);
    return false;
  }
}

export function updateTaskReviewScore(cwd: string, taskId: string, score: number): boolean {
  const db = getDb(cwd);
  if (!db) return false;

  try {
    db.prepare('UPDATE tasks SET review_score = ?, updated_at = ? WHERE id = ?')
      .run(score, nowIso(), taskId);
    return true;
  } catch {
    return false;
  }
}

export function assignTaskRole(cwd: string, taskId: string, role: RoleType): boolean {
  const db = getDb(cwd);
  if (!db) return false;

  try {
    db.prepare('UPDATE tasks SET assigned_role = ?, updated_at = ? WHERE id = ?')
      .run(role, nowIso(), taskId);
    return true;
  } catch {
    return false;
  }
}

export function getKanbanCounts(cwd: string, projectId: string): Record<KanbanStatus, number> {
  const db = getDb(cwd);
  const defaults: Record<KanbanStatus, number> = {
    'backlog': 0, 'todo': 0, 'in-progress': 0, 'review': 0, 'done': 0, 'blocked': 0, 'failed': 0, 'cancelled': 0,
  };
  if (!db) return defaults;

  try {
    const rows = db.prepare('SELECT kanban_status, COUNT(*) as cnt FROM tasks WHERE project_id = ? GROUP BY kanban_status')
      .all(projectId) as Array<{ kanban_status: string; cnt: number }>;
    for (const row of rows) {
      defaults[row.kanban_status as KanbanStatus] = row.cnt;
    }
    return defaults;
  } catch {
    return defaults;
  }
}
