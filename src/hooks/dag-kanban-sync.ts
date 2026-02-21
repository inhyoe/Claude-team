/**
 * Claude Team - DAG ↔ Kanban Synchronization
 *
 * Bridges DAG execution engine with the kanban board:
 * - DAG node status changes → kanban task transitions
 * - Quality gate results → kanban status updates
 *
 * Reference: ACM Computing Survey on Multi-Agent Systems (2025)
 * "Centralized planning, decentralized execution with deterministic state sync"
 */

import type { KanbanStatus, RoleType, GateVerdict } from '../shared/types.js';
import { moveTask } from '../kanban/board.js';
import { getTask } from '../persistence/tasks-repo.js';
import type { HookRegistry } from './lifecycle.js';

export interface SyncConfig {
  cwd: string;
  projectId: string;
}

/**
 * Create a DAG↔Kanban sync adapter.
 * Registers hook listeners that auto-sync DAG status → kanban board.
 */
export function createDagKanbanSync(config: SyncConfig, hooks: HookRegistry): { detach: () => void } {
  const unsubs: Array<() => void> = [];

  // node:started → kanban: todo → in-progress
  unsubs.push(hooks.on('node:started', (event) => {
    const { taskId, roleId } = event.data as { taskId: string | null; roleId: string };
    if (!taskId) return;

    const task = getTask(config.cwd, taskId);
    if (!task) return;

    // Only move if currently in todo
    if (task.status === 'todo' || task.status === 'backlog') {
      moveTask(config.cwd, taskId, 'in-progress', roleId as RoleType, 'DAG node execution started');
    }
  }));

  // node:completed → kanban: in-progress → review
  unsubs.push(hooks.on('node:completed', (event) => {
    const { taskId, roleId } = event.data as { taskId: string | null; roleId: string };
    if (!taskId) return;

    const task = getTask(config.cwd, taskId);
    if (!task) return;

    if (task.status === 'in-progress') {
      moveTask(config.cwd, taskId, 'review', roleId as RoleType, 'Work completed, pending quality gate review');
    }
  }));

  // node:failed → kanban: → failed
  unsubs.push(hooks.on('node:failed', (event) => {
    const { taskId, roleId } = event.data as { taskId: string | null; roleId: string };
    if (!taskId) return;

    const task = getTask(config.cwd, taskId);
    if (!task) return;

    if (task.status !== 'failed' && task.status !== 'done') {
      moveTask(config.cwd, taskId, 'failed', roleId as RoleType, 'DAG node execution failed');
    }
  }));

  // gate:passed → kanban: review → done
  unsubs.push(hooks.on('gate:passed', (event) => {
    const { taskId } = event.data as { taskId: string };
    if (!taskId) return;

    const task = getTask(config.cwd, taskId);
    if (!task) return;

    if (task.status === 'review') {
      moveTask(config.cwd, taskId, 'done', 'pl' as RoleType, 'Quality gate passed', 'pass' as GateVerdict);
    }
  }));

  // gate:failed → kanban: review → in-progress (for rework)
  unsubs.push(hooks.on('gate:failed', (event) => {
    const { taskId } = event.data as { taskId: string };
    if (!taskId) return;

    const task = getTask(config.cwd, taskId);
    if (!task) return;

    if (task.status === 'review') {
      moveTask(config.cwd, taskId, 'in-progress', 'qa-engineer' as RoleType, 'Quality gate failed, returning for rework');
    }
  }));

  return {
    detach() {
      for (const unsub of unsubs) unsub();
    }
  };
}
