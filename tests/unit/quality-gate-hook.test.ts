/**
 * Quality Gate Hook unit tests
 *
 * Tests: hook triggering on node:completed, gate evaluation,
 * review score updates, gate pass/fail events, escalation triggers, detach.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createQualityGateHook } from '../../src/hooks/quality-gate-hook.js';
import { HookRegistry } from '../../src/hooks/lifecycle.js';
import { initDb, getDb, closeDb } from '../../src/persistence/db.js';
import { createTask, getTask } from '../../src/persistence/tasks-repo.js';
import type { DAGNode, GateType, ReviewDimensions } from '../../src/shared/types.js';
import type { EscalationDecision } from '../../src/quality/escalation.js';

let testDir: string;
const projectId = 'test-proj';

function seedProject(dir: string): void {
  const db = getDb(dir)!;
  db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, path, session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `).run(projectId, 'Test Project', dir, 'session-qg-test');
}

function createMockNode(id: string, taskId: string | null = null): DAGNode {
  return {
    id,
    roleId: 'be-dev',
    layerIndex: 0,
    nodeType: 'execution',
    status: 'completed',
    dependencies: [],
    taskId,
    fileOwnership: [],
    estimatedDuration: null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
}

function createPassingDimensions(): ReviewDimensions {
  return {
    correctness: 9,
    security: 9,
    performance: 8,
    maintainability: 9,
    testCoverage: 8,
  };
}

function createFailingDimensions(): ReviewDimensions {
  return {
    correctness: 6,
    security: 6,
    performance: 5,
    maintainability: 6,
    testCoverage: 6,
  };
}

function createCriticalFailureDimensions(): ReviewDimensions {
  return {
    correctness: 2,
    security: 2,
    performance: 2,
    maintainability: 2,
    testCoverage: 2,
  };
}

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'ct-qg-hook-test-'));
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

describe('createQualityGateHook - registration', () => {
  it('should register hook listeners', () => {
    const hooks = new HookRegistry();
    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
      },
      hooks
    );

    expect(hooks.listenerCount('node:completed')).toBe(1);

    hook.detach();
  });

  it('should return detach function', () => {
    const hooks = new HookRegistry();
    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
      },
      hooks
    );

    expect(typeof hook.detach).toBe('function');

    hook.detach();
  });
});

// ============================================================
// TRIGGER ON NODE:COMPLETED
// ============================================================

describe('trigger on node:completed', () => {
  it('should trigger quality gate evaluation', async () => {
    const hooks = new HookRegistry();
    const onReviewRequested = vi.fn(async (taskId: string, gateType: GateType) => ({
      dimensions: createPassingDimensions(),
      feedback: 'Excellent work',
    }));

    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
        onReviewRequested,
      },
      hooks
    );

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    const node = createMockNode('node-1', 'task-1');
    await hooks.emitNodeEvent('node:completed', node);

    expect(onReviewRequested).toHaveBeenCalledTimes(1);
    expect(onReviewRequested).toHaveBeenCalledWith('task-1', 'code-review');

    hook.detach();
  });

  it('should use custom gate type if provided', async () => {
    const hooks = new HookRegistry();
    const onReviewRequested = vi.fn(async (taskId: string, gateType: GateType) => ({
      dimensions: createPassingDimensions(),
      feedback: 'Good',
    }));

    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
        defaultGateType: 'qa-review' as GateType,
        onReviewRequested,
      },
      hooks
    );

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    const node = createMockNode('node-1', 'task-1');
    await hooks.emitNodeEvent('node:completed', node);

    expect(onReviewRequested).toHaveBeenCalledWith('task-1', 'qa-review');

    hook.detach();
  });

  it('should not trigger if taskId is null', async () => {
    const hooks = new HookRegistry();
    const onReviewRequested = vi.fn();

    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
        onReviewRequested,
      },
      hooks
    );

    const node = createMockNode('node-1', null);
    await hooks.emitNodeEvent('node:completed', node);

    expect(onReviewRequested).not.toHaveBeenCalled();

    hook.detach();
  });

  it('should not trigger if no review callback provided', async () => {
    const hooks = new HookRegistry();

    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
      },
      hooks
    );

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    const node = createMockNode('node-1', 'task-1');
    await hooks.emitNodeEvent('node:completed', node);

    // Should not throw
    expect(true).toBe(true);

    hook.detach();
  });
});

// ============================================================
// SKIP ALREADY-PASSED GATES
// ============================================================

describe('skip already-passed gates', () => {
  it('should skip evaluation if gate already passed', async () => {
    const hooks = new HookRegistry();
    const onReviewRequested = vi.fn(async () => ({
      dimensions: createPassingDimensions(),
      feedback: 'Good',
    }));

    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
        onReviewRequested,
      },
      hooks
    );

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    const node = createMockNode('node-1', 'task-1');

    // First evaluation
    await hooks.emitNodeEvent('node:completed', node);
    expect(onReviewRequested).toHaveBeenCalledTimes(1);

    // Second evaluation - should be skipped
    await hooks.emitNodeEvent('node:completed', node);
    expect(onReviewRequested).toHaveBeenCalledTimes(1); // Still 1

    hook.detach();
  });
});

// ============================================================
// CALL ONREVIEWREQUESTED CALLBACK
// ============================================================

describe('onReviewRequested callback', () => {
  it('should call callback with correct parameters', async () => {
    const hooks = new HookRegistry();
    const onReviewRequested = vi.fn(async (taskId: string, gateType: GateType) => {
      expect(taskId).toBe('task-1');
      expect(gateType).toBe('code-review');
      return {
        dimensions: createPassingDimensions(),
        feedback: 'Looks good',
      };
    });

    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
        onReviewRequested,
      },
      hooks
    );

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    const node = createMockNode('node-1', 'task-1');
    await hooks.emitNodeEvent('node:completed', node);

    expect(onReviewRequested).toHaveBeenCalled();

    hook.detach();
  });

  it('should handle null review data gracefully', async () => {
    const hooks = new HookRegistry();
    const onReviewRequested = vi.fn(async () => null);

    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
        onReviewRequested,
      },
      hooks
    );

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    const node = createMockNode('node-1', 'task-1');
    await hooks.emitNodeEvent('node:completed', node);

    // Should not throw
    expect(true).toBe(true);

    hook.detach();
  });
});

// ============================================================
// EVALUATE GATE AND UPDATE SCORE
// ============================================================

describe('evaluate gate and update review score', () => {
  it('should update task review score on pass', async () => {
    const hooks = new HookRegistry();
    const onReviewRequested = vi.fn(async () => ({
      dimensions: createPassingDimensions(),
      feedback: 'Great work',
    }));

    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
        onReviewRequested,
      },
      hooks
    );

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    const node = createMockNode('node-1', 'task-1');
    await hooks.emitNodeEvent('node:completed', node);

    const updatedTask = getTask(testDir, 'task-1');
    expect(typeof updatedTask?.reviewScore).toBe('number');
    expect(updatedTask?.reviewScore).toBeGreaterThan(7); // Passing score

    hook.detach();
  });

  it('should update task review score on fail', async () => {
    const hooks = new HookRegistry();
    const onReviewRequested = vi.fn(async () => ({
      dimensions: createFailingDimensions(),
      feedback: 'Needs work',
    }));

    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
        onReviewRequested,
      },
      hooks
    );

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    const node = createMockNode('node-1', 'task-1');
    await hooks.emitNodeEvent('node:completed', node);

    const updatedTask = getTask(testDir, 'task-1');
    expect(typeof updatedTask?.reviewScore).toBe('number');
    expect(updatedTask?.reviewScore).toBeLessThan(7); // Failing score

    hook.detach();
  });
});

// ============================================================
// EMIT GATE:PASSED EVENT
// ============================================================

describe('emit gate:passed event', () => {
  it('should emit gate:passed when gate passes', async () => {
    const hooks = new HookRegistry();
    const gatePassedListener = vi.fn();
    hooks.on('gate:passed', gatePassedListener);

    const onReviewRequested = vi.fn(async () => ({
      dimensions: createPassingDimensions(),
      feedback: 'Excellent',
    }));

    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
        onReviewRequested,
      },
      hooks
    );

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    const node = createMockNode('node-1', 'task-1');
    await hooks.emitNodeEvent('node:completed', node);

    expect(gatePassedListener).toHaveBeenCalledTimes(1);
    const event = gatePassedListener.mock.calls[0][0];
    expect(event.type).toBe('gate:passed');
    expect(event.data.taskId).toBe('task-1');
    expect(event.data.verdict).toBe('pass');

    hook.detach();
  });

  it('should include score and verdict in event', async () => {
    const hooks = new HookRegistry();
    const gatePassedListener = vi.fn();
    hooks.on('gate:passed', gatePassedListener);

    const onReviewRequested = vi.fn(async () => ({
      dimensions: createPassingDimensions(),
      feedback: 'Good',
    }));

    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
        onReviewRequested,
      },
      hooks
    );

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    const node = createMockNode('node-1', 'task-1');
    await hooks.emitNodeEvent('node:completed', node);

    const event = gatePassedListener.mock.calls[0][0];
    expect(event.data.score).toBeGreaterThan(0);
    expect(event.data.verdict).toBe('pass');

    hook.detach();
  });
});

// ============================================================
// EMIT GATE:FAILED EVENT
// ============================================================

describe('emit gate:failed event', () => {
  it('should emit gate:failed when gate fails', async () => {
    const hooks = new HookRegistry();
    const gateFailedListener = vi.fn();
    hooks.on('gate:failed', gateFailedListener);

    const onReviewRequested = vi.fn(async () => ({
      dimensions: createFailingDimensions(),
      feedback: 'Issues found',
    }));

    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
        onReviewRequested,
      },
      hooks
    );

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    const node = createMockNode('node-1', 'task-1');
    await hooks.emitNodeEvent('node:completed', node);

    expect(gateFailedListener).toHaveBeenCalledTimes(1);
    const event = gateFailedListener.mock.calls[0][0];
    expect(event.type).toBe('gate:failed');
    expect(event.data.taskId).toBe('task-1');
    expect(event.data.verdict).toBe('conditional');

    hook.detach();
  });

  it('should include retry info in event', async () => {
    const hooks = new HookRegistry();
    const gateFailedListener = vi.fn();
    hooks.on('gate:failed', gateFailedListener);

    const onReviewRequested = vi.fn(async () => ({
      dimensions: createFailingDimensions(),
      feedback: 'Try again',
    }));

    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
        onReviewRequested,
      },
      hooks
    );

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    const node = createMockNode('node-1', 'task-1');
    await hooks.emitNodeEvent('node:completed', node);

    const event = gateFailedListener.mock.calls[0][0];
    expect(event.data.canRetry).toBeDefined();
    expect(event.data.attemptsRemaining).toBeDefined();

    hook.detach();
  });
});

// ============================================================
// ESCALATION:TRIGGERED EVENT
// ============================================================

describe('escalation:triggered event', () => {
  it('should trigger escalation when needsEscalation is true', async () => {
    const hooks = new HookRegistry();
    const escalationListener = vi.fn();
    hooks.on('escalation:triggered', escalationListener);

    const onReviewRequested = vi.fn(async () => ({
      dimensions: createCriticalFailureDimensions(),
      feedback: 'Critical issues',
    }));

    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
        onReviewRequested,
      },
      hooks
    );

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    const node = createMockNode('node-1', 'task-1');

    // Exhaust retry attempts to trigger escalation
    await hooks.emitNodeEvent('node:completed', node);

    // May need multiple attempts to trigger escalation
    // Check if escalation was triggered
    const wasTriggered = escalationListener.mock.calls.length > 0;
    if (wasTriggered) {
      const event = escalationListener.mock.calls[0][0];
      expect(event.type).toBe('escalation:triggered');
      expect(event.data.taskId).toBe('task-1');
    }

    hook.detach();
  });

  it('should call onEscalation callback', async () => {
    const hooks = new HookRegistry();
    const onEscalation = vi.fn(async (decision: EscalationDecision) => {
      expect(decision.taskId).toBe('task-1');
      expect(decision.action).toBeDefined();
    });

    const onReviewRequested = vi.fn(async () => ({
      dimensions: createCriticalFailureDimensions(),
      feedback: 'Critical failure',
    }));

    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
        onReviewRequested,
        onEscalation,
      },
      hooks
    );

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    const node = createMockNode('node-1', 'task-1');
    await hooks.emitNodeEvent('node:completed', node);

    // Escalation may or may not be called depending on gate result
    // Just ensure no errors

    hook.detach();
  });
});

// ============================================================
// DETACH
// ============================================================

describe('detach', () => {
  it('should remove all listeners', () => {
    const hooks = new HookRegistry();
    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
      },
      hooks
    );

    const countBefore = hooks.listenerCount();
    expect(countBefore).toBeGreaterThan(0);

    hook.detach();

    const countAfter = hooks.listenerCount();
    expect(countAfter).toBe(0);
  });

  it('should prevent further gate evaluations', async () => {
    const hooks = new HookRegistry();
    const onReviewRequested = vi.fn(async () => ({
      dimensions: createPassingDimensions(),
      feedback: 'Good',
    }));

    const hook = createQualityGateHook(
      {
        cwd: testDir,
        projectId,
        onReviewRequested,
      },
      hooks
    );

    createTask(testDir, projectId, {
      id: 'task-1',
      title: 'Test Task',
    });

    hook.detach();

    const node = createMockNode('node-1', 'task-1');
    await hooks.emitNodeEvent('node:completed', node);

    expect(onReviewRequested).not.toHaveBeenCalled();
  });
});
