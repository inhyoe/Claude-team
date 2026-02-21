/**
 * Bridge Tool Categories Integration Tests
 *
 * Tests the same logic the MCP bridge delegates to, importing directly from
 * compiled TypeScript sources (vitest handles transpilation). This avoids
 * the CJS/ESM boundary of ct-bridge.cjs while verifying real behavior.
 *
 * Categories tested:
 *   State Reader tools  - team_status, kanban_board, get_plan_status
 *   Logic tools         - validate_transition, analyze_complexity, select_roles
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// State reader infrastructure
import { initDb, getDb, closeDb } from '../../src/persistence/db.js';
import {
  createPipelineState,
  loadPipelineState,
  saveState,
  transitionPhase,
} from '../../src/features/state-manager/index.js';
import { loadPlanNodes, savePlanNodes } from '../../src/persistence/dag-nodes-repo.js';
import { buildExecutionPlan } from '../../src/core/dag-engine.js';

// Logic tool infrastructure (what the bridge calls via ct.*)
import { validateTransition, getValidNextStates } from '../../src/kanban/state-machine.js';
import { analyzeComplexity, estimateFromDescription } from '../../src/core/complexity-analyzer.js';
import { selectRoles } from '../../src/core/planner-worker-judge.js';
import type { RoleType, KanbanStatus, ComplexityScore } from '../../src/shared/types.js';

// ============================================================
// SHARED TEST FIXTURES
// ============================================================

let testDir: string;
const projectId = 'bridge-test-proj';

function seedProject(dir: string): void {
  const db = getDb(dir)!;
  db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, path, session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `).run(projectId, 'Bridge Test Project', dir, 'session-bridge-test');
}

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'ct-bridge-tools-test-'));
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
// STATE READER TOOLS
// ============================================================

describe('Bridge state readers - ct_team_status', () => {
  it('returns null when no pipeline state exists (no active pipeline)', () => {
    // Bridge handler: "if (!state) return ok('No active Claude Team pipeline.')"
    const state = loadPipelineState(testDir);
    expect(state).toBeNull();
  });

  it('returns the phase and active flag after initialization', () => {
    createPipelineState(testDir, 'sess-abc', testDir);
    const state = loadPipelineState(testDir);

    expect(state).not.toBeNull();
    expect(state!.active).toBe(true);
    expect(state!.phase).toBe('team-plan');
  });

  it('exposes execution and kanban counters initialized to zero', () => {
    createPipelineState(testDir, 'sess-counters', testDir);
    const state = loadPipelineState(testDir)!;

    expect(state.execution.workersActive).toBe(0);
    expect(state.execution.workersTotal).toBe(0);
    expect(state.execution.tasksTotal).toBe(0);
    expect(state.kanban.backlog).toBe(0);
    expect(state.kanban.done).toBe(0);
  });

  it('reflects updated kanban counts after saveState', () => {
    createPipelineState(testDir, 'sess-update', testDir);
    const state = loadPipelineState(testDir)!;

    state.kanban.inProgress = 3;
    state.kanban.done = 7;
    saveState(testDir, state);

    const reloaded = loadPipelineState(testDir)!;
    expect(reloaded.kanban.inProgress).toBe(3);
    expect(reloaded.kanban.done).toBe(7);
  });
});

describe('Bridge state readers - ct_kanban_board', () => {
  it('returns empty kanban board when no pipeline exists', () => {
    // Bridge: "if (!state) return ok('No active pipeline. Run /ct-setup first.')"
    const state = loadPipelineState(testDir);
    expect(state).toBeNull();
  });

  it('returns kanban object with all 7 columns present', () => {
    createPipelineState(testDir, 'sess-kanban', testDir);
    const state = loadPipelineState(testDir)!;
    const k = state.kanban;

    // Bridge renders: backlog, todo, inProgress, review, done, blocked, failed
    expect(k).toHaveProperty('backlog');
    expect(k).toHaveProperty('todo');
    expect(k).toHaveProperty('inProgress');
    expect(k).toHaveProperty('review');
    expect(k).toHaveProperty('done');
    expect(k).toHaveProperty('blocked');
    expect(k).toHaveProperty('failed');
  });

  it('kanban totals reflect all seven status columns', () => {
    createPipelineState(testDir, 'sess-totals', testDir);
    const state = loadPipelineState(testDir)!;

    state.kanban = {
      backlog: 5,
      todo: 3,
      inProgress: 2,
      review: 1,
      done: 4,
      blocked: 0,
      failed: 1,
    };
    saveState(testDir, state);

    const reloaded = loadPipelineState(testDir)!;
    const total = Object.values(reloaded.kanban).reduce((a, b) => a + b, 0);
    expect(total).toBe(16);
  });
});

describe('Bridge state readers - ct_get_plan_status', () => {
  it('returns null map (no nodes) for a non-existent planId', () => {
    // loadPlanNodes returns an empty Map when no nodes are persisted
    const nodesMap = loadPlanNodes(testDir, 'plan-nonexistent');
    // Map is returned but empty — bridge responds with not_found for 0 nodes
    expect(nodesMap).not.toBeNull();
    expect(nodesMap!.size).toBe(0);
  });

  it('returns persisted node statuses for a saved plan', () => {
    // Seed a task FK so DAG nodes can reference it
    const db = getDb(testDir)!;
    const ts = new Date().toISOString();
    db.prepare(`
      INSERT OR IGNORE INTO tasks (id, project_id, title, kanban_status, assigned_role, priority, created_at, updated_at, moved_at)
      VALUES (?, ?, ?, 'backlog', 'fe-dev', 3, ?, ?, ?)
    `).run('task-plan-node', projectId, 'Plan Node Task', ts, ts, ts);

    // Build a minimal plan. The spec id becomes taskId on the DAG node,
    // so it must match the seeded task row to satisfy the FK constraint.
    const plan = buildExecutionPlan(projectId, [
      {
        id: 'task-plan-node',
        title: 'Frontend work',
        description: 'Build UI',
        assignedRole: 'fe-dev' as RoleType,
        nodeType: 'execution',
        priority: 1,
        dependencies: [],
        filePatterns: [],
      },
    ]);

    savePlanNodes(testDir, projectId, plan);

    const loaded = loadPlanNodes(testDir, plan.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.size).toBeGreaterThan(0);

    // Every node should start as 'pending'
    for (const node of loaded!.values()) {
      expect(node.status).toBe('pending');
    }
  });
});

// ============================================================
// LOGIC TOOLS - ct_validate_transition
// ============================================================

describe('Bridge logic tools - ct_validate_transition', () => {
  it('approves a valid backlog → todo transition by pm', () => {
    const result = validateTransition({
      taskId: 'task-vt-1',
      fromStatus: 'backlog',
      toStatus: 'todo',
      movedBy: 'pm' as RoleType,
      reason: 'Sprint planning',
    });

    expect(result.allowed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.transition?.fromStatus).toBe('backlog');
    expect(result.transition?.toStatus).toBe('todo');
  });

  it('approves todo → in-progress transition by fe-dev', () => {
    const result = validateTransition({
      taskId: 'task-vt-2',
      fromStatus: 'todo',
      toStatus: 'in-progress',
      movedBy: 'fe-dev' as RoleType,
      reason: 'Starting work',
    });

    expect(result.allowed).toBe(true);
  });

  it('rejects an invalid transition: done → in-progress', () => {
    const result = validateTransition({
      taskId: 'task-vt-bad',
      fromStatus: 'done',
      toStatus: 'in-progress',
      movedBy: 'fe-dev' as RoleType,
      reason: 'Trying to reopen',
    });

    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/invalid transition/i);
  });

  it('rejects review → done without a passing gate verdict', () => {
    const result = validateTransition({
      taskId: 'task-vt-gate',
      fromStatus: 'review',
      toStatus: 'done',
      movedBy: 'pl' as RoleType,
      reason: 'Trying to close',
      // gateVerdict intentionally omitted
    });

    expect(result.allowed).toBe(false);
    expect(result.error).toMatch(/quality gate/i);
  });

  it('approves review → done when gateVerdict is pass', () => {
    const result = validateTransition({
      taskId: 'task-vt-pass',
      fromStatus: 'review',
      toStatus: 'done',
      movedBy: 'pl' as RoleType,
      reason: 'Gate passed',
      gateVerdict: 'pass',
    });

    expect(result.allowed).toBe(true);
  });

  it('getValidNextStates returns correct targets for backlog', () => {
    const next = getValidNextStates('backlog' as KanbanStatus);
    expect(next).toContain('todo');
    // blocked is always reachable
    expect(next).toContain('blocked');
  });

  it('getValidNextStates returns empty or terminal set for done', () => {
    const next = getValidNextStates('done' as KanbanStatus);
    // done is a terminal state — no forward transitions
    expect(next).toHaveLength(0);
  });
});

// ============================================================
// LOGIC TOOLS - ct_analyze_complexity
// ============================================================

describe('Bridge logic tools - ct_analyze_complexity', () => {
  it('returns tiny complexity for a minimal task (few files, no special flags)', () => {
    const result = analyzeComplexity({
      description: 'Fix a typo',
      fileCount: 1,
      crossModuleDeps: 0,
      hasTests: false,
      hasApiChanges: false,
      hasDbChanges: false,
      hasSecurityImplications: false,
    });

    expect(result.level).toBe('tiny');
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.recommendedAgentCount).toBe(1);
  });

  it('returns large complexity for a broad, security-critical task', () => {
    const result = analyzeComplexity({
      description: 'Full authentication system rewrite',
      fileCount: 20,
      crossModuleDeps: 5,
      hasTests: true,
      hasApiChanges: true,
      hasDbChanges: true,
      hasSecurityImplications: true,
    });

    expect(result.level).toBe('large');
    expect(result.score).toBeCloseTo(1.0, 1);
    expect(result.recommendedAgentCount).toBeGreaterThanOrEqual(3);
  });

  it('returns a score between 0 and 1 for all input combinations', () => {
    const inputs = [
      { fileCount: 0, crossModuleDeps: 0, hasTests: false, hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false },
      { fileCount: 3, crossModuleDeps: 2, hasTests: true, hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false },
      { fileCount: 15, crossModuleDeps: 4, hasTests: true, hasApiChanges: true, hasDbChanges: true, hasSecurityImplications: true },
    ];

    for (const factors of inputs) {
      const result = analyzeComplexity({ description: 'test', ...factors });
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(['tiny', 'small', 'medium', 'large']).toContain(result.level);
    }
  });

  it('estimateFromDescription returns a valid complexity score from text keywords', () => {
    const result = estimateFromDescription('Implement OAuth2 authentication with database migrations and API changes');

    expect(result).toHaveProperty('level');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('recommendedAgentCount');
    expect(['tiny', 'small', 'medium', 'large']).toContain(result.level);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('estimateFromDescription returns higher complexity for security-related text', () => {
    const simple = estimateFromDescription('Update button label');
    const complex = estimateFromDescription('Implement security audit, database schema migration, and API redesign');

    expect(complex.score).toBeGreaterThan(simple.score);
  });
});

// ============================================================
// LOGIC TOOLS - ct_select_roles
// ============================================================

describe('Bridge logic tools - ct_select_roles', () => {
  it('returns exactly 1 role assignment for tiny complexity', () => {
    const complexity: ComplexityScore = {
      level: 'tiny',
      score: 0.05,
      factors: {
        fileCount: 1, crossModuleDeps: 0,
        hasTests: false, hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false,
      },
      recommendedAgentCount: 1,
    };

    const roles = selectRoles(complexity);

    expect(roles).toHaveLength(1);
    expect(roles[0].status).toBe('active');
  });

  it('returns multiple role assignments for large complexity', () => {
    const complexity: ComplexityScore = {
      level: 'large',
      score: 0.95,
      factors: {
        fileCount: 20, crossModuleDeps: 5,
        hasTests: true, hasApiChanges: true, hasDbChanges: true, hasSecurityImplications: true,
      },
      recommendedAgentCount: 4,
    };

    const roles = selectRoles(complexity);

    expect(roles.length).toBeGreaterThanOrEqual(3);
    expect(roles.every(r => r.status === 'active')).toBe(true);
  });

  it('every role assignment has required fields populated', () => {
    const complexity: ComplexityScore = {
      level: 'medium',
      score: 0.5,
      factors: {
        fileCount: 6, crossModuleDeps: 2,
        hasTests: true, hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false,
      },
      recommendedAgentCount: 2,
    };

    const roles = selectRoles(complexity);

    for (const r of roles) {
      expect(r.roleId).toBeTruthy();
      expect(r.role).toBeTruthy();
      expect(r.personaName).toBeTruthy();
      expect(['claude', 'codex', 'gemini']).toContain(r.provider);
      expect(['planner', 'worker', 'judge']).toContain(r.dagLayer);
      expect(Array.isArray(r.mergedRoles)).toBe(true);
    }
  });

  it('roles returned for small complexity cover planner-worker-judge layers', () => {
    const complexity: ComplexityScore = {
      level: 'small',
      score: 0.2,
      factors: {
        fileCount: 3, crossModuleDeps: 1,
        hasTests: false, hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false,
      },
      recommendedAgentCount: 2,
    };

    const roles = selectRoles(complexity);
    const layers = roles.map(r => r.dagLayer);

    // At minimum, small complexity should have at least a planner and a worker
    expect(layers).toContain('planner');
    expect(layers).toContain('worker');
  });
});

// ============================================================
// CROSS-TOOL INTEGRATION: complexity → role selection pipeline
// ============================================================

describe('Bridge cross-tool integration - complexity analysis feeds role selection', () => {
  it('analyzeComplexity output drives selectRoles correctly for a medium task', () => {
    const complexity = analyzeComplexity({
      description: 'Add user profile page with avatar upload',
      fileCount: 6,
      crossModuleDeps: 2,
      hasTests: true,
      hasApiChanges: true,
      hasDbChanges: false,
      hasSecurityImplications: false,
    });

    // Pipe result directly into selectRoles (same pipeline the bridge uses)
    const roles = selectRoles(complexity);

    expect(roles.length).toBeGreaterThanOrEqual(1);
    expect(complexity.level).toBeDefined();
    // roles count should match recommendedAgentCount
    expect(roles.length).toBe(complexity.recommendedAgentCount);
  });

  it('pipeline status reflects transition history correctly', () => {
    createPipelineState(testDir, 'sess-pipeline', testDir);

    const result = transitionPhase(testDir, 'team-prd', 'PRD phase starting');
    expect(result.ok).toBe(true);
    expect(result.state?.phase).toBe('team-prd');

    const state = loadPipelineState(testDir)!;
    expect(state.phase).toBe('team-prd');
    expect(state.phaseHistory.length).toBeGreaterThanOrEqual(2);
    expect(state.phaseHistory[state.phaseHistory.length - 1].phase).toBe('team-prd');
  });
});
