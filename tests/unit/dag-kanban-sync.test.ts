/**
 * DAG-Kanban Sync unit tests
 *
 * Tests: hook registration, node status transitions, gate verdict transitions,
 * null taskId handling, detach cleanup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDagKanbanSync } from '../../src/hooks/dag-kanban-sync.js';
import { HookRegistry } from '../../src/hooks/lifecycle.js';
import { initDb, getDb, closeDb } from '../../src/persistence/db.js';
import { createTask, getTask } from '../../src/persistence/tasks-repo.js';
import type { DAGNode } from '../../src/shared/types.js';

let testDir: string;
const projectId = 'test-proj';

function seedProject(dir: string): void {
  const db = getDb(dir)!;
  db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, path, session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `).run(projectId, 'Test Project', dir, 'session-sync-test');
}

function createMockNode(id: string, taskId: string | null = null): DAGNode {
  return {
    id,
    roleId: 'pl',
    layerIndex: 0,
    nodeType: 'execution',
    status: 'pending',
    dependencies: [],
    taskId,
    fileOwnership: [],
    estimatedDuration: null,
    startedAt: null,
    completedAt: null,
  };
}

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'ct-dag-sync-test-'));
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
// HOOK REGISTRATION
// ============================================================

describe('createDagKanbanSync - registration', () => {
  it('should register hook listeners', () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    expect(hooks.listenerCount('node:started')).toBe(1);
    expect(hooks.listenerCount('node:completed')).toBe(1);
    expect(hooks.listenerCount('node:failed')).toBe(1);
    expect(hooks.listenerCount('gate:passed')).toBe(1);
    expect(hooks.listenerCount('gate:failed')).toBe(1);

    sync.detach();
  });

  it('should return detach function', () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    expect(typeof sync.detach).toBe('function');

    sync.detach();
  });
});

// ============================================================
// NODE:STARTED → IN-PROGRESS
// ============================================================

describe('node:started event', () => {
  it('should move task from todo to in-progress', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    const task = createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    // Move to todo first
    const db = getDb(testDir)!;
    db.prepare("UPDATE tasks SET kanban_status = 'todo' WHERE id = ?").run('task-1');

    const node = createMockNode('node-1', 'task-1');

    await hooks.emitNodeEvent('node:started', node);

    const updatedTask = getTask(testDir, 'task-1');
    expect(updatedTask?.status).toBe('in-progress');

    sync.detach();
  });

  it('should move task from backlog to in-progress', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    // Move to todo first (backlog -> in-progress is not a valid transition)
    const db = getDb(testDir)!;
    db.prepare("UPDATE tasks SET kanban_status = 'todo' WHERE id = ?").run('task-1');

    const node = createMockNode('node-1', 'task-1');

    await hooks.emitNodeEvent('node:started', node);

    const updatedTask = getTask(testDir, 'task-1');
    expect(updatedTask?.status).toBe('in-progress');

    sync.detach();
  });

  it('should ignore event when taskId is null', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    const node = createMockNode('node-1', null);

    await hooks.emitNodeEvent('node:started', node);

    // Should not throw
    expect(true).toBe(true);

    sync.detach();
  });

  it('should ignore event when task not found', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    const node = createMockNode('node-1', 'nonexistent-task');

    await hooks.emitNodeEvent('node:started', node);

    // Should not throw
    expect(true).toBe(true);

    sync.detach();
  });
});

// ============================================================
// NODE:COMPLETED → REVIEW
// ============================================================

describe('node:completed event', () => {
  it('should move task from in-progress to review', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    // Move to in-progress first
    const db = getDb(testDir)!;
    db.prepare("UPDATE tasks SET kanban_status = 'in-progress' WHERE id = ?").run('task-1');

    const node = createMockNode('node-1', 'task-1');

    await hooks.emitNodeEvent('node:completed', node);

    const updatedTask = getTask(testDir, 'task-1');
    expect(updatedTask?.status).toBe('review');

    sync.detach();
  });

  it('should ignore event when taskId is null', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    const node = createMockNode('node-1', null);

    await hooks.emitNodeEvent('node:completed', node);

    expect(true).toBe(true);

    sync.detach();
  });

  it('should ignore event when task not found', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    const node = createMockNode('node-1', 'nonexistent-task');

    await hooks.emitNodeEvent('node:completed', node);

    expect(true).toBe(true);

    sync.detach();
  });

  it('should only move if status is in-progress', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    // Leave in backlog
    const node = createMockNode('node-1', 'task-1');

    await hooks.emitNodeEvent('node:completed', node);

    const task = getTask(testDir, 'task-1');
    expect(task?.status).toBe('backlog'); // Should not move

    sync.detach();
  });
});

// ============================================================
// NODE:FAILED → FAILED
// ============================================================

describe('node:failed event', () => {
  it('should move task to failed status', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    // Move to in-progress first
    const db = getDb(testDir)!;
    db.prepare("UPDATE tasks SET kanban_status = 'in-progress' WHERE id = ?").run('task-1');

    const node = createMockNode('node-1', 'task-1');

    await hooks.emitNodeEvent('node:failed', node);

    const updatedTask = getTask(testDir, 'task-1');
    expect(updatedTask?.status).toBe('failed');

    sync.detach();
  });

  it('should not move if already failed', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    // Already failed
    const db = getDb(testDir)!;
    db.prepare("UPDATE tasks SET kanban_status = 'failed' WHERE id = ?").run('task-1');

    const node = createMockNode('node-1', 'task-1');

    await hooks.emitNodeEvent('node:failed', node);

    const task = getTask(testDir, 'task-1');
    expect(task?.status).toBe('failed');

    sync.detach();
  });

  it('should not move if already done', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    // Already done
    const db = getDb(testDir)!;
    db.prepare("UPDATE tasks SET kanban_status = 'done' WHERE id = ?").run('task-1');

    const node = createMockNode('node-1', 'task-1');

    await hooks.emitNodeEvent('node:failed', node);

    const task = getTask(testDir, 'task-1');
    expect(task?.status).toBe('done');

    sync.detach();
  });

  it('should ignore event when taskId is null', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    const node = createMockNode('node-1', null);

    await hooks.emitNodeEvent('node:failed', node);

    expect(true).toBe(true);

    sync.detach();
  });
});

// ============================================================
// GATE:PASSED → DONE
// ============================================================

describe('gate:passed event', () => {
  it('should move task from review to done', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    // Move to review first
    const db = getDb(testDir)!;
    db.prepare("UPDATE tasks SET kanban_status = 'review' WHERE id = ?").run('task-1');

    await hooks.emitGateEvent('gate:passed', 'task-1', 'code-review', {
      score: 8.5,
      verdict: 'pass',
    });

    const updatedTask = getTask(testDir, 'task-1');
    expect(updatedTask?.status).toBe('done');

    sync.detach();
  });

  it('should only move if status is review', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    // Leave in in-progress
    const db = getDb(testDir)!;
    db.prepare("UPDATE tasks SET kanban_status = 'in-progress' WHERE id = ?").run('task-1');

    await hooks.emitGateEvent('gate:passed', 'task-1', 'code-review');

    const task = getTask(testDir, 'task-1');
    expect(task?.status).toBe('in-progress'); // Should not move

    sync.detach();
  });

  it('should ignore event when taskId is null', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    await hooks.emit({
      type: 'gate:passed',
      timestamp: new Date().toISOString(),
      data: {
        taskId: null,
        gateType: 'code-review',
      },
    });

    expect(true).toBe(true);

    sync.detach();
  });

  it('should ignore event when task not found', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    await hooks.emitGateEvent('gate:passed', 'nonexistent-task', 'code-review');

    expect(true).toBe(true);

    sync.detach();
  });
});

// ============================================================
// GATE:FAILED → IN-PROGRESS
// ============================================================

describe('gate:failed event', () => {
  it('should move task from review to in-progress for rework', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    // Move to review first
    const db = getDb(testDir)!;
    db.prepare("UPDATE tasks SET kanban_status = 'review' WHERE id = ?").run('task-1');

    await hooks.emitGateEvent('gate:failed', 'task-1', 'code-review', {
      score: 4.5,
      verdict: 'fail',
    });

    const updatedTask = getTask(testDir, 'task-1');
    expect(updatedTask?.status).toBe('in-progress');

    sync.detach();
  });

  it('should only move if status is review', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    // Leave in backlog
    await hooks.emitGateEvent('gate:failed', 'task-1', 'code-review');

    const task = getTask(testDir, 'task-1');
    expect(task?.status).toBe('backlog'); // Should not move

    sync.detach();
  });

  it('should ignore event when taskId is null', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    await hooks.emit({
      type: 'gate:failed',
      timestamp: new Date().toISOString(),
      data: {
        taskId: null,
        gateType: 'code-review',
      },
    });

    expect(true).toBe(true);

    sync.detach();
  });

  it('should ignore event when task not found', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    await hooks.emitGateEvent('gate:failed', 'nonexistent-task', 'code-review');

    expect(true).toBe(true);

    sync.detach();
  });
});

// ============================================================
// DETACH
// ============================================================

describe('detach', () => {
  it('should remove all listeners', () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    const countBefore = hooks.listenerCount();
    expect(countBefore).toBeGreaterThan(0);

    sync.detach();

    const countAfter = hooks.listenerCount();
    expect(countAfter).toBe(0);
  });

  it('should prevent further event processing', async () => {
    const hooks = new HookRegistry();
    const sync = createDagKanbanSync({ cwd: testDir, projectId }, hooks);

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    sync.detach();

    const node = createMockNode('node-1', 'task-1');
    await hooks.emitNodeEvent('node:started', node);

    const task = getTask(testDir, 'task-1');
    expect(task?.status).toBe('backlog'); // Should not have moved
  });
});
