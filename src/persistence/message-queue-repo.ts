/**
 * Claude Team - Message Queue Repository
 *
 * SQLite-backed message queue for cross-process communication.
 * Agents in different processes can enqueue/dequeue messages via this persistent queue.
 */

import { getDb, withTransaction } from './db.js';
import { logMessage } from './communication-repo.js';
import type { RoleType, MessageType, ChannelType } from '../shared/types.js';
import { nowIso, safeParseJson } from '../shared/utils.js';

// ============================================================
// TYPES
// ============================================================

export interface EnqueueInput {
  fromRole: RoleType;
  toRole: RoleType | 'all';
  messageType: MessageType;
  channel?: ChannelType;
  content: string;
  metadata?: Record<string, unknown>;
  expiresInMs?: number; // optional TTL
}

export interface QueuedMessage {
  id: number;
  projectId: string;
  fromRole: RoleType;
  toRole: RoleType | 'all';
  messageType: MessageType;
  channel: ChannelType;
  content: string;
  metadata: Record<string, unknown>;
  status: 'pending' | 'delivered' | 'acknowledged' | 'expired';
  createdAt: string;
  deliveredAt: string | null;
  expiresAt: string | null;
}

export interface MessageQueryOptions {
  fromRole?: RoleType;
  toRole?: RoleType;
  messageType?: MessageType;
  status?: 'pending' | 'delivered' | 'acknowledged' | 'expired';
  limit?: number;
  offset?: number;
}

// ============================================================
// HELPERS
// ============================================================

function rowToQueuedMessage(row: Record<string, unknown>): QueuedMessage {
  return {
    id: row.id as number,
    projectId: row.project_id as string,
    fromRole: row.from_role as RoleType,
    toRole: row.to_role as RoleType | 'all',
    messageType: row.message_type as MessageType,
    channel: row.channel as ChannelType,
    content: row.content as string,
    metadata: row.metadata ? safeParseJson<Record<string, unknown>>(row.metadata as string, {}) : {},
    status: row.status as 'pending' | 'delivered' | 'acknowledged' | 'expired',
    createdAt: row.created_at as string,
    deliveredAt: (row.delivered_at as string) ?? null,
    expiresAt: (row.expires_at as string) ?? null,
  };
}

function calculateExpiresAt(expiresInMs?: number): string | null {
  if (!expiresInMs) return null;
  const expiresAt = new Date(Date.now() + expiresInMs);
  return expiresAt.toISOString();
}

// ============================================================
// REPOSITORY FUNCTIONS
// ============================================================

/**
 * Enqueue a message to the persistent queue.
 * Returns the message ID on success, null on failure.
 */
