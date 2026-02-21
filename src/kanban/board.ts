/**
 * Claude Team - Kanban Board
 *
 * High-level board operations that combine state machine + persistence.
 */

import type { KanbanItem, KanbanStatus, RoleType, GateVerdict } from '../shared/types.js';
import { validateTransition } from './state-machine.js';
import {
  createTask,
  getTask,
  getTasksByProject,
  getTasksByStatus,
  getTasksByRole,
  updateTaskStatus,
  getKanbanCounts,
} from '../persistence/tasks-repo.js';
import { getDb } from '../persistence/db.js';

export interface BoardView {
  backlog: KanbanItem[];
  todo: KanbanItem[];
  inProgress: KanbanItem[];
  review: KanbanItem[];
  done: KanbanItem[];
  blocked: KanbanItem[];
  failed: KanbanItem[];
  cancelled: KanbanItem[];
  counts: Record<KanbanStatus, number>;
}

/**
 * Get the full board view for a project.
 */
export function getBoardView(cwd: string, projectId: string): BoardView {
  const all = getTasksByProject(cwd, projectId);

  const board: BoardView = {
    backlog: [],
    todo: [],
    inProgress: [],
    review: [],
    done: [],
    blocked: [],
    failed: [],
    cancelled: [],
    counts: getKanbanCounts(cwd, projectId),
  };

  for (const item of all) {
    switch (item.status) {
      case 'backlog': board.backlog.push(item); break;
      case 'todo': board.todo.push(item); break;
      case 'in-progress': board.inProgress.push(item); break;
      case 'review': board.review.push(item); break;
      case 'done': board.done.push(item); break;
      case 'blocked': board.blocked.push(item); break;
      case 'failed': board.failed.push(item); break;
      case 'cancelled': board.cancelled.push(item); break;
    }
  }

  return board;
}

/**
 * Move a task to a new status with validation.
 */
export function moveTask(
  cwd: string,
  taskId: string,
  toStatus: KanbanStatus,
  movedBy: RoleType,
  reason: string,
  gateVerdictOrOptions?: GateVerdict | { verdict: GateVerdict; gateType?: string; score?: number },
  options?: { wipLimit?: number }
): { ok: boolean; error?: string } {
  const task = getTask(cwd, taskId);
  if (!task) return { ok: false, error: `Task ${taskId} not found` };

  // Normalize gateVerdict from either legacy GateVerdict string or object form
  let gateVerdict: GateVerdict | undefined;
  if (typeof gateVerdictOrOptions === 'string') {
    gateVerdict = gateVerdictOrOptions;
  } else if (gateVerdictOrOptions && typeof gateVerdictOrOptions === 'object') {
    gateVerdict = gateVerdictOrOptions.verdict;
  }

  // Get current WIP count when moving to in-progress
  let currentWipCount: number | undefined;
  if (toStatus === 'in-progress') {
    const counts = getKanbanCounts(cwd, getProjectIdForTask(cwd, taskId));
    currentWipCount = counts['in-progress'];
  }

  const result = validateTransition({
    taskId,
    fromStatus: task.status,
    toStatus,
    movedBy,
    reason,
    gateVerdict,
    currentWipCount,
    wipLimit: options?.wipLimit,
  });

  if (!result.allowed) {
    return { ok: false, error: result.error };
  }

  const updated = updateTaskStatus(cwd, taskId, toStatus, movedBy, reason);
  if (!updated) {
    return { ok: false, error: 'Failed to update task in database' };
  }

  return { ok: true };
}

/**
 * Look up the project ID for a task (needed for WIP count lookup).
 */
function getProjectIdForTask(cwd: string, taskId: string): string {
  const db = getDb(cwd);
  if (!db) return '';
  try {
    const row = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined;
    return row?.project_id ?? '';
  } catch {
    return '';
  }
}

/**
 * Add a new task to the backlog.
 */
export function addToBacklog(
  cwd: string,
  projectId: string,
  task: {
    id: string;
    title: string;
    description?: string;
    priority?: number;
    assignedRole?: RoleType;
    fileOwnership?: string[];
    sprintId?: string;
  }
): KanbanItem | null {
  return createTask(cwd, projectId, task);
}

/**
 * Get tasks assigned to a specific role.
 */
export function getRoleTasks(cwd: string, projectId: string, role: RoleType): KanbanItem[] {
  return getTasksByRole(cwd, projectId, role);
}

/**
 * Get tasks in review state awaiting judgment.
 */
export function getReviewQueue(cwd: string, projectId: string): KanbanItem[] {
  return getTasksByStatus(cwd, projectId, 'review');
}

/**
 * Get blocked tasks for triage.
 */
export function getBlockedTasks(cwd: string, projectId: string): KanbanItem[] {
  return getTasksByStatus(cwd, projectId, 'blocked');
}

/**
 * Format board as a summary string.
 */
export function formatBoardSummary(board: BoardView): string {
  const lines: string[] = ['## Kanban Board', ''];

  const columns: Array<{ name: string; items: KanbanItem[] }> = [
    { name: 'Backlog', items: board.backlog },
    { name: 'Todo', items: board.todo },
    { name: 'In Progress', items: board.inProgress },
    { name: 'Review', items: board.review },
    { name: 'Done', items: board.done },
    { name: 'Blocked', items: board.blocked },
    { name: 'Failed', items: board.failed },
    { name: 'Cancelled', items: board.cancelled },
  ];

  for (const col of columns) {
    if (col.items.length > 0) {
      lines.push(`### ${col.name} (${col.items.length})`);
      for (const item of col.items) {
        const role = item.assignedRole ? ` [${item.assignedRole}]` : '';
        const score = item.reviewScore !== null ? ` (score: ${item.reviewScore})` : '';
        lines.push(`- #${item.id} ${item.title}${role}${score}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
