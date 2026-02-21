/**
 * MessageBus Back-pressure & Queue Integration Tests
 *
 * Tests the in-memory MessageBus with real SQLite persistence.
 * All subsystems (message bus, protocol validation, communication repo) are real.
 *
 * Scenarios:
 *   1. High-speed producer: 100 synchronous sends all reach the handler
 *   2. Subscribe/unsubscribe cycle: handler stops receiving after unsubscribe
 *   3. Multi-subscriber: all 3 handlers on the same role are called
 *   4. Message type filtering: only subscribed-type messages are routed
 *   5. Error isolation: a throwing handler does not block other handlers
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initDb, getDb, closeDb } from '../../src/persistence/db.js';
import { MessageBus } from '../../src/communication/message-bus.js';
import { createMessage } from '../../src/communication/protocol.js';
import type { RoleType, TeamMessage } from '../../src/shared/types.js';

// ============================================================
// TEST FIXTURES
// ============================================================

let testDir: string;
const projectId = 'bus-test-proj';

function seedProject(dir: string): void {
  const db = getDb(dir)!;
  db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, path, session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `).run(projectId, 'Bus Test Project', dir, 'session-bus-test');
}

/**
 * Build a valid task_assignment TeamMessage from pm → fe-dev.
 * task_assignment is one of the few types that pm can send.
 */
function makeTaskAssignment(taskId: string): TeamMessage {
  return createMessage(
    'task_assignment',
    'pm' as RoleType,
    'fe-dev' as RoleType,
    {
      taskId,
      subject: `Task ${taskId}`,
      description: 'Integration test task',
      fileOwnership: [],
      priority: 3,
    },
    'dm'
  );
}

/**
 * Build a valid status_report message from fe-dev → pl.
 */
function makeStatusReport(taskId: string): TeamMessage {
  return createMessage(
    'status_report',
    'fe-dev' as RoleType,
    'pl' as RoleType,
    {
      taskId,
      status: 'in-progress',
      progress: 50,
      summary: 'Half way done',
    },
    'dm'
  );
}

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'ct-bus-bp-test-'));
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
// SCENARIO 1: High-speed producer
// ============================================================

describe('MessageBus back-pressure - Scenario 1: high-speed producer', () => {
  it('delivers all 100 messages to the registered handler', async () => {
    const bus = new MessageBus(testDir, projectId);
    const received: string[] = [];

    bus.subscribe('fe-dev', (msg: TeamMessage) => {
      const payload = JSON.parse(msg.content) as { taskId: string };
      received.push(payload.taskId);
    });

    const sends: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      sends.push(
        bus.route(makeTaskAssignment(`task-hp-${i}`)).then(() => undefined)
      );
    }
    await Promise.all(sends);

    expect(received).toHaveLength(100);
    // All task IDs should be present (order may vary with concurrent sends)
    for (let i = 0; i < 100; i++) {
      expect(received).toContain(`task-hp-${i}`);
    }
  });

  it('returns delivered:true and lists the recipient for each routed message', async () => {
    const bus = new MessageBus(testDir, projectId);
    bus.subscribe('fe-dev', () => { /* no-op */ });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        bus.route(makeTaskAssignment(`task-rt-${i}`))
      )
    );

    for (const result of results) {
      expect(result.delivered).toBe(true);
      expect(result.recipients).toContain('fe-dev');
    }
  });
});

// ============================================================
// SCENARIO 2: Subscribe / unsubscribe cycle
// ============================================================

describe('MessageBus back-pressure - Scenario 2: subscribe/unsubscribe cycle', () => {
  it('delivers messages only while subscribed', async () => {
    const bus = new MessageBus(testDir, projectId);
    const received: string[] = [];

    bus.subscribe('fe-dev', (msg: TeamMessage) => {
      const payload = JSON.parse(msg.content) as { taskId: string };
      received.push(payload.taskId);
    });

    // Message received while subscribed
    await bus.route(makeTaskAssignment('task-before-unsub'));
    expect(received).toContain('task-before-unsub');

    bus.unsubscribe('fe-dev');

    // Message NOT received after unsubscribe
    const result = await bus.route(makeTaskAssignment('task-after-unsub'));
    expect(result.delivered).toBe(false);
    expect(received).not.toContain('task-after-unsub');
  });

  it('re-subscribing after unsubscribe resumes delivery', async () => {
    const bus = new MessageBus(testDir, projectId);
    const received: string[] = [];

    bus.subscribe('fe-dev', (msg: TeamMessage) => {
      const payload = JSON.parse(msg.content) as { taskId: string };
      received.push(payload.taskId);
    });

    await bus.route(makeTaskAssignment('task-first'));
    bus.unsubscribe('fe-dev');
    await bus.route(makeTaskAssignment('task-gap'));

    // Re-subscribe
    bus.subscribe('fe-dev', (msg: TeamMessage) => {
      const payload = JSON.parse(msg.content) as { taskId: string };
      received.push(payload.taskId);
    });
    await bus.route(makeTaskAssignment('task-after-resub'));

    expect(received).toContain('task-first');
    expect(received).not.toContain('task-gap');
    expect(received).toContain('task-after-resub');
  });
});

// ============================================================
// SCENARIO 3: Multi-subscriber
// ============================================================

