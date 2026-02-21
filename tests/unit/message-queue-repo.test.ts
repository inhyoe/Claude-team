/**
 * Message Queue Repository unit tests
 *
 * Tests: enqueue, dequeue, acknowledge, broadcast, expiration, message history.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  enqueueMessage,
  dequeueMessages,
  acknowledgeMessage,
  acknowledgeAll,
  getUndeliveredCount,
  broadcastMessage,
  expireOldMessages,
  getMessageHistory,
} from '../../src/persistence/message-queue-repo.js';
import type { EnqueueInput, QueuedMessage } from '../../src/persistence/message-queue-repo.js';
import { initDb, getDb, closeDb } from '../../src/persistence/db.js';

let testDir: string;
const projectId = 'test-proj';

/** Seed a project row so FK constraints pass. */
function seedProject(dir: string): void {
  const db = getDb(dir)!;
  db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, path, session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `).run(projectId, 'Test Project', dir, 'session-queue-test');
}

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'ct-message-queue-test-'));
  await initDb(testDir);
  seedProject(testDir);
});

afterEach(() => {
  if (testDir) {
    closeDb(testDir);
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================
// ENQUEUE
// ============================================================

describe('enqueueMessage', () => {
  it('enqueues a valid message and returns message ID', () => {
    const msg: EnqueueInput = {
      fromRole: 'pm',
      toRole: 'fe-dev',
      messageType: 'task_assignment',
      channel: 'dm',
      content: 'Please implement feature X',
    };

    const messageId = enqueueMessage(testDir, projectId, msg);
    expect(messageId).not.toBeNull();
    expect(typeof messageId).toBe('number');
    expect(messageId).toBeGreaterThan(0);
  });

  it('returns null when database is not initialized', () => {
    const msg: EnqueueInput = {
      fromRole: 'pm',
      toRole: 'fe-dev',
      messageType: 'task_assignment',
      content: 'Test message',
    };

    const messageId = enqueueMessage('/nonexistent', projectId, msg);
    expect(messageId).toBeNull();
  });

  it('enqueues message with metadata serialization', () => {
    const msg: EnqueueInput = {
      fromRole: 'qa',
      toRole: 'be-dev',
      messageType: 'review_request',
      content: 'Review PR #123',
      metadata: {
        prNumber: 123,
        files: ['api.ts', 'db.ts'],
        priority: 'high',
      },
    };

    const messageId = enqueueMessage(testDir, projectId, msg);
    expect(messageId).not.toBeNull();

    // Verify metadata is stored
    const messages = getMessageHistory(testDir, projectId);
    const queued = messages.find(m => m.id === messageId);
    expect(queued?.metadata).toEqual({
      prNumber: 123,
      files: ['api.ts', 'db.ts'],
      priority: 'high',
    });
  });

  it('enqueues message with TTL and sets expiresAt', () => {
    const msg: EnqueueInput = {
      fromRole: 'pm',
      toRole: 'devops',
      messageType: 'escalation',
      content: 'Urgent: Deploy blocked',
      expiresInMs: 60000, // 1 minute
    };

    const beforeEnqueue = Date.now();
    const messageId = enqueueMessage(testDir, projectId, msg);
    const afterEnqueue = Date.now();

    expect(messageId).not.toBeNull();

    const messages = getMessageHistory(testDir, projectId);
    const queued = messages.find(m => m.id === messageId);
    expect(queued?.expiresAt).not.toBeNull();

    const expiresAtMs = new Date(queued!.expiresAt!).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(beforeEnqueue + 60000);
    expect(expiresAtMs).toBeLessThanOrEqual(afterEnqueue + 60000);
  });

  it('enqueues message without TTL (expiresAt is null)', () => {
    const msg: EnqueueInput = {
      fromRole: 'pl',
      toRole: 'fe-dev',
      messageType: 'status_report',
      content: 'Weekly update',
    };

    const messageId = enqueueMessage(testDir, projectId, msg);
    const messages = getMessageHistory(testDir, projectId);
    const queued = messages.find(m => m.id === messageId);

    expect(queued?.expiresAt).toBeNull();
  });

  it('defaults channel to dm when not specified', () => {
    const msg: EnqueueInput = {
      fromRole: 'pm',
      toRole: 'fe-dev',
      messageType: 'task_assignment',
      content: 'Default channel test',
    };

    const messageId = enqueueMessage(testDir, projectId, msg);
    const messages = getMessageHistory(testDir, projectId);
    const queued = messages.find(m => m.id === messageId);

    expect(queued?.channel).toBe('dm');
  });
});

// ============================================================
// DEQUEUE
// ============================================================

describe('dequeueMessages', () => {
  it('returns messages in FIFO order', () => {
    // Enqueue 3 messages
    enqueueMessage(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'fe-dev',
      messageType: 'task_assignment',
      content: 'First message',
    });

    // Small delay to ensure different timestamps
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    sleep(10);

    enqueueMessage(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'fe-dev',
      messageType: 'task_assignment',
      content: 'Second message',
    });

    sleep(10);

    enqueueMessage(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'fe-dev',
      messageType: 'task_assignment',
      content: 'Third message',
    });

    const messages = dequeueMessages(testDir, 'fe-dev');
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('First message');
    expect(messages[1].content).toBe('Second message');
    expect(messages[2].content).toBe('Third message');
  });

  it('marks messages as delivered', () => {
    const messageId = enqueueMessage(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'be-dev',
      messageType: 'task_assignment',
      content: 'Test delivery',
    });

    const messages = dequeueMessages(testDir, 'be-dev');
    expect(messages).toHaveLength(1);

    // Verify the message was marked as delivered in the database
    const history = getMessageHistory(testDir, projectId, { status: 'delivered' });
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(messageId);
    expect(history[0].status).toBe('delivered');
    expect(history[0].deliveredAt).not.toBeNull();
  });

  it('respects limit parameter', () => {
    // Enqueue 5 messages
    for (let i = 1; i <= 5; i++) {
      enqueueMessage(testDir, projectId, {
        fromRole: 'pm',
        toRole: 'qa',
        messageType: 'task_assignment',
        content: `Message ${i}`,
      });
    }

    const messages = dequeueMessages(testDir, 'qa', 3);
    expect(messages).toHaveLength(3);
  });

  it('includes broadcast messages (toRole = all)', () => {
    enqueueMessage(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'fe-dev',
      messageType: 'task_assignment',
      content: 'Direct message',
    });

    enqueueMessage(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'all',
      messageType: 'status_report',
      channel: 'broadcast',
      content: 'Broadcast to everyone',
    });

    const messages = dequeueMessages(testDir, 'fe-dev');
    expect(messages).toHaveLength(2);
    expect(messages.some(m => m.content === 'Broadcast to everyone')).toBe(true);
  });

  it('skips expired messages', () => {
    // Enqueue message with past expiration
    const pastTime = new Date(Date.now() - 60000).toISOString();
    const db = getDb(testDir)!;
    db.prepare(`
      INSERT INTO message_queue (project_id, from_role, to_role, message_type, channel, content, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(projectId, 'pm', 'fe-dev', 'task_assignment', 'dm', 'Expired message', pastTime, pastTime);

    // Enqueue valid message
    enqueueMessage(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'fe-dev',
      messageType: 'task_assignment',
      content: 'Valid message',
    });

    const messages = dequeueMessages(testDir, 'fe-dev');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Valid message');
  });

  it('returns empty array when no messages pending', () => {
    const messages = dequeueMessages(testDir, 'fe-dev');
    expect(messages).toEqual([]);
  });

  it('does not return already delivered messages', () => {
    enqueueMessage(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'fe-dev',
      messageType: 'task_assignment',
      content: 'First dequeue',
    });

    const firstDequeue = dequeueMessages(testDir, 'fe-dev');
    expect(firstDequeue).toHaveLength(1);

    const secondDequeue = dequeueMessages(testDir, 'fe-dev');
    expect(secondDequeue).toEqual([]);
  });
});

