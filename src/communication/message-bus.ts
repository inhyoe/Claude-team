/**
 * Claude Team - Message Bus
 *
 * Multi-channel message routing between role-based agents.
 * Routes messages through DM, broadcast, or artifact channels.
 *
 * ARCHITECTURE DECISION: Concurrency & Race Conditions
 * ─────────────────────────────────────────────────────
 * The message bus and JSON state files have no built-in file locking.
 * Read-modify-write races are mitigated through three strategies:
 *
 * 1. PL single-mediator: Shared file conflicts are serialized through PL,
 *    avoiding distributed locking entirely.
 * 2. Pre-assigned ownership: The team lead pre-assigns task owners before
 *    spawning workers, preventing race-to-claim scenarios.
 * 3. File ownership scoping: DAG nodes have exclusive file patterns,
 *    so concurrent workers modify disjoint file sets.
 *
 * For true atomic operations, use the SQLite persistence layer with
 * withTransaction() from db.ts instead.
 */

import type {
  TeamMessage,
  RoleType,
  MessageType,
  ChannelType,
} from '../shared/types.js';
import { logMessage } from '../persistence/communication-repo.js';
import { validateMessage, canSend, canReceive } from './protocol.js';

// ============================================================
// MESSAGE BUS
// ============================================================

export interface MessageHandler {
  role: RoleType;
  handler: (message: TeamMessage) => void | Promise<void>;
}

export interface RouteResult {
  delivered: boolean;
  recipients: RoleType[];
  errors: string[];
}

/**
 * In-memory message bus for routing team messages.
 * Persists all messages to SQLite for audit trail.
 */
export class MessageBus {
  private handlers: Map<RoleType, MessageHandler[]> = new Map();
  private cwd: string;
  private projectId: string;

  constructor(cwd: string, projectId: string) {
    this.cwd = cwd;
    this.projectId = projectId;
  }

  /**
   * Register a message handler for a role.
   */
  subscribe(role: RoleType, handler: (message: TeamMessage) => void | Promise<void>): void {
    const existing = this.handlers.get(role) ?? [];
    existing.push({ role, handler });
    this.handlers.set(role, existing);
  }

  /**
   * Unsubscribe all handlers for a role.
   */
  unsubscribe(role: RoleType): void {
    this.handlers.delete(role);
  }

  /**
   * Route a message to its intended recipients.
   */
  async route(message: TeamMessage): Promise<RouteResult> {
    const errors: string[] = [];
    const recipients: RoleType[] = [];

    // Validate message structure
    const validation = validateMessage(message);
    if (!validation.valid) {
      return { delivered: false, recipients: [], errors: [`Validation failed: ${validation.error}`] };
    }

    // Check send permission
    if (!canSend(message.fromRole, message.messageType)) {
      return {
        delivered: false,
        recipients: [],
        errors: [`${message.fromRole} cannot send ${message.messageType}`],
      };
    }

    // Persist to communication log
    try {
      logMessage(this.cwd, this.projectId, {
        fromRole: message.fromRole,
        toRole: message.toRole,
        messageType: message.messageType,
        content: message.content,
        channel: message.channel,
      });
    } catch (err) {
      errors.push(`Persistence error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Route based on channel
    switch (message.channel) {
      case 'dm':
        return this.routeDM(message, errors);
      case 'broadcast':
        return this.routeBroadcast(message, errors);
      case 'artifact':
        return this.routeArtifact(message, errors);
      default:
        return { delivered: false, recipients, errors: [`Unknown channel: ${message.channel}`] };
    }
  }

  /**
   * Route a direct message to a specific role.
   */
  private async routeDM(message: TeamMessage, errors: string[]): Promise<RouteResult> {
    const recipients: RoleType[] = [];

    if (message.toRole === 'all') {
      errors.push('DM channel requires a specific recipient, not "all"');
      return { delivered: false, recipients, errors };
    }

    const targetRole = message.toRole as RoleType;

    // Check receive permission
    if (!canReceive(targetRole, message.messageType)) {
      errors.push(`${targetRole} cannot receive ${message.messageType}`);
      return { delivered: false, recipients, errors };
    }

    const handlers = this.handlers.get(targetRole);
    if (!handlers || handlers.length === 0) {
      errors.push(`No handlers registered for ${targetRole}`);
      return { delivered: false, recipients, errors };
    }

    for (const h of handlers) {
      try {
        await h.handler(message);
        recipients.push(h.role);
      } catch (err) {
        errors.push(`Handler error for ${h.role}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { delivered: recipients.length > 0, recipients, errors };
  }

  /**
   * Route a broadcast message to all subscribed roles.
   */
  private async routeBroadcast(message: TeamMessage, errors: string[]): Promise<RouteResult> {
    const recipients: RoleType[] = [];

    for (const [role, handlers] of this.handlers) {
      if (role === message.fromRole) continue; // Don't send to self

      if (!canReceive(role, message.messageType)) continue;

      for (const h of handlers) {
        try {
          await h.handler(message);
          recipients.push(h.role);
        } catch (err) {
          errors.push(`Handler error for ${h.role}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return { delivered: recipients.length > 0, recipients, errors };
  }

  /**
   * Route an artifact notification.
   * Artifact content is exchanged via file system; this just notifies.
   */
  private async routeArtifact(message: TeamMessage, errors: string[]): Promise<RouteResult> {
    // Artifact messages go to specific recipient or all
    if (message.toRole === 'all') {
      return this.routeBroadcast(message, errors);
    }
    return this.routeDM(message, errors);
  }

  /**
   * Get all registered roles.
   */
  getRegisteredRoles(): RoleType[] {
    return [...this.handlers.keys()];
  }

  /**
   * Check if a role has registered handlers.
   */
  isRoleActive(role: RoleType): boolean {
    const handlers = this.handlers.get(role);
    return handlers !== undefined && handlers.length > 0;
  }

  /**
   * Clear all handlers (for cleanup).
   */
  clear(): void {
    this.handlers.clear();
  }
}

// ============================================================
// CONVENIENCE FUNCTIONS
// ============================================================

/**
 * Build a SendMessage-compatible DM payload for Claude Code's team tools.
 */
export function buildSendMessageDM(
  recipient: string,
  content: string,
  summary: string
): { type: 'message'; recipient: string; content: string; summary: string } {
  return { type: 'message', recipient, content, summary };
}

/**
 * Build a SendMessage-compatible broadcast payload.
 */
export function buildSendMessageBroadcast(
  content: string,
  summary: string
): { type: 'broadcast'; content: string; summary: string } {
  return { type: 'broadcast', content, summary };
}

/**
 * Format a team message for human-readable display.
 */
export function formatMessage(msg: TeamMessage): string {
  return `[${msg.timestamp}] ${msg.fromRole} -> ${msg.toRole} (${msg.messageType}/${msg.channel}): ${msg.content.substring(0, 200)}`;
}
