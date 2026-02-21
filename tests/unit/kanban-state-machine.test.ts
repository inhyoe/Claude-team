/**
 * Kanban State Machine unit tests
 *
 * Tests: valid/invalid transitions, quality gate requirements,
 * role authorization, next states.
 */
import { describe, it, expect } from 'vitest';
import {
  isValidTransition,
  validateTransition,
  getValidNextStates,
  requiredGateVerdict,
} from '../../src/kanban/state-machine.js';
import type { KanbanStatus } from '../../src/shared/types.js';
import type { TransitionRequest } from '../../src/kanban/state-machine.js';

// ============================================================
// VALID TRANSITIONS
// ============================================================

describe('isValidTransition', () => {
  const validCases: [KanbanStatus, KanbanStatus][] = [
    ['backlog', 'todo'],
    ['backlog', 'blocked'],
    ['todo', 'in-progress'],
    ['todo', 'blocked'],
    ['todo', 'backlog'],
    ['in-progress', 'review'],
    ['in-progress', 'blocked'],
    ['in-progress', 'failed'],
    ['review', 'done'],
    ['review', 'in-progress'],
    ['review', 'failed'],
    ['blocked', 'todo'],
    ['blocked', 'in-progress'],
    ['blocked', 'backlog'],
    ['blocked', 'failed'],
    ['failed', 'backlog'],
    ['failed', 'todo'],
  ];

  it.each(validCases)('should allow %s → %s', (from, to) => {
    expect(isValidTransition(from, to)).toBe(true);
  });

  const invalidCases: [KanbanStatus, KanbanStatus][] = [
    ['done', 'backlog'],     // done is terminal
    ['done', 'todo'],
    ['done', 'in-progress'],
    ['backlog', 'done'],     // can't skip steps
    ['backlog', 'review'],
    ['todo', 'done'],
    ['todo', 'review'],
    ['in-progress', 'done'], // must go through review
    ['in-progress', 'backlog'],
    ['failed', 'done'],
    ['failed', 'review'],
  ];

  it.each(invalidCases)('should reject %s → %s', (from, to) => {
    expect(isValidTransition(from, to)).toBe(false);
  });
});

// ============================================================
// VALIDATE TRANSITION (with gate & role checks)
// ============================================================

describe('validateTransition', () => {
  it('should allow PM to make any valid transition', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'todo',
      toStatus: 'in-progress',
      movedBy: 'pm',
      reason: 'Starting work',
    });
    expect(result.allowed).toBe(true);
    expect(result.transition).toBeDefined();
    expect(result.transition!.itemId).toBe('task-1');
  });

  it('should allow PL to make any valid transition', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'in-progress',
      toStatus: 'review',
      movedBy: 'pl',
      reason: 'Ready for review',
    });
    expect(result.allowed).toBe(true);
  });

  it('should require quality gate pass for review → done', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'review',
      toStatus: 'done',
      movedBy: 'qa-engineer',
      reason: 'Approved',
    });
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('Quality gate must pass');
  });

  it('should allow review → done with gate pass verdict', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'review',
      toStatus: 'done',
      movedBy: 'qa-engineer',
      reason: 'All checks passed',
      gateVerdict: 'pass',
    });
    expect(result.allowed).toBe(true);
  });

  it('should reject review → done with non-pass verdict', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'review',
      toStatus: 'done',
      movedBy: 'qa-engineer',
      reason: 'Conditional',
      gateVerdict: 'conditional',
    });
    expect(result.allowed).toBe(false);
  });

  it('should reject invalid transitions', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'backlog',
      toStatus: 'done',
      movedBy: 'pm',
      reason: 'Skip',
    });
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('Invalid transition');
  });

  it('should allow workers to move todo → in-progress', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'todo',
      toStatus: 'in-progress',
      movedBy: 'fe-dev',
      reason: 'Starting',
    });
    expect(result.allowed).toBe(true);
  });

  it('should allow workers to move to blocked', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'in-progress',
      toStatus: 'blocked',
      movedBy: 'be-dev',
      reason: 'Waiting for API spec',
    });
    expect(result.allowed).toBe(true);
  });

  it('should allow workers to request review', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'in-progress',
      toStatus: 'review',
      movedBy: 'fe-dev',
      reason: 'Ready for review',
    });
    expect(result.allowed).toBe(true);
  });

  it('should reject non-judges approving review → done', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'review',
      toStatus: 'done',
      movedBy: 'fe-dev',
      reason: 'Looks good to me',
      gateVerdict: 'pass',
    });
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('Only judges');
  });

  it('should allow QA to reject review back to in-progress', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'review',
      toStatus: 'in-progress',
      movedBy: 'qa-engineer',
      reason: 'Tests failing',
    });
    expect(result.allowed).toBe(true);
  });

  it('should reject non-reviewers rejecting reviews', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'review',
      toStatus: 'in-progress',
      movedBy: 'fe-dev',
      reason: 'I disagree',
    });
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('Only reviewers');
  });

  it('should include timestamp in transition result', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'todo',
      toStatus: 'in-progress',
      movedBy: 'pm',
      reason: 'Go',
    });
    expect(result.transition!.timestamp).toBeDefined();
  });
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

describe('getValidNextStates', () => {
  it('should return correct next states for backlog', () => {
    const states = getValidNextStates('backlog');
    expect(states).toContain('todo');
    expect(states).toContain('blocked');
    expect(states).toContain('cancelled');
  });

  it('should return empty array for done (terminal)', () => {
    expect(getValidNextStates('done')).toEqual([]);
  });

  it('should return empty array for cancelled (terminal)', () => {
    expect(getValidNextStates('cancelled')).toEqual([]);
  });

  it('should return multiple options for blocked', () => {
    const states = getValidNextStates('blocked');
    expect(states).toContain('todo');
    expect(states).toContain('in-progress');
    expect(states).toContain('backlog');
    expect(states).toContain('failed');
    expect(states).toContain('cancelled');
  });
});

