/**
 * Claude Team - Sprints Repository
 */

import { getDb } from './db.js';
import type { Sprint, SprintStatus } from '../shared/types.js';
import { nowIso } from '../shared/utils.js';

function rowToSprint(row: Record<string, unknown>): Sprint {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    sprintNumber: row.sprint_number as number,
    goal: row.goal as string,
    status: row.status as SprintStatus,
    velocityScore: (row.velocity_score as number) ?? null,
    taskIds: [],
    startedAt: row.started_at as string,
    completedAt: (row.completed_at as string) ?? null,
  };
}

export function createSprint(
  cwd: string,
  projectId: string,
  sprint: { id: string; sprintNumber: number; goal: string }
): Sprint | null {
  const db = getDb(cwd);
  if (!db) return null;

  const ts = nowIso();
  try {
    db.prepare(`
      INSERT INTO sprints (id, project_id, sprint_number, goal, status, started_at)
      VALUES (?, ?, ?, ?, 'planning', ?)
    `).run(sprint.id, projectId, sprint.sprintNumber, sprint.goal, ts);
    return getSprint(cwd, sprint.id);
  } catch (error) {
    console.error('[sprints-repo] Failed to create sprint:', error);
    return null;
  }
}

/**
 * Populate taskIds by querying tasks that reference this sprint.
 */
function fillTaskIds(db: ReturnType<typeof getDb>, sprint: Sprint): Sprint {
  if (!db) return sprint;
  try {
    const rows = db.prepare('SELECT id FROM tasks WHERE sprint_id = ?').all(sprint.id) as { id: string }[];
    sprint.taskIds = rows.map(r => r.id);
  } catch {
    // leave as empty if query fails
  }
  return sprint;
}

export function getSprint(cwd: string, sprintId: string): Sprint | null {
  const db = getDb(cwd);
  if (!db) return null;

  try {
    const row = db.prepare('SELECT * FROM sprints WHERE id = ?').get(sprintId) as Record<string, unknown> | undefined;
    return row ? fillTaskIds(db, rowToSprint(row)) : null;
  } catch {
    return null;
  }
}

export function getSprintsByProject(cwd: string, projectId: string): Sprint[] {
  const db = getDb(cwd);
  if (!db) return [];

  try {
    const rows = db.prepare('SELECT * FROM sprints WHERE project_id = ? ORDER BY sprint_number ASC')
      .all(projectId) as Record<string, unknown>[];
    return rows.map(r => fillTaskIds(db, rowToSprint(r)));
  } catch {
    return [];
  }
}

export function updateSprintStatus(cwd: string, sprintId: string, status: SprintStatus, velocityScore?: number): boolean {
  const db = getDb(cwd);
  if (!db) return false;

  try {
    const completedAt = (status === 'completed') ? nowIso() : null;
    db.prepare('UPDATE sprints SET status = ?, velocity_score = ?, completed_at = ? WHERE id = ?')
      .run(status, velocityScore ?? null, completedAt, sprintId);
    return true;
  } catch {
    return false;
  }
}
