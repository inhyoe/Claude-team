/**
 * Claude Team - Kanban Repository
 *
 * Kanban board state queries and history tracking.
 */

import { getDb } from './db.js';
import type { KanbanTransition, KanbanStatus } from '../shared/types.js';

function rowToTransition(row: Record<string, unknown>): KanbanTransition {
  return {
    itemId: row.task_id as string,
    fromStatus: row.from_status as KanbanStatus,
    toStatus: row.to_status as KanbanStatus,
    movedBy: row.moved_by as KanbanTransition['movedBy'],
    reason: (row.reason as string) ?? '',
    timestamp: row.timestamp as string,
  };
}

export function getTaskHistory(cwd: string, taskId: string): KanbanTransition[] {
  const db = getDb(cwd);
  if (!db) return [];

  try {
    const rows = db.prepare('SELECT * FROM kanban_history WHERE task_id = ? ORDER BY timestamp ASC')
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToTransition);
  } catch {
    return [];
  }
}

export function getRecentTransitions(cwd: string, projectId: string, limit = 20): KanbanTransition[] {
  const db = getDb(cwd);
  if (!db) return [];

  try {
    const rows = db.prepare(`
      SELECT kh.* FROM kanban_history kh
      JOIN tasks t ON kh.task_id = t.id
      WHERE t.project_id = ?
      ORDER BY kh.timestamp DESC LIMIT ?
    `).all(projectId, limit) as Record<string, unknown>[];
    return rows.map(rowToTransition);
  } catch {
    return [];
  }
}

export function getTransitionCount(cwd: string, taskId: string): number {
  const db = getDb(cwd);
  if (!db) return 0;

  try {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM kanban_history WHERE task_id = ?')
      .get(taskId) as { cnt: number };
    return row.cnt;
  } catch {
    return 0;
  }
}