describe('requiredGateVerdict', () => {
  it('should require pass for done status', () => {
    expect(requiredGateVerdict('done')).toBe('pass');
  });

  it('should require nothing for other statuses', () => {
    expect(requiredGateVerdict('in-progress')).toBeNull();
    expect(requiredGateVerdict('review')).toBeNull();
    expect(requiredGateVerdict('blocked')).toBeNull();
  });
});

// ============================================================
// SAME-STATUS TRANSITION PREVENTION
// ============================================================

describe('same-status transition prevention', () => {
  const statuses: KanbanStatus[] = ['backlog', 'todo', 'in-progress', 'review', 'done', 'blocked', 'failed', 'cancelled'];

  it.each(statuses.map(s => [s] as [KanbanStatus]))('should reject %s → %s (same status)', (status) => {
    expect(isValidTransition(status, status)).toBe(false);
  });

  it('should return same-status error message in validateTransition', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'todo',
      toStatus: 'todo',
      movedBy: 'pm',
      reason: 'No-op',
    });
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('Same-status transition not allowed');
  });
});

// ============================================================
// CANCELLED STATUS TRANSITIONS
// ============================================================

describe('cancelled status transitions', () => {
  it('should allow PM to cancel a backlog task', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'backlog',
      toStatus: 'cancelled',
      movedBy: 'pm',
      reason: 'Scope cut',
    });
    expect(result.allowed).toBe(true);
  });

  it('should allow PL to cancel an in-progress task', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'in-progress',
      toStatus: 'cancelled',
      movedBy: 'pl',
      reason: 'Requirements changed',
    });
    expect(result.allowed).toBe(true);
  });

  it('should reject workers cancelling tasks', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'todo',
      toStatus: 'cancelled',
      movedBy: 'be-dev',
      reason: 'I give up',
    });
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('Only PM or PL can cancel');
  });

  it('should reject transitions out of cancelled (terminal)', () => {
    expect(isValidTransition('cancelled', 'backlog')).toBe(false);
    expect(isValidTransition('cancelled', 'todo')).toBe(false);
    expect(isValidTransition('cancelled', 'done')).toBe(false);
  });

  it('should allow PM to cancel a failed task', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'failed',
      toStatus: 'cancelled',
      movedBy: 'pm',
      reason: 'Not worth retrying',
    });
    expect(result.allowed).toBe(true);
  });
});

// ============================================================
// WIP LIMIT ENFORCEMENT
// ============================================================

describe('WIP limit enforcement', () => {
  it('should allow transition when WIP count is below limit', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'todo',
      toStatus: 'in-progress',
      movedBy: 'be-dev',
      reason: 'Starting',
      currentWipCount: 2,
      wipLimit: 3,
    });
    expect(result.allowed).toBe(true);
  });

  it('should reject transition when WIP limit is reached', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'todo',
      toStatus: 'in-progress',
      movedBy: 'be-dev',
      reason: 'Starting',
      currentWipCount: 3,
      wipLimit: 3,
    });
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('WIP limit reached');
  });

  it('should reject when WIP count exceeds limit', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'todo',
      toStatus: 'in-progress',
      movedBy: 'pm',
      reason: 'Force start',
      currentWipCount: 5,
      wipLimit: 3,
    });
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('WIP limit reached: 5/3');
  });

  it('should allow unlimited WIP when wipLimit is 0', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'todo',
      toStatus: 'in-progress',
      movedBy: 'be-dev',
      reason: 'Starting',
      currentWipCount: 99,
      wipLimit: 0,
    });
    expect(result.allowed).toBe(true);
  });

  it('should use DEFAULT_WIP_LIMIT when no limit specified', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'todo',
      toStatus: 'in-progress',
      movedBy: 'be-dev',
      reason: 'Starting',
      currentWipCount: 3,
      // no wipLimit - uses DEFAULT_WIP_LIMIT (3)
    });
    expect(result.allowed).toBe(false);
    expect(result.error).toContain('WIP limit reached');
  });

  it('should not apply WIP limit to non-in-progress transitions', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'in-progress',
      toStatus: 'review',
      movedBy: 'be-dev',
      reason: 'Done',
      currentWipCount: 99,
      wipLimit: 1,
    });
    expect(result.allowed).toBe(true);
  });
});

// ============================================================
// WORKER UNBLOCK AUTHORIZATION
// ============================================================

describe('worker unblock authorization', () => {
  it('should allow worker to unblock themselves to todo', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'blocked',
      toStatus: 'todo',
      movedBy: 'fe-dev',
      reason: 'Dependency resolved',
    });
    expect(result.allowed).toBe(true);
  });

  it('should allow worker to unblock themselves to in-progress', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'blocked',
      toStatus: 'in-progress',
      movedBy: 'be-dev',
      reason: 'API spec arrived',
      currentWipCount: 0,
      wipLimit: 3,
    });
    expect(result.allowed).toBe(true);
  });

  it('should allow worker to unblock back to backlog', () => {
    const result = validateTransition({
      taskId: 'task-1',
      fromStatus: 'blocked',
      toStatus: 'backlog',
      movedBy: 'dba',
      reason: 'Needs re-scoping',
    });
    expect(result.allowed).toBe(true);
  });
});
