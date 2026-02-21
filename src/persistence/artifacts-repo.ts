/**
 * Claude Team - Artifacts Repository
 *
 * Tracks deliverables produced by each role.
 */

import { getDb } from './db.js';
import type { Artifact, ArtifactType, ArtifactStatus, RoleType } from '../shared/types.js';
import { nowIso } from '../shared/utils.js';

function rowToArtifact(row: Record<string, unknown>): Artifact {
  return {
    id: row.id as string,
    producedByRole: row.produced_by_role as RoleType,
    artifactType: row.artifact_type as ArtifactType,
    filePath: row.file_path as string,
    status: row.status as ArtifactStatus,
    approvedBy: (row.approved_by as RoleType) ?? null,
    taskId: row.task_id as string,
    sprintId: (row.sprint_id as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function createArtifact(
  cwd: string,
  projectId: string,
  artifact: {
    id: string;
    producedByRole: RoleType;
    artifactType: ArtifactType;
    filePath: string;
    taskId: string;
    sprintId?: string;
  }
): Artifact | null {
  const db = getDb(cwd);
  if (!db) return null;

  const ts = nowIso();
  try {
    db.prepare(`
      INSERT INTO artifacts (id, project_id, produced_by_role, artifact_type, file_path, status, task_id, sprint_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(
      artifact.id, projectId, artifact.producedByRole, artifact.artifactType,
      artifact.filePath, artifact.taskId, artifact.sprintId ?? null, ts, ts
    );
    return getArtifact(cwd, artifact.id);
  } catch (error) {
    console.error('[artifacts-repo] Failed to create artifact:', error);
    return null;
  }
}

export function getArtifact(cwd: string, artifactId: string): Artifact | null {
  const db = getDb(cwd);
  if (!db) return null;

  try {
    const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as Record<string, unknown> | undefined;
    return row ? rowToArtifact(row) : null;
  } catch {
    return null;
  }
}

export function getArtifactsByProject(cwd: string, projectId: string): Artifact[] {
  const db = getDb(cwd);
  if (!db) return [];

  try {
    const rows = db.prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as Record<string, unknown>[];
    return rows.map(rowToArtifact);
  } catch {
    return [];
  }
}

export function updateArtifactStatus(cwd: string, artifactId: string, status: ArtifactStatus, approvedBy?: RoleType): boolean {
  const db = getDb(cwd);
  if (!db) return false;

  try {
    db.prepare('UPDATE artifacts SET status = ?, approved_by = ?, updated_at = ? WHERE id = ?')
      .run(status, approvedBy ?? null, nowIso(), artifactId);
    return true;
  } catch {
    return false;
  }
}
