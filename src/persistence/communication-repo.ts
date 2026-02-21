/**
 * Claude Team - Communication Repository
 *
 * Stores inter-role communication logs.
 */

import { getDb } from './db.js';
import type { TeamMessage, MessageType, ChannelType, RoleType } from '../shared/types.js';
import { nowIso, safeParseJson } from '../shared/utils.js';

function rowToMessage(row: Record<string, unknown>): TeamMessage {
  return {
    id: String(row.id),
    fromRole: row.from_role as RoleType,
    toRole: row.to_role as RoleType | 'all',
    messageType: row.message_type as MessageType,
    channel: row.channel as ChannelType,
    content: row.content as string,
    metadata: row.metadata ? safeParseJson<Record<string, unknown>>(row.metadata as string, {}) : {},
    timestamp: row.timestamp as string,
  };
}

export function logMessage(
  cwd: string,
  projectId: string,
  message: {
    fromRole: RoleType;
    toRole: RoleType | 'all';
    messageType: MessageType;
    channel?: ChannelType;
    content: string;
    metadata?: Record<string, unknown>;
  }
): boolean {
  const db = getDb(cwd);
  if (!db) return false;

  try {
    db.prepare(`
      INSERT INTO communication_log (project_id, from_role, to_role, message_type, channel, content, metadata, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId, message.fromRole, message.toRole, message.messageType,
      message.channel ?? 'dm', message.content,
      message.metadata ? JSON.stringify(message.metadata) : null,
      nowIso()
    );
    return true;
  } catch (error) {
    console.error('[communication-repo] Failed to log message:', error);
    return false;
  }
}

export function getMessages(cwd: string, projectId: string, limit = 50): TeamMessage[] {
  const db = getDb(cwd);
  if (!db) return [];

  try {
    const rows = db.prepare('SELECT * FROM communication_log WHERE project_id = ? ORDER BY timestamp DESC LIMIT ?')
      .all(projectId, limit) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  } catch {
    return [];
  }
}

export function getMessagesByRole(cwd: string, projectId: string, role: RoleType): TeamMessage[] {
  const db = getDb(cwd);
  if (!db) return [];

  try {
    const rows = db.prepare(
      'SELECT * FROM communication_log WHERE project_id = ? AND (from_role = ? OR to_role = ? OR to_role = ?) ORDER BY timestamp DESC'
    ).all(projectId, role, role, 'all') as Record<string, unknown>[];
    return rows.map(rowToMessage);
  } catch {
    return [];
  }
}

export function getMessagesByType(cwd: string, projectId: string, type: MessageType): TeamMessage[] {
  const db = getDb(cwd);
  if (!db) return [];

  try {
    const rows = db.prepare('SELECT * FROM communication_log WHERE project_id = ? AND message_type = ? ORDER BY timestamp DESC')
      .all(projectId, type) as Record<string, unknown>[];
    return rows.map(rowToMessage);
  } catch {
    return [];
  }
}