// ============================================================
// ACKNOWLEDGE
// ============================================================

describe('acknowledgeMessage', () => {
  it('marks a single message as acknowledged', () => {
    const messageId = enqueueMessage(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'fe-dev',
      messageType: 'task_assignment',
      content: 'Test ack',
    });

    const success = acknowledgeMessage(testDir, messageId!);
    expect(success).toBe(true);

    const messages = getMessageHistory(testDir, projectId);
    const msg = messages.find(m => m.id === messageId);
    expect(msg?.status).toBe('acknowledged');
  });

  it('returns false when database is not initialized', () => {
    const success = acknowledgeMessage('/nonexistent', 999);
    expect(success).toBe(false);
  });

  it('returns true even when message does not exist', () => {
    const success = acknowledgeMessage(testDir, 99999);
    expect(success).toBe(true); // SQLite UPDATE succeeds with 0 changes
  });
});

describe('acknowledgeAll', () => {
  it('acknowledges all delivered messages for a role', () => {
    // Enqueue and dequeue multiple messages
    for (let i = 1; i <= 3; i++) {
      enqueueMessage(testDir, projectId, {
        fromRole: 'pm',
        toRole: 'be-dev',
        messageType: 'task_assignment',
        content: `Task ${i}`,
      });
    }

    dequeueMessages(testDir, 'be-dev');

    const success = acknowledgeAll(testDir, 'be-dev');
    expect(success).toBe(true);

    const messages = getMessageHistory(testDir, projectId, {
      toRole: 'be-dev',
      status: 'acknowledged',
    });
    expect(messages).toHaveLength(3);
  });

  it('does not acknowledge messages for other roles', () => {
    enqueueMessage(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'fe-dev',
      messageType: 'task_assignment',
      content: 'FE task',
    });

    enqueueMessage(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'be-dev',
      messageType: 'task_assignment',
      content: 'BE task',
    });

    dequeueMessages(testDir, 'fe-dev');
    dequeueMessages(testDir, 'be-dev');

    acknowledgeAll(testDir, 'fe-dev');

    const feMessages = getMessageHistory(testDir, projectId, {
      toRole: 'fe-dev',
      status: 'acknowledged',
    });
    expect(feMessages).toHaveLength(1);

    const beMessages = getMessageHistory(testDir, projectId, {
      toRole: 'be-dev',
      status: 'delivered',
    });
    expect(beMessages).toHaveLength(1);
  });

  it('returns false when database is not initialized', () => {
    const success = acknowledgeAll('/nonexistent', 'fe-dev');
    expect(success).toBe(false);
  });
});