describe('MessageBus back-pressure - Scenario 3: multi-subscriber', () => {
  it('calls all three handlers registered for the same role', async () => {
    const bus = new MessageBus(testDir, projectId);
    const log: string[] = [];

    bus.subscribe('fe-dev', () => { log.push('handler-A'); });
    bus.subscribe('fe-dev', () => { log.push('handler-B'); });
    bus.subscribe('fe-dev', () => { log.push('handler-C'); });

    const result = await bus.route(makeTaskAssignment('task-multi'));

    expect(log).toEqual(['handler-A', 'handler-B', 'handler-C']);
    expect(result.delivered).toBe(true);
    // All three invocations report the same role
    expect(result.recipients).toHaveLength(3);
    expect(result.recipients.every(r => r === 'fe-dev')).toBe(true);
  });

  it('counts handlers correctly via isRoleActive and getRegisteredRoles', () => {
    const bus = new MessageBus(testDir, projectId);

    expect(bus.isRoleActive('fe-dev')).toBe(false);
    bus.subscribe('fe-dev', () => { /* no-op */ });
    expect(bus.isRoleActive('fe-dev')).toBe(true);

    bus.subscribe('pl', () => { /* no-op */ });
    const roles = bus.getRegisteredRoles();
    expect(roles).toContain('fe-dev');
    expect(roles).toContain('pl');
    expect(roles).toHaveLength(2);
  });
});

// ============================================================
// SCENARIO 4: Message type filtering
// ============================================================

describe('MessageBus back-pressure - Scenario 4: message type filtering', () => {
  it('routes task_assignment only to the target role handler, not to others', async () => {
    const bus = new MessageBus(testDir, projectId);
    const feDevReceived: string[] = [];
    const plReceived: string[] = [];

    bus.subscribe('fe-dev', (msg: TeamMessage) => {
      const payload = JSON.parse(msg.content) as { taskId: string };
      feDevReceived.push(payload.taskId);
    });
    bus.subscribe('pl', (msg: TeamMessage) => {
      const payload = JSON.parse(msg.content) as { taskId: string };
      plReceived.push(payload.taskId);
    });

    // task_assignment goes DM to fe-dev only
    await bus.route(makeTaskAssignment('task-filter-1'));

    expect(feDevReceived).toContain('task-filter-1');
    expect(plReceived).not.toContain('task-filter-1');
  });

  it('routes status_report DM to pl, not fe-dev', async () => {
    const bus = new MessageBus(testDir, projectId);
    const feDevReceived: string[] = [];
    const plReceived: string[] = [];

    bus.subscribe('fe-dev', (msg: TeamMessage) => {
      const payload = JSON.parse(msg.content) as { taskId: string };
      feDevReceived.push(payload.taskId);
    });
    bus.subscribe('pl', (msg: TeamMessage) => {
      const payload = JSON.parse(msg.content) as { taskId: string };
      plReceived.push(payload.taskId);
    });

    // status_report fe-dev → pl (DM)
    await bus.route(makeStatusReport('task-sr-1'));

    expect(plReceived).toContain('task-sr-1');
    expect(feDevReceived).not.toContain('task-sr-1');
  });

  it('rejects a message when the sender lacks send permission', async () => {
    const bus = new MessageBus(testDir, projectId);
    bus.subscribe('pl', () => { /* no-op */ });

    // fe-dev cannot send task_assignment (only pm/pl can)
    const badMsg: TeamMessage = {
      ...makeTaskAssignment('task-bad'),
      fromRole: 'fe-dev' as RoleType,
    };

    const result = await bus.route(badMsg);

    expect(result.delivered).toBe(false);
    expect(result.errors.some(e => e.includes('cannot send'))).toBe(true);
  });
});

// ============================================================
// SCENARIO 5: Error isolation
// ============================================================

describe('MessageBus back-pressure - Scenario 5: error isolation', () => {
  it('continues calling subsequent handlers when one throws', async () => {
    const bus = new MessageBus(testDir, projectId);
    const log: string[] = [];

    bus.subscribe('fe-dev', () => {
      throw new Error('Handler A exploded');
    });
    bus.subscribe('fe-dev', () => {
      log.push('handler-B ran');
    });
    bus.subscribe('fe-dev', () => {
      log.push('handler-C ran');
    });

    const result = await bus.route(makeTaskAssignment('task-err-isolation'));

    // handler-B and handler-C still ran despite handler-A throwing
    expect(log).toContain('handler-B ran');
    expect(log).toContain('handler-C ran');
    // The error is captured in the result, not re-thrown
    expect(result.errors.some(e => e.includes('Handler A exploded'))).toBe(true);
    // Two of three handlers succeeded
    expect(result.recipients).toHaveLength(2);
  });

  it('reports delivered:false when all handlers throw', async () => {
    const bus = new MessageBus(testDir, projectId);

    bus.subscribe('fe-dev', () => { throw new Error('boom-A'); });
    bus.subscribe('fe-dev', () => { throw new Error('boom-B'); });

    const result = await bus.route(makeTaskAssignment('task-all-fail'));

    expect(result.delivered).toBe(false);
    expect(result.recipients).toHaveLength(0);
    expect(result.errors).toHaveLength(2);
  });
});
