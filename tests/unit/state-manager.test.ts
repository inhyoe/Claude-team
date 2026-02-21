/**
 * State Manager unit tests
 *
 * Tests: pipeline state CRUD, phase transitions, state updates.
 * Uses tmp directory to avoid polluting the project.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createPipelineState,
  loadPipelineState,
  saveState,
  clearState,
  transitionPhase,
  updateComplexity,
  updateRoles,
  updateExecution,
  updateKanbanCounts,
  updateQualityGates,
  requestCancel,
  isActive,
  canResume,
  getStateSummary,
} from '../../src/features/state-manager/index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ct-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================
// STATE LIFECYCLE
// ============================================================

describe('state lifecycle', () => {
  it('should create initial pipeline state', () => {
    const state = createPipelineState(tmpDir, 'session-1', '/project');
    expect(state.mode).toBe('claude-team');
    expect(state.active).toBe(true);
    expect(state.phase).toBe('team-plan');
    expect(state.iteration).toBe(1);
    expect(state.sessionId).toBe('session-1');
    expect(state.projectPath).toBe('/project');
  });

  it('should persist state to disk', () => {
    createPipelineState(tmpDir, 'session-1', '/project');
    const statePath = join(tmpDir, '.omc/state/ct-pipeline-state.json');
    expect(existsSync(statePath)).toBe(true);
  });

  it('should load persisted state', () => {
    createPipelineState(tmpDir, 'session-1', '/project');
    const loaded = loadPipelineState(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe('session-1');
    expect(loaded!.phase).toBe('team-plan');
  });

  it('should return null when no state exists', () => {
    const loaded = loadPipelineState(tmpDir);
    expect(loaded).toBeNull();
  });

  it('should clear state from disk', () => {
    createPipelineState(tmpDir, 'session-1', '/project');
    clearState(tmpDir);
    expect(loadPipelineState(tmpDir)).toBeNull();
  });

  it('should not throw when clearing non-existent state', () => {
    expect(() => clearState(tmpDir)).not.toThrow();
  });
});

// ============================================================
// PHASE TRANSITIONS
// ============================================================

describe('transitionPhase', () => {
  it('should transition from team-plan to team-exec', () => {
    createPipelineState(tmpDir, 's1', '/p');
    const result = transitionPhase(tmpDir, 'team-exec');
    expect(result.ok).toBe(true);
    expect(result.state.phase).toBe('team-exec');
  });

  it('should transition from team-plan to team-prd', () => {
    createPipelineState(tmpDir, 's1', '/p');
    const result = transitionPhase(tmpDir, 'team-prd');
    expect(result.ok).toBe(true);
    expect(result.state.phase).toBe('team-prd');
  });

  it('should reject invalid transitions', () => {
    createPipelineState(tmpDir, 's1', '/p');
    const result = transitionPhase(tmpDir, 'complete');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Cannot transition');
  });

  it('should record phase history', () => {
    createPipelineState(tmpDir, 's1', '/p');
    transitionPhase(tmpDir, 'team-exec', 'Tasks decomposed');
    const state = loadPipelineState(tmpDir)!;
    expect(state.phaseHistory).toHaveLength(2);
    expect(state.phaseHistory[1].phase).toBe('team-exec');
    expect(state.phaseHistory[1].reason).toBe('Tasks decomposed');
  });

  it('should deactivate on terminal states', () => {
    createPipelineState(tmpDir, 's1', '/p');
    transitionPhase(tmpDir, 'team-exec');
    transitionPhase(tmpDir, 'team-verify');
    transitionPhase(tmpDir, 'complete');
    const state = loadPipelineState(tmpDir)!;
    expect(state.active).toBe(false);
    expect(state.completedAt).not.toBeNull();
  });

  it('should deactivate on failure', () => {
    createPipelineState(tmpDir, 's1', '/p');
    transitionPhase(tmpDir, 'team-exec');
    transitionPhase(tmpDir, 'failed');
    const state = loadPipelineState(tmpDir)!;
    expect(state.active).toBe(false);
  });

  it('should increment fix loop counter', () => {
    createPipelineState(tmpDir, 's1', '/p');
    transitionPhase(tmpDir, 'team-exec');
    transitionPhase(tmpDir, 'team-verify');
    transitionPhase(tmpDir, 'team-fix');
    const state = loadPipelineState(tmpDir)!;
    expect(state.fixLoop.attempt).toBe(1);
  });

  it('should fail when fix loop exceeds max', () => {
    createPipelineState(tmpDir, 's1', '/p');

    // Exhaust fix loops: 3 fix cycles
    for (let i = 0; i < 3; i++) {
      transitionPhase(tmpDir, 'team-exec');
      transitionPhase(tmpDir, 'team-verify');
      transitionPhase(tmpDir, 'team-fix');
      // team-fix → team-exec for next cycle
      if (i < 2) {
        transitionPhase(tmpDir, 'team-exec');
        transitionPhase(tmpDir, 'team-verify');
        transitionPhase(tmpDir, 'team-fix');
      }
    }

    const state = loadPipelineState(tmpDir)!;
    // After exceeding maxAttempts, state should be failed
    expect(state.phase).toBe('failed');
    expect(state.active).toBe(false);
  });

  it('should fail when no pipeline state exists', () => {
    const result = transitionPhase(tmpDir, 'team-exec');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('No active pipeline');
  });

  it('should allow restart from failed', () => {
    createPipelineState(tmpDir, 's1', '/p');
    transitionPhase(tmpDir, 'team-exec');
    transitionPhase(tmpDir, 'failed');
    const result = transitionPhase(tmpDir, 'team-plan');
    expect(result.ok).toBe(true);
    expect(result.state.phase).toBe('team-plan');
  });
});

// ============================================================
// STATE UPDATES
// ============================================================

describe('state updates', () => {
  it('should update complexity score', () => {
    createPipelineState(tmpDir, 's1', '/p');
    updateComplexity(tmpDir, {
      level: 'medium',
      score: 0.55,
      factors: { fileCount: 8, crossModuleDeps: 3, hasTests: true, hasApiChanges: true, hasDbChanges: false, hasSecurityImplications: false },
      recommendedAgentCount: 3,
    });
    const state = loadPipelineState(tmpDir)!;
    expect(state.complexityScore!.level).toBe('medium');
    expect(state.complexityScore!.score).toBe(0.55);
  });

  it('should update roles', () => {
    createPipelineState(tmpDir, 's1', '/p');
    updateRoles(tmpDir, [{
      roleId: 'r-1',
      role: 'pm',
      personaName: 'Alex',
      agentName: 'worker-1',
      provider: 'claude',
      model: 'opus',
      isMergedInto: null,
      mergedRoles: [],
      status: 'active',
    }]);
    const state = loadPipelineState(tmpDir)!;
    expect(state.roles).toHaveLength(1);
    expect(state.roles[0].personaName).toBe('Alex');
  });

  it('should update execution counters', () => {
    createPipelineState(tmpDir, 's1', '/p');
    updateExecution(tmpDir, { workersTotal: 3, workersActive: 2, tasksTotal: 10 });
    const state = loadPipelineState(tmpDir)!;
    expect(state.execution.workersTotal).toBe(3);
    expect(state.execution.workersActive).toBe(2);
    expect(state.execution.tasksTotal).toBe(10);
    expect(state.execution.tasksCompleted).toBe(0); // unchanged
  });

  it('should update kanban counts', () => {
    createPipelineState(tmpDir, 's1', '/p');
    updateKanbanCounts(tmpDir, { inProgress: 3, review: 2, done: 5 });
    const state = loadPipelineState(tmpDir)!;
    expect(state.kanban.inProgress).toBe(3);
    expect(state.kanban.review).toBe(2);
    expect(state.kanban.done).toBe(5);
  });

  it('should update quality gates', () => {
    createPipelineState(tmpDir, 's1', '/p');
    updateQualityGates(tmpDir, { passed: 3, failed: 1, lastScore: 7.5 });
    const state = loadPipelineState(tmpDir)!;
    expect(state.qualityGates.passed).toBe(3);
    expect(state.qualityGates.failed).toBe(1);
    expect(state.qualityGates.lastScore).toBe(7.5);
  });

  it('should handle cancel request', () => {
    createPipelineState(tmpDir, 's1', '/p');
    requestCancel(tmpDir, true);
    const state = loadPipelineState(tmpDir)!;
    expect(state.cancel.requested).toBe(true);
    expect(state.cancel.requestedAt).not.toBeNull();
    expect(state.cancel.preserveForResume).toBe(true);
  });
});

// ============================================================
// STATE QUERIES
// ============================================================

describe('state queries', () => {
  it('should report active state', () => {
    createPipelineState(tmpDir, 's1', '/p');
    expect(isActive(tmpDir)).toBe(true);
  });

  it('should report inactive when no state', () => {
    expect(isActive(tmpDir)).toBe(false);
  });

  it('should report inactive after completion', () => {
    createPipelineState(tmpDir, 's1', '/p');
    transitionPhase(tmpDir, 'team-exec');
    transitionPhase(tmpDir, 'team-verify');
    transitionPhase(tmpDir, 'complete');
    expect(isActive(tmpDir)).toBe(false);
  });

  it('should allow resume when active', () => {
    createPipelineState(tmpDir, 's1', '/p');
    expect(canResume(tmpDir)).toBe(true);
  });

  it('should allow resume when cancelled with preserve', () => {
    createPipelineState(tmpDir, 's1', '/p');
    requestCancel(tmpDir, true);
    // State is still active because cancel just sets a flag
    expect(canResume(tmpDir)).toBe(true);
  });

  it('should return state summary', () => {
    createPipelineState(tmpDir, 's1', '/p');
    updateExecution(tmpDir, { workersTotal: 3, workersActive: 2, tasksTotal: 10, tasksCompleted: 5 });
    const summary = getStateSummary(tmpDir);
    expect(summary).not.toBeNull();
    expect(summary).toContain('team-plan');
    expect(summary).toContain('active');
    expect(summary).toContain('5/10 completed');
  });

  it('should return null summary when no state', () => {
    expect(getStateSummary(tmpDir)).toBeNull();
  });
});