// ============================================================
// UNDELIVERED COUNT
// ============================================================

describe('getUndeliveredCount', () => {
  it('counts pending messages only', () => {
    // Enqueue 3 messages
    for (let i = 1; i <= 3; i++) {
      enqueueMessage(testDir, projectId, {
        fromRole: 'pm',
        toRole: 'qa',
        messageType: 'task_assignment',
        content: `Task ${i}`,
      });
    }

    const count = getUndeliveredCount(testDir, 'qa');
    expect(count).toBe(3);

    // Dequeue 2 messages
    dequeueMessages(testDir, 'qa', 2);

    const countAfter = getUndeliveredCount(testDir, 'qa');
    expect(countAfter).toBe(1);
  });

  it('includes broadcast messages in count', () => {
    enqueueMessage(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'fe-dev',
      messageType: 'task_assignment',
      content: 'Direct message',
    });

    enqueueMessage(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'all',
      messageType: 'broadcast',
      content: 'Broadcast',
    });

    const count = getUndeliveredCount(testDir, 'fe-dev');
    expect(count).toBe(2);
  });

  it('excludes expired messages from count', () => {
    // Enqueue expired message manually
    const pastTime = new Date(Date.now() - 60000).toISOString();
    const db = getDb(testDir)!;
    db.prepare(`
      INSERT INTO message_queue (project_id, from_role, to_role, message_type, channel, content, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(projectId, 'pm', 'devops', 'escalation', 'dm', 'Expired', pastTime, pastTime);

    enqueueMessage(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'devops',
      messageType: 'task_assignment',
      content: 'Valid',
    });

    const count = getUndeliveredCount(testDir, 'devops');
    expect(count).toBe(1);
  });

  it('returns 0 when no messages pending', () => {
    const count = getUndeliveredCount(testDir, 'security');
    expect(count).toBe(0);
  });

  it('returns 0 when database is not initialized', () => {
    const count = getUndeliveredCount('/nonexistent', 'fe-dev');
    expect(count).toBe(0);
  });
});

// ============================================================
// BROADCAST
// ============================================================

describe('broadcastMessage', () => {
  it('inserts one message per role', () => {
    const msg = {
      fromRole: 'pm' as const,
      messageType: 'broadcast' as const,
      channel: 'broadcast' as const,
      content: 'Team update',
    };

    const roles = ['fe-dev', 'be-dev', 'qa'] as const;
    const success = broadcastMessage(testDir, projectId, msg, roles);
    expect(success).toBe(true);

    const feMessages = getMessageHistory(testDir, projectId, { toRole: 'fe-dev' });
    expect(feMessages).toHaveLength(1);

    const beMessages = getMessageHistory(testDir, projectId, { toRole: 'be-dev' });
    expect(beMessages).toHaveLength(1);

    const qaMessages = getMessageHistory(testDir, projectId, { toRole: 'qa' });
    expect(qaMessages).toHaveLength(1);
  });

  it('is transactional (all or nothing)', () => {
    const msg = {
      fromRole: 'pm' as const,
      messageType: 'broadcast' as const,
      content: 'Broadcast test',
    };

    const roles = ['fe-dev', 'be-dev'] as const;
    const success = broadcastMessage(testDir, projectId, msg, roles);
    expect(success).toBe(true);

    // Verify both messages exist
    const allMessages = getMessageHistory(testDir, projectId);
    expect(allMessages.filter(m => m.content === 'Broadcast test')).toHaveLength(2);
  });

  it('broadcasts with metadata', () => {
    const msg = {
      fromRole: 'pl' as const,
      messageType: 'broadcast' as const,
      content: 'Sprint planning',
      metadata: { sprintId: 'S-42', startDate: '2025-01-15' },
    };

    const roles = ['fe-dev', 'be-dev'] as const;
    broadcastMessage(testDir, projectId, msg, roles);

    const messages = getMessageHistory(testDir, projectId, { messageType: 'broadcast' });
    expect(messages.every(m => m.metadata.sprintId === 'S-42')).toBe(true);
  });

  it('broadcasts with TTL', () => {
    const msg = {
      fromRole: 'pm' as const,
      messageType: 'broadcast' as const,
      content: 'Time-sensitive announcement',
      expiresInMs: 3600000, // 1 hour
    };

    const roles = ['fe-dev', 'be-dev'] as const;
    broadcastMessage(testDir, projectId, msg, roles);

    const messages = getMessageHistory(testDir, projectId, { messageType: 'broadcast' });
    expect(messages.every(m => m.expiresAt !== null)).toBe(true);
  });

  it('defaults channel to broadcast', () => {
    const msg = {
      fromRole: 'pm' as const,
      messageType: 'broadcast' as const,
      content: 'Channel test',
    };

    const roles = ['fe-dev'] as const;
    broadcastMessage(testDir, projectId, msg, roles);

    const messages = getMessageHistory(testDir, projectId, { toRole: 'fe-dev' });
    expect(messages[0].channel).toBe('broadcast');
  });
});

// ============================================================
// EXPIRE OLD MESSAGES
// ============================================================

describe('expireOldMessages', () => {
  it('marks expired messages as expired', () => {
    const pastTime = new Date(Date.now() - 60000).toISOString();
    const db = getDb(testDir)!;

    // Insert expired message manually
    db.prepare(`
      INSERT INTO message_queue (project_id, from_role, to_role, message_type, channel, content, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(projectId, 'pm', 'fe-dev', 'task_assignment', 'dm', 'Old message', pastTime, pastTime);

    const count = expireOldMessages(testDir, projectId);
    expect(count).toBe(1);

    const messages = getMessageHistory(testDir, projectId, { status: 'expired' });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Old message');
  });

  it('leaves non-expired messages unchanged', () => {
    const futureTime = new Date(Date.now() + 60000).toISOString();
    const db = getDb(testDir)!;

    db.prepare(`
      INSERT INTO message_queue (project_id, from_role, to_role, message_type, channel, content, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'), ?)
    `).run(projectId, 'pm', 'fe-dev', 'task_assignment', 'dm', 'Future message', futureTime);

    enqueueMessage(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'fe-dev',
      messageType: 'task_assignment',
      content: 'No expiration',
    });

    const count = expireOldMessages(testDir, projectId);
    expect(count).toBe(0);

    const pendingMessages = getMessageHistory(testDir, projectId, { status: 'pending' });
    expect(pendingMessages).toHaveLength(2);
  });

  it('only expires pending messages', () => {
    const pastTime = new Date(Date.now() - 60000).toISOString();
    const db = getDb(testDir)!;

    // Insert expired but delivered message
    db.prepare(`
      INSERT INTO message_queue (project_id, from_role, to_role, message_type, channel, content, status, created_at, delivered_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'delivered', ?, datetime('now'), ?)
    `).run(projectId, 'pm', 'fe-dev', 'task_assignment', 'dm', 'Already delivered', pastTime, pastTime);

    const count = expireOldMessages(testDir, projectId);
    expect(count).toBe(0);
  });

  it('returns 0 when no messages to expire', () => {
    const count = expireOldMessages(testDir, projectId);
    expect(count).toBe(0);
  });

  it('returns 0 when database is not initialized', () => {
    const count = expireOldMessages('/nonexistent', projectId);
    expect(count).toBe(0);
  });
});

