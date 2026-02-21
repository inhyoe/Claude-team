/**
 * Claude Team - Roles Repository
 *
 * CRUD operations for role assignments.
 */

import { getDb } from './db.js';
import type { RoleAssignment, RoleType, ProviderType, ModelType } from '../shared/types.js';
import { nowIso, safeParseJson } from '../shared/utils.js';

function rowToRoleAssignment(row: Record<string, unknown>): RoleAssignment {
  return {
    roleId: row.role_id as string,
    role: row.role as RoleType,
    dagLayer: (row.dag_layer as RoleAssignment['dagLayer']) ?? 'worker',
    personaName: row.persona_name as string,
    agentName: (row.agent_name as string) ?? '',
    provider: row.provider as ProviderType,
    model: row.model as ModelType,
    isMergedInto: (row.is_merged_into as string) ?? null,
    mergedRoles: row.merged_roles ? safeParseJson<RoleType[]>(row.merged_roles as string, []) : [],
    status: row.status as RoleAssignment['status'],
  };
}

export function createRole(
  cwd: string,
  projectId: string,
  role: {
    roleId: string;
    role: RoleType;
    dagLayer?: string;
    personaName: string;
    agentName?: string;
    provider: ProviderType;
    model: ModelType;
    isMergedInto?: string;
    mergedRoles?: RoleType[];
  }
): RoleAssignment | null {
  const db = getDb(cwd);
  if (!db) return null;

  const ts = nowIso();
  try {
    db.prepare(`
      INSERT INTO roles (role_id, project_id, role, dag_layer, persona_name, agent_name, provider, model,
        is_merged_into, merged_roles, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(
      role.roleId, projectId, role.role, role.dagLayer ?? 'worker',
      role.personaName,
      role.agentName ?? null, role.provider, role.model,
      role.isMergedInto ?? null,
      role.mergedRoles ? JSON.stringify(role.mergedRoles) : null,
      ts, ts
    );

    return getRole(cwd, role.roleId);
  } catch (error) {
    console.error('[roles-repo] Failed to create role:', error);
    return null;
  }
}

export function getRole(cwd: string, roleId: string): RoleAssignment | null {
  const db = getDb(cwd);
  if (!db) return null;

  try {
    const row = db.prepare('SELECT * FROM roles WHERE role_id = ?').get(roleId) as Record<string, unknown> | undefined;
    return row ? rowToRoleAssignment(row) : null;
  } catch {
    return null;
  }
}

export function getRolesByProject(cwd: string, projectId: string): RoleAssignment[] {
  const db = getDb(cwd);
  if (!db) return [];

  try {
    const rows = db.prepare('SELECT * FROM roles WHERE project_id = ? ORDER BY role ASC')
      .all(projectId) as Record<string, unknown>[];
    return rows.map(rowToRoleAssignment);
  } catch {
    return [];
  }
}

export function getActiveRoles(cwd: string, projectId: string): RoleAssignment[] {
  const db = getDb(cwd);
  if (!db) return [];

  try {
    const rows = db.prepare("SELECT * FROM roles WHERE project_id = ? AND status = 'active' AND is_merged_into IS NULL")
      .all(projectId) as Record<string, unknown>[];
    return rows.map(rowToRoleAssignment);
  } catch {
    return [];
  }
}

export function updateRoleStatus(cwd: string, roleId: string, status: RoleAssignment['status']): boolean {
  const db = getDb(cwd);
  if (!db) return false;

  try {
    db.prepare('UPDATE roles SET status = ?, updated_at = ? WHERE role_id = ?')
      .run(status, nowIso(), roleId);
    return true;
  } catch {
    return false;
  }
}

export function updateRoleAgent(cwd: string, roleId: string, agentName: string): boolean {
  const db = getDb(cwd);
  if (!db) return false;

  try {
    db.prepare('UPDATE roles SET agent_name = ?, updated_at = ? WHERE role_id = ?')
      .run(agentName, nowIso(), roleId);
    return true;
  } catch {
    return false;
  }
}

export function mergeRole(cwd: string, roleId: string, mergedInto: string): boolean {
  const db = getDb(cwd);
  if (!db) return false;

  try {
    db.prepare('UPDATE roles SET is_merged_into = ?, status = ?, updated_at = ? WHERE role_id = ?')
      .run(mergedInto, 'idle', nowIso(), roleId);
    return true;
  } catch {
    return false;
  }
}
