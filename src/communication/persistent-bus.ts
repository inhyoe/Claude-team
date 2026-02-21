/**
 * Claude Team - Persistent Message Bus
 *
 * SQLite-backed message bus for cross-process communication.
 * Unlike MessageBus (in-memory), this works across separate Claude Code sessions.
 */

import type { TeamMessage, RoleType } from '../shared/types.js';
import { validateMessage, canSend, canReceive } from './protocol.js';
import {
  enqueueMessage,
  dequeueMessages,
  acknowledgeMessage,
  acknowledgeAll,
  getUndeliveredCount,
  broadcastMessage,
  expireOldMessages,
  type EnqueueInput,
  type QueuedMessage,
} from '../persistence/message-queue-repo.js';
import { nowIso } from '../shared/utils.js';

// ============================================================
// PERSISTENT MESSAGE BUS
// ============================================================

export interface SendResult {
  queued: boolean;
  messageId: number | null;
  error?: string;
}

/**
 * Persistent message bus backed by SQLite.
 * Enables cross-process communication between agents running in separate Claude Code sessions.
 */
export class PersistentMessageBus {
  private cwd: string;
  private projectId: string;

  constructor(cwd: string, projectId: string) {
    this.cwd = cwd;
    this.projectId = projectId;
  }

  /**
   * Send a message (enqueue to SQLite).
   * Validates message and permissions before queueing.
   */
  async send(message: TeamMessage): Promise<SendResult> {
    // Validate message structure
    const validation = validateMessage(message);
    if (!validation.valid) {
      return {
        queued: false,
        messageId: null,
        error: `Validation failed: ${validation.error}`,
      };
    }

    // Check send permission
    if (!canSend(message.fromRole, message.messageType)) {
      return {
        queued: false,
        messageId: null,
        error: `${message.fromRole} cannot send ${message.messageType}`,
      };
    }

    // Check receive permission (for DM, not broadcast)
    if (message.toRole !== 'all' && !canReceive(message.toRole, message.messageType)) {
      return {
        queued: false,
        messageId: null,
        error: `${message.toRole} cannot receive ${message.messageType}`,
      };
    }

    // Enqueue the message
    const input: EnqueueInput = {
      fromRole: message.fromRole,
      toRole: message.toRole,
      messageType: message.messageType,
      channel: message.channel,
      content: message.content,
      metadata: message.metadata,
    };

    const messageId = enqueueMessage(this.cwd, this.projectId, input);

    if (messageId === null) {
      return {
        queued: false,
        messageId: null,
        error: 'Failed to enqueue message to database',
      };
    }

    return { queued: true, messageId };
  }

  /**
   * Poll for new messages (dequeue from SQLite).
   * Messages are marked as 'delivered' and returned in FIFO order.
   */
  async poll(role: RoleType, limit = 50): Promise<TeamMessage[]> {
    const queuedMessages = dequeueMessages(this.cwd, role, limit);

    return queuedMessages.map(qm => this.queuedToTeamMessage(qm));
  }

  /**
   * Acknowledge receipt of a message.
   */
  async ack(messageId: number): Promise<void> {
    acknowledgeMessage(this.cwd, messageId);
  }

  /**
   * Acknowledge all delivered messages for a role.
   */
  async ackAll(role: RoleType): Promise<void> {
    acknowledgeAll(this.cwd, role);
  }

  /**
   * Get count of pending (undelivered) messages for a role.
   */
  async pending(role: RoleType): Promise<number> {
    return getUndeliveredCount(this.cwd, role);
  }

  /**
   * Broadcast a message to multiple roles.
   * Creates one queue entry per target role.
   */
  async broadcast(message: Omit<TeamMessage, 'toRole'>, roles: RoleType[]): Promise<void> {
    // Validate message structure (simulate full message for validation)
    const testMessage: TeamMessage = { ...message, toRole: 'all' };
    const validation = validateMessage(testMessage);
    if (!validation.valid) {
      console.error('[persistent-bus] Broadcast validation failed:', validation.error);
      return;
    }

    // Check send permission
    if (!canSend(message.fromRole, message.messageType)) {
      console.error(`[persistent-bus] ${message.fromRole} cannot send ${message.messageType}`);
      return;
    }

    // Filter roles by receive permission
    const validRoles = roles.filter(role => canReceive(role, message.messageType));

    if (validRoles.length === 0) {
      console.warn('[persistent-bus] No valid recipients for broadcast');
      return;
    }

    const input: Omit<EnqueueInput, 'toRole'> = {
      fromRole: message.fromRole,
      messageType: message.messageType,
      channel: message.channel ?? 'broadcast',
      content: message.content,
      metadata: message.metadata,
    };

    broadcastMessage(this.cwd, this.projectId, input, validRoles);
  }

  /**
   * Cleanup expired messages.
   * Returns count of messages marked as expired.
   */
  async cleanup(): Promise<number> {
    return expireOldMessages(this.cwd, this.projectId);
  }

  /**
   * Convert a QueuedMessage to TeamMessage format.
   */
  private queuedToTeamMessage(qm: QueuedMessage): TeamMessage {
    return {
      id: `msg-${qm.id}`,
      fromRole: qm.fromRole,
      toRole: qm.toRole,
      messageType: qm.messageType,
      channel: qm.channel,
      content: qm.content,
      metadata: qm.metadata,
      timestamp: qm.createdAt,
    };
  }
}

// ============================================================
// CONVENIENCE FUNCTIONS
// ============================================================

/**
 * Create a PersistentMessageBus instance for a project.
 */
export function createPersistentBus(cwd: string, projectId: string): PersistentMessageBus {
  return new PersistentMessageBus(cwd, projectId);
}

/**
 * Build a TeamMessage for enqueueing via persistent bus.
 */
export function buildTeamMessage(
  fromRole: RoleType,
  toRole: RoleType | 'all',
  messageType: TeamMessage['messageType'],
  content: string,
  channel: TeamMessage['channel'] = 'dm',
  metadata: Record<string, unknown> = {}
): TeamMessage {
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    fromRole,
    toRole,
    messageType,
    channel,
    content,
    metadata,
    timestamp: nowIso(),
  };
}