export function enqueueMessage(
  cwd: string,
  projectId: string,
  msg: EnqueueInput
): number | null {
  const db = getDb(cwd);
  if (!db) return null;

  const ts = nowIso();
  const expiresAt = calculateExpiresAt(msg.expiresInMs);

  try {
    const result = db.prepare(`
      INSERT INTO message_queue (project_id, from_role, to_role, message_type, channel, content, metadata, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      projectId,
      msg.fromRole,
      msg.toRole,
      msg.messageType,
      msg.channel ?? 'dm',
      msg.content,
      msg.metadata ? JSON.stringify(msg.metadata) : null,
      ts,
      expiresAt
    );

    // Also log to communication_log for audit trail
    logMessage(cwd, projectId, {
      fromRole: msg.fromRole,
      toRole: msg.toRole,
      messageType: msg.messageType,
      channel: msg.channel ?? 'dm',
      content: msg.content,
      metadata: msg.metadata,
    });

    return result.lastInsertRowid as number;
  } catch (error) {
    console.error('[message-queue-repo] Failed to enqueue message:', error);
    return null;
  }
}

/**
 * Dequeue pending messages for a role and mark them as delivered.
 * Uses a transaction to ensure atomicity.
 * Returns messages in FIFO order (oldest first).
 */
export function dequeueMessages(
  cwd: string,
  role: RoleType,
  limit = 50
): QueuedMessage[] {
  const result = withTransaction(cwd, (db) => {
    const ts = nowIso();

    // Select pending messages for this role (or broadcast to 'all')
    const rows = db.prepare(`
      SELECT * FROM message_queue
      WHERE (to_role = ? OR to_role = 'all')
        AND status = 'pending'
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at ASC
      LIMIT ?
    `).all(role, ts, limit) as Record<string, unknown>[];

    if (rows.length === 0) return [];

    // Mark them as delivered
    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`
      UPDATE message_queue
      SET status = 'delivered', delivered_at = ?
      WHERE id IN (${placeholders})
    `).run(ts, ...ids);

    return rows.map(rowToQueuedMessage);
  });

  return result ?? [];
}

/**
 * Mark a message as acknowledged.
 */
export function acknowledgeMessage(cwd: string, messageId: number): boolean {
  const db = getDb(cwd);
  if (!db) return false;

  try {
    db.prepare('UPDATE message_queue SET status = ? WHERE id = ?')
      .run('acknowledged', messageId);
    return true;
  } catch (error) {
    console.error('[message-queue-repo] Failed to acknowledge message:', error);
    return false;
  }
}

/**
 * Acknowledge all delivered messages for a role.
 */
export function acknowledgeAll(cwd: string, role: RoleType): boolean {
  const db = getDb(cwd);
  if (!db) return false;

  try {
    db.prepare('UPDATE message_queue SET status = ? WHERE to_role = ? AND status = ?')
      .run('acknowledged', role, 'delivered');
    return true;
  } catch (error) {
    console.error('[message-queue-repo] Failed to acknowledge all messages:', error);
    return false;
  }
}

/**
 * Get count of pending (undelivered) messages for a role.
 */
export function getUndeliveredCount(cwd: string, role: RoleType): number {
  const db = getDb(cwd);
  if (!db) return 0;

  try {
    const ts = nowIso();
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM message_queue
      WHERE (to_role = ? OR to_role = 'all')
        AND status = 'pending'
        AND (expires_at IS NULL OR expires_at > ?)
    `).get(role, ts) as { cnt: number } | undefined;

    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Broadcast a message to multiple roles (inserts one message per role).
 * Uses a transaction for atomicity.
 */
export function broadcastMessage(
  cwd: string,
  projectId: string,
  msg: Omit<EnqueueInput, 'toRole'>,
  roles: RoleType[]
): boolean {
  const result = withTransaction(cwd, (db) => {
    const ts = nowIso();
    const expiresAt = calculateExpiresAt(msg.expiresInMs);

    const stmt = db.prepare(`
      INSERT INTO message_queue (project_id, from_role, to_role, message_type, channel, content, metadata, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);

    for (const role of roles) {
      stmt.run(
        projectId,
        msg.fromRole,
        role,
        msg.messageType,
        msg.channel ?? 'broadcast',
        msg.content,
        msg.metadata ? JSON.stringify(msg.metadata) : null,
        ts,
        expiresAt
      );
    }

    // Log to communication_log with toRole='all'
    logMessage(cwd, projectId, {
      fromRole: msg.fromRole,
      toRole: 'all',
      messageType: msg.messageType,
      channel: msg.channel ?? 'broadcast',
      content: msg.content,
      metadata: msg.metadata,
    });

    return true;
  });

  return result ?? false;
}

/**
 * Mark expired messages (where expires_at < now).
 * Returns count of expired messages.
 */
export function expireOldMessages(cwd: string, projectId: string): number {
  const db = getDb(cwd);
  if (!db) return 0;

  try {
    const ts = nowIso();
    const result = db.prepare(`
      UPDATE message_queue
      SET status = 'expired'
      WHERE project_id = ?
        AND status = 'pending'
        AND expires_at IS NOT NULL
        AND expires_at < ?
    `).run(projectId, ts);

    return result.changes;
  } catch (error) {
    console.error('[message-queue-repo] Failed to expire messages:', error);
    return 0;
  }
}

/**
 * Get message history with optional filters.
 */
export function getMessageHistory(
  cwd: string,
  projectId: string,
  options?: MessageQueryOptions
): QueuedMessage[] {
  const db = getDb(cwd);
  if (!db) return [];

  try {
    const conditions: string[] = ['project_id = ?'];
    const params: unknown[] = [projectId];

    if (options?.fromRole) {
      conditions.push('from_role = ?');
      params.push(options.fromRole);
    }

    if (options?.toRole) {
      conditions.push('to_role = ?');
      params.push(options.toRole);
    }

    if (options?.messageType) {
      conditions.push('message_type = ?');
      params.push(options.messageType);
    }

    if (options?.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }

    const whereClause = conditions.join(' AND ');
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    const rows = db.prepare(`
      SELECT * FROM message_queue
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Record<string, unknown>[];

    return rows.map(rowToQueuedMessage);
  } catch (error) {
    console.error('[message-queue-repo] Failed to get message history:', error);
    return [];
  }
}