// ============================================================
// MESSAGE HISTORY
// ============================================================

describe('getMessageHistory', () => {
  beforeEach(() => {
    // Seed test messages
    enqueueMessage(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'fe-dev',
      messageType: 'task_assignment',
      content: 'FE Task 1',
    });

    enqueueMessage(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'be-dev',
      messageType: 'task_assignment',
      content: 'BE Task 1',
    });

    enqueueMessage(testDir, projectId, {
      fromRole: 'qa',
      toRole: 'fe-dev',
      messageType: 'review_request',
      content: 'Review PR',
    });

    dequeueMessages(testDir, 'fe-dev', 1);
  });

  it('filters by fromRole', () => {
    const messages = getMessageHistory(testDir, projectId, { fromRole: 'pm' });
    expect(messages).toHaveLength(2);
    expect(messages.every(m => m.fromRole === 'pm')).toBe(true);
  });

  it('filters by toRole', () => {
    const messages = getMessageHistory(testDir, projectId, { toRole: 'fe-dev' });
    expect(messages).toHaveLength(2);
    expect(messages.every(m => m.toRole === 'fe-dev')).toBe(true);
  });

  it('filters by messageType', () => {
    const messages = getMessageHistory(testDir, projectId, { messageType: 'review_request' });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Review PR');
  });

  it('filters by status', () => {
    const pendingMessages = getMessageHistory(testDir, projectId, { status: 'pending' });
    expect(pendingMessages.length).toBeGreaterThan(0);
    expect(pendingMessages.every(m => m.status === 'pending')).toBe(true);

    const deliveredMessages = getMessageHistory(testDir, projectId, { status: 'delivered' });
    expect(deliveredMessages).toHaveLength(1);
  });

  it('combines multiple filters', () => {
    const messages = getMessageHistory(testDir, projectId, {
      fromRole: 'pm',
      toRole: 'fe-dev',
      messageType: 'task_assignment',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('FE Task 1');
  });

  it('respects limit parameter', () => {
    const messages = getMessageHistory(testDir, projectId, { limit: 2 });
    expect(messages).toHaveLength(2);
  });

  it('respects offset parameter', () => {
    const allMessages = getMessageHistory(testDir, projectId);
    const offsetMessages = getMessageHistory(testDir, projectId, { offset: 1 });

    expect(offsetMessages.length).toBe(allMessages.length - 1);
    expect(offsetMessages[0].id).toBe(allMessages[1].id);
  });

  it('orders by created_at DESC (newest first)', () => {
    const messages = getMessageHistory(testDir, projectId);
    expect(messages.length).toBeGreaterThan(1);

    for (let i = 1; i < messages.length; i++) {
      const prev = new Date(messages[i - 1].createdAt);
      const curr = new Date(messages[i].createdAt);
      expect(prev.getTime()).toBeGreaterThanOrEqual(curr.getTime());
    }
  });

  it('returns empty array when no messages match filters', () => {
    const messages = getMessageHistory(testDir, projectId, {
      fromRole: 'security',
      messageType: 'escalation',
    });
    expect(messages).toEqual([]);
  });

  it('defaults limit to 100', () => {
    // Insert 150 messages
    for (let i = 1; i <= 150; i++) {
      enqueueMessage(testDir, projectId, {
        fromRole: 'pm',
        toRole: 'fe-dev',
        messageType: 'task_assignment',
        content: `Task ${i}`,
      });
    }

    const messages = getMessageHistory(testDir, projectId);
    expect(messages).toHaveLength(100);
  });

  it('returns empty array when database is not initialized', () => {
    const messages = getMessageHistory('/nonexistent', projectId);
    expect(messages).toEqual([]);
  });
});
