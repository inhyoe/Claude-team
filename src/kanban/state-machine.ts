/**
 * Claude Team - Kanban State Machine
 *
 * Validates state transitions and enforces quality gate compliance.
 * State flow: Backlog → Todo → In-Progress → Review → Done
 * With: Blocked (any non-terminal), Failed (retriable)
 */

import type { KanbanStatus, KanbanTransition, RoleType, GateVerdict } from '../shared/types.js';
import { VALID_KANBAN_TRANSITIONS } from '../shared/constants.js';

export interface TransitionRequest {
  taskId: string;
  fromStatus: KanbanStatus;
  toStatus: KanbanStatus;
  movedBy: RoleType;
  reason: string;
  gateVerdict?: GateVerdict;
  /** Current WIP count for in-progress column (used for WIP limit enforcement). */
  currentWipCount?: number;
  /** Maximum allowed in-progress tasks. Defaults to DEFAULT_WIP_LIMIT. 0 = unlimited. */
  wipLimit?: number;
}

/** Default WIP limit for in-progress column. */
export const DEFAULT_WIP_LIMIT = 3;

export interface TransitionResult {
  allowed: boolean;
  transition?: KanbanTransition;
  error?: string;
}

/**
 * Check if a transition is valid according to the state machine.
 */
export function isValidTransition(from: KanbanStatus, to: KanbanStatus): boolean {
  const allowed = VALID_KANBAN_TRANSITIONS[from];
  return allowed?.includes(to) ?? false;
}

/**
 * Validate and create a transition.
 */
export function validateTransition(request: TransitionRequest): TransitionResult {
  // Prevent same-status transitions (e.g. todo → todo)
  if (request.fromStatus === request.toStatus) {
    return {
      allowed: false,
      error: `Same-status transition not allowed: ${request.fromStatus} → ${request.toStatus}`,
    };
  }

  // Check basic validity
  if (!isValidTransition(request.fromStatus, request.toStatus)) {
    return {
      allowed: false,
      error: `Invalid transition: ${request.fromStatus} → ${request.toStatus}`,
    };
  }

  // Check WIP limit when moving to in-progress
  if (request.toStatus === 'in-progress') {
    const limit = request.wipLimit ?? DEFAULT_WIP_LIMIT;
    if (limit > 0 && request.currentWipCount !== undefined && request.currentWipCount >= limit) {
      return {
        allowed: false,
        error: `WIP limit reached: ${request.currentWipCount}/${limit} tasks already in-progress`,
      };
    }
  }

  // Check quality gate requirements for review → done
  if (request.fromStatus === 'review' && request.toStatus === 'done') {
    if (!request.gateVerdict || request.gateVerdict !== 'pass') {
      return {
        allowed: false,
        error: `Quality gate must pass to move to done. Got: ${request.gateVerdict ?? 'none'}`,
      };
    }
  }

  // Check role authorization
  const authError = checkRoleAuthorization(request);
  if (authError) {
    return { allowed: false, error: authError };
  }

  return {
    allowed: true,
    transition: {
      itemId: request.taskId,
      fromStatus: request.fromStatus,
      toStatus: request.toStatus,
      movedBy: request.movedBy,
      reason: request.reason,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Check if a role is authorized to make a transition.
 */
function checkRoleAuthorization(request: TransitionRequest): string | null {
  const { fromStatus, toStatus, movedBy } = request;

  // PM/PL can make any transition
  if (movedBy === 'pm' || movedBy === 'pl') return null;

  // Workers can move their own tasks to in-progress from todo
  if (toStatus === 'in-progress' && fromStatus === 'todo') return null;

  // Workers can unblock themselves (blocked → todo or blocked → in-progress)
  if (fromStatus === 'blocked' && (toStatus === 'todo' || toStatus === 'in-progress' || toStatus === 'backlog')) return null;

  // Workers can move to blocked from any state
  if (toStatus === 'blocked') return null;

  // Workers can request review (move to review)
  if (toStatus === 'review' && fromStatus === 'in-progress') return null;

  // Only judges can approve (review → done)
  if (toStatus === 'done' && fromStatus === 'review') {
    const judges: RoleType[] = ['qa-engineer', 'security-specialist', 'pl'];
    if (!judges.includes(movedBy)) {
      return `Only judges (QA/Security/PL) can approve review → done. Got: ${movedBy}`;
    }
    return null;
  }

  // Only reviewers can reject review back to in-progress
  if (toStatus === 'in-progress' && fromStatus === 'review') {
    const reviewers: RoleType[] = ['qa-engineer', 'security-specialist', 'pl'];
    if (!reviewers.includes(movedBy)) {
      return `Only reviewers can reject reviews. Got: ${movedBy}`;
    }
    return null;
  }

  // Only PM/PL can cancel tasks (any state → cancelled)
  if (toStatus === 'cancelled') {
    return `Only PM or PL can cancel tasks. Got: ${movedBy}`;
  }

  // Fail-closed: reject any transition not explicitly authorized above
  return `Transition ${fromStatus} → ${toStatus} by ${movedBy} is not explicitly authorized`;
}

/**
 * Get the list of valid next states for a given status.
 */
export function getValidNextStates(status: KanbanStatus): KanbanStatus[] {
  return VALID_KANBAN_TRANSITIONS[status] ?? [];
}

/**
 * Determine the gate verdict needed based on the target status.
 */
export function requiredGateVerdict(toStatus: KanbanStatus): GateVerdict | null {
  if (toStatus === 'done') return 'pass';
  return null;
}
