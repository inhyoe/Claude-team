/**
 * Integration test: SQLite Persistence Pipeline
 *
 * End-to-end test exercising the full DB lifecycle:
 *   initDb → project/role/task CRUD → kanban transitions → quality gates → communication log → closeDb
 *
 * Requires better-sqlite3 (runtime dependency).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { initDb, getDb, closeDb, isDbInitialized, withTransaction } from '../../src/persistence/db.js';
import { createTask, getTask, getTasksByProject, getTasksByStatus, updateTaskStatus, updateTaskReviewScore, assignTaskRole, getKanbanCounts } from '../../src/persistence/tasks-repo.js';
import { createRole, getRole, getRolesByProject, getActiveRoles, updateRoleStatus, updateRoleAgent, mergeRole } from '../../src/persistence/roles-repo.js';
import { logMessage, getMessages, getMessagesByRole, getMessagesByType } from '../../src/persistence/communication-repo.js';
import { createGateResult, getGateResult, getGateResultsByTask, getLatestGateForTask, getGateStats } from '../../src/persistence/quality-gates-repo.js';
import { getTaskHistory, getRecentTransitions, getTransitionCount } from '../../src/persistence/kanban-repo.js';

let tmpDir: string;
const PROJECT_ID = 'proj-test-1';

// ============================================================
// DB LIFECYCLE
// ============================================================

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ct-integ-'));
  const ok = await initDb(tmpDir);
  expect(ok).toBe(true);

  // Seed a project row directly so FK constraints pass
  const db = getDb(tmpDir)!;
  db.prepare(`
    INSERT INTO projects (id, name, path, session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `).run(PROJECT_ID, 'Test Project', tmpDir, 'session-integ');
});

afterAll(() => {
  closeDb(tmpDir);
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// DATABASE INITIALIZATION
// ============================================================

describe('database lifecycle', () => {
  it('should report db as initialized', () => {
    expect(isDbInitialized(tmpDir)).toBe(true);
  });

  it('should return db instance', () => {
    const db = getDb(tmpDir);
    expect(db).not.toBeNull();
  });

  it('should have schema_info table with version', () => {
    const db = getDb(tmpDir)!;
    const row = db.prepare("SELECT value FROM schema_info WHERE key = 'version'").get() as { value: string };
    expect(parseInt(row.value, 10)).toBeGreaterThanOrEqual(1);
  });

  it('should have WAL journal mode', () => {
    const db = getDb(tmpDir)!;
    const row = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
    expect(row[0].journal_mode).toBe('wal');
  });

  it('should have all 10 tables', () => {
    const db = getDb(tmpDir)!;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    const names = tables.map(t => t.name).sort();
    expect(names).toEqual(expect.arrayContaining([
      'schema_info', 'projects', 'roles', 'tasks', 'kanban_history',
      'communication_log', 'artifacts', 'sprints', 'dag_nodes', 'quality_gates',
    ]));
  });
});

// ============================================================
// ROLES CRUD
// ============================================================

describe('roles repository', () => {
  it('should create and retrieve a role', () => {
    const role = createRole(tmpDir, PROJECT_ID, {
      roleId: 'role-pm',
      role: 'pm',
      personaName: 'Alex',
      provider: 'claude',
      model: 'opus',
    });
    expect(role).not.toBeNull();
    expect(role!.role).toBe('pm');
    expect(role!.personaName).toBe('Alex');
    expect(role!.status).toBe('active');
  });

  it('should create multiple roles', () => {
    createRole(tmpDir, PROJECT_ID, { roleId: 'role-pl', role: 'pl', personaName: 'Jordan', provider: 'claude', model: 'opus' });
    createRole(tmpDir, PROJECT_ID, { roleId: 'role-fe', role: 'fe-dev', personaName: 'Sam', provider: 'claude', model: 'sonnet' });
    createRole(tmpDir, PROJECT_ID, { roleId: 'role-qa', role: 'qa-engineer', personaName: 'Riley', provider: 'codex', model: 'sonnet' });

    const roles = getRolesByProject(tmpDir, PROJECT_ID);
    expect(roles.length).toBeGreaterThanOrEqual(4);
  });

  it('should filter active non-merged roles', () => {
    const active = getActiveRoles(tmpDir, PROJECT_ID);
    expect(active.length).toBeGreaterThanOrEqual(4);
    expect(active.every(r => r.status === 'active' && r.isMergedInto === null)).toBe(true);
  });

  it('should update role status', () => {
    const ok = updateRoleStatus(tmpDir, 'role-fe', 'idle');
    expect(ok).toBe(true);
    const role = getRole(tmpDir, 'role-fe');
    expect(role!.status).toBe('idle');
    // Restore
    updateRoleStatus(tmpDir, 'role-fe', 'active');
  });

  it('should update role agent name', () => {
    updateRoleAgent(tmpDir, 'role-pm', 'worker-pm');
    const role = getRole(tmpDir, 'role-pm');
    expect(role!.agentName).toBe('worker-pm');
  });

  it('should merge a role', () => {
    createRole(tmpDir, PROJECT_ID, { roleId: 'role-sec', role: 'security-specialist', personaName: 'Avery', provider: 'codex', model: 'opus' });
    mergeRole(tmpDir, 'role-sec', 'role-qa');
    const merged = getRole(tmpDir, 'role-sec');
    expect(merged!.isMergedInto).toBe('role-qa');
    expect(merged!.status).toBe('idle');

    // Active roles should exclude merged
    const active = getActiveRoles(tmpDir, PROJECT_ID);
    expect(active.find(r => r.roleId === 'role-sec')).toBeUndefined();
  });
});

// ============================================================
// TASKS CRUD
// ============================================================

describe('tasks repository', () => {
  it('should create a task in backlog', () => {
    const task = createTask(tmpDir, PROJECT_ID, {
      id: 'task-1',
      title: 'Build login form',
      description: 'Create a login form with email and password',
      priority: 1,
      assignedRole: 'fe-dev',
      fileOwnership: ['src/components/Login.tsx'],
    });
    expect(task).not.toBeNull();
    expect(task!.status).toBe('backlog');
    expect(task!.assignedRole).toBe('fe-dev');
    expect(task!.fileOwnership).toEqual(['src/components/Login.tsx']);
  });

  it('should create multiple tasks', () => {
    createTask(tmpDir, PROJECT_ID, { id: 'task-2', title: 'Build API endpoints', priority: 2, assignedRole: 'be-dev' });
    createTask(tmpDir, PROJECT_ID, { id: 'task-3', title: 'Write unit tests', priority: 3, assignedRole: 'qa-engineer' });

    const tasks = getTasksByProject(tmpDir, PROJECT_ID);
    expect(tasks.length).toBe(3);
    // Ordered by priority ASC
    expect(tasks[0].priority).toBeLessThanOrEqual(tasks[1].priority);
  });

  it('should get tasks by status', () => {
    const backlog = getTasksByStatus(tmpDir, PROJECT_ID, 'backlog');
    expect(backlog.length).toBe(3);
  });

  it('should update task status with kanban history', () => {
    const ok = updateTaskStatus(tmpDir, 'task-1', 'todo', 'pm', 'Sprint planning');
    expect(ok).toBe(true);

    const task = getTask(tmpDir, 'task-1');
    expect(task!.status).toBe('todo');
  });

  it('should track kanban history', () => {
    const history = getTaskHistory(tmpDir, 'task-1');
    expect(history.length).toBe(1);
    expect(history[0].fromStatus).toBe('backlog');
    expect(history[0].toStatus).toBe('todo');
    expect(history[0].movedBy).toBe('pm');
  });

  it('should update review score', () => {
    updateTaskReviewScore(tmpDir, 'task-1', 8.5);
    const task = getTask(tmpDir, 'task-1');
    expect(task!.reviewScore).toBe(8.5);
  });

  it('should assign role', () => {
    assignTaskRole(tmpDir, 'task-2', 'fe-dev');
    const task = getTask(tmpDir, 'task-2');
    expect(task!.assignedRole).toBe('fe-dev');
  });

  it('should count kanban statuses', () => {
    const counts = getKanbanCounts(tmpDir, PROJECT_ID);
    expect(counts['todo']).toBe(1);
    expect(counts['backlog']).toBe(2);
  });
});

// ============================================================
// KANBAN FLOW (multi-step transitions)
// ============================================================

describe('kanban flow', () => {
  it('should move task through full pipeline', () => {
    // todo -> in-progress -> review -> done
    updateTaskStatus(tmpDir, 'task-1', 'in-progress', 'fe-dev', 'Starting work');
    updateTaskStatus(tmpDir, 'task-1', 'review', 'fe-dev', 'Ready for review');
    updateTaskStatus(tmpDir, 'task-1', 'done', 'qa-engineer', 'All tests pass');

    const task = getTask(tmpDir, 'task-1');
    expect(task!.status).toBe('done');

    const history = getTaskHistory(tmpDir, 'task-1');
    expect(history.length).toBe(4); // backlog->todo, todo->ip, ip->review, review->done
  });

  it('should track transition counts', () => {
    const count = getTransitionCount(tmpDir, 'task-1');
    expect(count).toBe(4);
  });

  it('should retrieve recent transitions across project', () => {
    const recent = getRecentTransitions(tmpDir, PROJECT_ID, 10);
    expect(recent.length).toBeGreaterThanOrEqual(4);
    // Most recent first — verify the list is ordered by timestamp DESC
    expect(new Date(recent[0].timestamp).getTime()).toBeGreaterThanOrEqual(
      new Date(recent[recent.length - 1].timestamp).getTime()
    );
  });

  it('should handle review rejection loop', () => {
    // task-2: backlog -> todo -> in-progress -> review -> in-progress (rejected) -> review -> done
    updateTaskStatus(tmpDir, 'task-2', 'todo', 'pm');
    updateTaskStatus(tmpDir, 'task-2', 'in-progress', 'be-dev');
    updateTaskStatus(tmpDir, 'task-2', 'review', 'be-dev');
    updateTaskStatus(tmpDir, 'task-2', 'in-progress', 'qa-engineer', 'Security issue found');
    updateTaskStatus(tmpDir, 'task-2', 'review', 'be-dev', 'Fixed security issue');
    updateTaskStatus(tmpDir, 'task-2', 'done', 'qa-engineer', 'Approved');

    const task = getTask(tmpDir, 'task-2');
    expect(task!.status).toBe('done');
    expect(getTransitionCount(tmpDir, 'task-2')).toBe(6);
  });
});

// ============================================================
// COMMUNICATION LOG
// ============================================================

describe('communication repository', () => {
  it('should log a task assignment message', () => {
    const ok = logMessage(tmpDir, PROJECT_ID, {
      fromRole: 'pm',
      toRole: 'fe-dev',
      messageType: 'task_assignment',
      content: JSON.stringify({ taskId: 'task-1', subject: 'Build login form' }),
    });
    expect(ok).toBe(true);
  });

  it('should log a status report', () => {
    logMessage(tmpDir, PROJECT_ID, {
      fromRole: 'fe-dev',
      toRole: 'pl',
      messageType: 'status_report',
      content: JSON.stringify({ taskId: 'task-1', status: 'in-progress', progress: 50 }),
    });

    logMessage(tmpDir, PROJECT_ID, {
      fromRole: 'be-dev',
      toRole: 'pl',
      messageType: 'status_report',
      content: JSON.stringify({ taskId: 'task-2', status: 'completed', progress: 100 }),
    });
  });

  it('should retrieve messages by project', () => {
    const msgs = getMessages(tmpDir, PROJECT_ID);
    expect(msgs.length).toBe(3);
  });

  it('should retrieve messages by role', () => {
    const feMessages = getMessagesByRole(tmpDir, PROJECT_ID, 'fe-dev');
    expect(feMessages.length).toBeGreaterThanOrEqual(2); // sent and received
  });

  it('should retrieve messages by type', () => {
    const statusReports = getMessagesByType(tmpDir, PROJECT_ID, 'status_report');
    expect(statusReports.length).toBe(2);
  });

  it('should log broadcast message', () => {
    logMessage(tmpDir, PROJECT_ID, {
      fromRole: 'pl',
      toRole: 'all',
      messageType: 'escalation',
      channel: 'broadcast',
      content: JSON.stringify({ severity: 'high', reason: 'Shared types changed' }),
    });

    const msgs = getMessages(tmpDir, PROJECT_ID);
    const broadcast = msgs.find(m => m.channel === 'broadcast');
    expect(broadcast).toBeDefined();
    expect(broadcast!.toRole).toBe('all');
  });
});

// ============================================================
// QUALITY GATES
// ============================================================

describe('quality gates repository', () => {
  it('should create a gate result', () => {
    const result = createGateResult(tmpDir, PROJECT_ID, {
      id: 'gate-1',
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      taskId: 'task-1',
      score: 8.2,
      dimensions: { correctness: 9, security: 8, performance: 7, maintainability: 8, testCoverage: 9 },
      verdict: 'pass',
      feedback: 'Clean implementation, good test coverage.',
      attempt: 1,
    });
    expect(result).not.toBeNull();
    expect(result!.score).toBe(8.2);
    expect(result!.verdict).toBe('pass');
  });

  it('should create multiple gate results for same task', () => {
    createGateResult(tmpDir, PROJECT_ID, {
      id: 'gate-2',
      gateType: 'security-review',
      reviewerRole: 'security-specialist',
      taskId: 'task-1',
      score: 7.0,
      dimensions: { correctness: 7, security: 7, performance: 7, maintainability: 7, testCoverage: 7 },
      verdict: 'pass',
      feedback: 'No vulnerabilities found.',
      attempt: 1,
    });

    const gates = getGateResultsByTask(tmpDir, 'task-1');
    expect(gates.length).toBe(2);
  });

  it('should get latest gate for task by type', () => {
    // Add a second attempt for code-review
    createGateResult(tmpDir, PROJECT_ID, {
      id: 'gate-3',
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      taskId: 'task-2',
      score: 4.0,
      dimensions: { correctness: 4, security: 3, performance: 5, maintainability: 4, testCoverage: 4 },
      verdict: 'reject',
      feedback: 'Missing error handling.',
      attempt: 1,
    });

    createGateResult(tmpDir, PROJECT_ID, {
      id: 'gate-4',
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      taskId: 'task-2',
      score: 7.5,
      dimensions: { correctness: 8, security: 7, performance: 7, maintainability: 8, testCoverage: 7 },
      verdict: 'pass',
      feedback: 'Issues resolved.',
      attempt: 2,
    });

    const latest = getLatestGateForTask(tmpDir, 'task-2', 'code-review');
    expect(latest).not.toBeNull();
    expect(latest!.attempt).toBe(2);
    expect(latest!.verdict).toBe('pass');
  });

  it('should compute gate stats', () => {
    const stats = getGateStats(tmpDir, PROJECT_ID);
    expect(stats.passed).toBe(3);  // gate-1, gate-2, gate-4
    expect(stats.failed).toBe(1);  // gate-3
    expect(stats.lastScore).not.toBeNull();
  });
});

// ============================================================
// TRANSACTIONS
// ============================================================

describe('transactions', () => {
  it('should run function within transaction', () => {
    const result = withTransaction(tmpDir, (db) => {
      const row = db.prepare('SELECT COUNT(*) as cnt FROM tasks WHERE project_id = ?').get(PROJECT_ID) as { cnt: number };
      return row.cnt;
    });
    expect(result).toBe(3);
  });

  it('should rollback on error', () => {
    // withTransaction re-throws; better-sqlite3 rolls back automatically
    expect(() => {
      withTransaction(tmpDir, (db) => {
        db.prepare(`INSERT INTO tasks (id, project_id, title, kanban_status, priority, complexity_score, created_at, updated_at, moved_at)
          VALUES ('tx-test', ?, 'TX test', 'backlog', 3, 0, datetime('now'), datetime('now'), datetime('now'))`).run(PROJECT_ID);
        throw new Error('Simulated failure');
      });
    }).toThrow('Simulated failure');

    // Task should not exist (rolled back)
    const task = getTask(tmpDir, 'tx-test');
    expect(task).toBeNull();
  });
});

// ============================================================
// FULL PIPELINE E2E
// ============================================================

describe('full pipeline E2E', () => {
  it('should simulate a complete sprint cycle', () => {
    // 1. Create roles
    createRole(tmpDir, PROJECT_ID, { roleId: 'e2e-be', role: 'be-dev', personaName: 'Morgan', provider: 'claude', model: 'sonnet' });

    // 2. Create task
    const task = createTask(tmpDir, PROJECT_ID, {
      id: 'e2e-task',
      title: 'Add user endpoint',
      assignedRole: 'be-dev',
      priority: 1,
      fileOwnership: ['src/api/users.ts'],
    });
    expect(task).not.toBeNull();

    // 3. PM assigns -> todo
    updateTaskStatus(tmpDir, 'e2e-task', 'todo', 'pm', 'Sprint started');
    logMessage(tmpDir, PROJECT_ID, {
      fromRole: 'pm',
      toRole: 'be-dev',
      messageType: 'task_assignment',
      content: JSON.stringify({ taskId: 'e2e-task', subject: 'Add user endpoint' }),
    });

    // 4. Worker picks up -> in-progress
    updateTaskStatus(tmpDir, 'e2e-task', 'in-progress', 'be-dev', 'Starting');
    logMessage(tmpDir, PROJECT_ID, {
      fromRole: 'be-dev',
      toRole: 'pl',
      messageType: 'status_report',
      content: JSON.stringify({ taskId: 'e2e-task', status: 'in-progress', progress: 0 }),
    });

    // 5. Worker completes -> review
    updateTaskStatus(tmpDir, 'e2e-task', 'review', 'be-dev', 'Implementation complete');

    // 6. QA reviews - first attempt fails
    createGateResult(tmpDir, PROJECT_ID, {
      id: 'e2e-gate-1',
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      taskId: 'e2e-task',
      score: 4.5,
      dimensions: { correctness: 5, security: 3, performance: 5, maintainability: 5, testCoverage: 4 },
      verdict: 'reject',
      feedback: 'Missing input validation',
      attempt: 1,
    });

    // 7. Back to in-progress for fix
    updateTaskStatus(tmpDir, 'e2e-task', 'in-progress', 'qa-engineer', 'Security issue');

    // 8. Worker fixes -> review again
    updateTaskStatus(tmpDir, 'e2e-task', 'review', 'be-dev', 'Fixed validation');

    // 9. QA reviews - second attempt passes
    createGateResult(tmpDir, PROJECT_ID, {
      id: 'e2e-gate-2',
      gateType: 'code-review',
      reviewerRole: 'qa-engineer',
      taskId: 'e2e-task',
      score: 8.0,
      dimensions: { correctness: 8, security: 8, performance: 8, maintainability: 8, testCoverage: 8 },
      verdict: 'pass',
      feedback: 'All issues resolved',
      attempt: 2,
    });

    // 10. Done
    updateTaskStatus(tmpDir, 'e2e-task', 'done', 'qa-engineer', 'Approved');
    updateTaskReviewScore(tmpDir, 'e2e-task', 8.0);

    // Verify final state
    const finalTask = getTask(tmpDir, 'e2e-task');
    expect(finalTask!.status).toBe('done');
    expect(finalTask!.reviewScore).toBe(8.0);

    const history = getTaskHistory(tmpDir, 'e2e-task');
    expect(history.length).toBe(6); // backlog->todo, todo->ip, ip->review, review->ip, ip->review, review->done

    const gates = getGateResultsByTask(tmpDir, 'e2e-task');
    expect(gates.length).toBe(2);
    expect(gates[1].verdict).toBe('pass');
  });
});
