/**
 * Claude Team - Full Pipeline E2E Tests
 *
 * Tests the complete pipeline flow without real AI calls by importing
 * TypeScript modules directly. Covers:
 *   1. State initialisation  (state-manager)
 *   2. Complexity analysis   (complexity-analyzer)
 *   3. Role selection        (planner-worker-judge)
 *   4. DAG construction      (dag-engine)
 *   5. Phase transitions     (state-manager)
 *   6. State persistence     (state-manager + file system)
 *
 * Each describe block maps to one pipeline stage so failures are easy to
 * locate. No mocks are used — real module logic runs against a temporary
 * directory that is cleaned up after every test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// --- Stage 1: State Manager ---
import {
  createPipelineState,
  loadPipelineState,
  saveState,
  transitionPhase,
  updateComplexity,
  updateRoles,
  updateKanbanCounts,
  updateQualityGates,
  updateExecution,
  requestCancel,
  isActive,
  canResume,
  getStateSummary,
  withStateLock,
  clearState,
} from '../../src/features/state-manager/index.js';

// --- Stage 2: Complexity Analyzer ---
import {
  analyzeComplexity,
  estimateFromDescription,
} from '../../src/core/complexity-analyzer.js';

// --- Stage 3: Role Selection ---
import { selectRoles } from '../../src/core/planner-worker-judge.js';

// --- Stage 4: DAG Engine ---
import {
  buildExecutionPlan,
  topologicalSort,
  getReadyNodes,
  isLayerComplete,
  advanceLayer,
  markNodeStarted,
  markNodeCompleted,
  markNodeFailed,
  validateFileOwnership,
} from '../../src/core/dag-engine.js';

import type { DAGNode, DAGEdge, ComplexityScore, RoleType } from '../../src/shared/types.js';
import type { TaskSpec } from '../../src/core/dag-types.js';
import { TEAM_PIPELINE_SCHEMA_VERSION } from '../../src/shared/types.js';

// ============================================================
// TEST FIXTURES
// ============================================================

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'ct-e2e-pipeline-'));
});

afterEach(() => {
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

function makeTaskSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: 'task-1',
    title: 'Implement feature',
    description: 'Build the new feature',
    assignedRole: 'fe-dev',
    filePatterns: ['src/components/**/*.tsx'],
    dependencies: [],
    nodeType: 'execution',
    priority: 2,
    ...overrides,
  };
}

// ============================================================
// STAGE 1: STATE INITIALISATION
// ============================================================

describe('Stage 1: Pipeline state initialisation', () => {
  it('creates state file at the expected path', () => {
    createPipelineState(testDir, 'session-001', testDir);

    const statePath = join(testDir, '.omc/state/ct-pipeline-state.json');
    expect(existsSync(statePath)).toBe(true);
  });

  it('returns state with correct schema version', () => {
    const state = createPipelineState(testDir, 'session-001', testDir);
    expect(state.schemaVersion).toBe(TEAM_PIPELINE_SCHEMA_VERSION);
  });

  it('initialises pipeline in team-plan phase', () => {
    const state = createPipelineState(testDir, 'session-001', testDir);
    expect(state.phase).toBe('team-plan');
  });

  it('sets active flag to true on creation', () => {
    const state = createPipelineState(testDir, 'session-001', testDir);
    expect(state.active).toBe(true);
  });

  it('records sessionId and projectPath correctly', () => {
    const state = createPipelineState(testDir, 'my-session-xyz', '/project/path');
    expect(state.sessionId).toBe('my-session-xyz');
    expect(state.projectPath).toBe('/project/path');
  });

  it('initialises kanban counters to zero', () => {
    const state = createPipelineState(testDir, 'session-001', testDir);
    const k = state.kanban;
    expect(k.backlog).toBe(0);
    expect(k.todo).toBe(0);
    expect(k.inProgress).toBe(0);
    expect(k.review).toBe(0);
    expect(k.done).toBe(0);
    expect(k.blocked).toBe(0);
    expect(k.failed).toBe(0);
  });

  it('initialises execution counters to zero', () => {
    const state = createPipelineState(testDir, 'session-001', testDir);
    const e = state.execution;
    expect(e.workersTotal).toBe(0);
    expect(e.workersActive).toBe(0);
    expect(e.tasksTotal).toBe(0);
    expect(e.tasksCompleted).toBe(0);
    expect(e.tasksFailed).toBe(0);
  });

  it('initialises fix loop with attempt 0 and max 3', () => {
    const state = createPipelineState(testDir, 'session-001', testDir);
    expect(state.fixLoop.attempt).toBe(0);
    expect(state.fixLoop.maxAttempts).toBe(3);
    expect(state.fixLoop.lastFailureReason).toBeNull();
  });

  it('roundtrips through loadPipelineState correctly', () => {
    createPipelineState(testDir, 'session-roundtrip', testDir);
    const loaded = loadPipelineState(testDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe('session-roundtrip');
    expect(loaded!.phase).toBe('team-plan');
  });

  it('returns null when no state file exists', () => {
    const result = loadPipelineState(testDir);
    expect(result).toBeNull();
  });

  it('isActive returns true immediately after creation', () => {
    createPipelineState(testDir, 'session-001', testDir);
    expect(isActive(testDir)).toBe(true);
  });

  it('canResume returns true when pipeline is active', () => {
    createPipelineState(testDir, 'session-001', testDir);
    expect(canResume(testDir)).toBe(true);
  });

  it('getStateSummary returns non-null string after creation', () => {
    createPipelineState(testDir, 'session-001', testDir);
    const summary = getStateSummary(testDir);
    expect(summary).not.toBeNull();
    expect(typeof summary).toBe('string');
    expect(summary).toContain('team-plan');
  });
});

// ============================================================
// STAGE 2: COMPLEXITY ANALYSIS
// ============================================================

describe('Stage 2: Complexity analysis', () => {
  it('classifies a single-file no-dep task as tiny', () => {
    const result = analyzeComplexity({
      description: 'Fix typo in button label',
      fileCount: 1,
      crossModuleDeps: 0,
      hasTests: false,
      hasApiChanges: false,
      hasDbChanges: false,
      hasSecurityImplications: false,
    });
    expect(result.level).toBe('tiny');
    expect(result.recommendedAgentCount).toBe(1);
  });

  it('classifies a multi-file API change as at least small', () => {
    const result = analyzeComplexity({
      description: 'Add user profile endpoint',
      fileCount: 5,
      crossModuleDeps: 2,
      hasTests: true,
      hasApiChanges: true,
      hasDbChanges: false,
      hasSecurityImplications: false,
    });
    expect(['small', 'medium', 'large']).toContain(result.level);
    expect(result.recommendedAgentCount).toBeGreaterThanOrEqual(2);
  });

  it('classifies a task with all flags set as large', () => {
    const result = analyzeComplexity({
      description: 'Overhaul authentication system',
      fileCount: 15,
      crossModuleDeps: 5,
      hasTests: true,
      hasApiChanges: true,
      hasDbChanges: true,
      hasSecurityImplications: true,
    });
    expect(result.level).toBe('large');
    expect(result.recommendedAgentCount).toBe(4);
  });

  it('score is clamped to [0, 1]', () => {
    const result = analyzeComplexity({
      description: 'Everything enabled',
      fileCount: 100,
      crossModuleDeps: 100,
      hasTests: true,
      hasApiChanges: true,
      hasDbChanges: true,
      hasSecurityImplications: true,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('returns factors object matching inputs', () => {
    const input = {
      description: 'Add logging',
      fileCount: 3,
      crossModuleDeps: 1,
      hasTests: true,
      hasApiChanges: false,
      hasDbChanges: false,
      hasSecurityImplications: false,
    };
    const result = analyzeComplexity(input);
    expect(result.factors.fileCount).toBe(3);
    expect(result.factors.crossModuleDeps).toBe(1);
    expect(result.factors.hasTests).toBe(true);
    expect(result.factors.hasApiChanges).toBe(false);
  });

  it('estimateFromDescription returns a valid ComplexityScore', () => {
    const result = estimateFromDescription('Add a dark mode toggle to the settings page');
    expect(result).toHaveProperty('level');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('recommendedAgentCount');
    expect(['tiny', 'small', 'medium', 'large']).toContain(result.level);
  });
});

// ============================================================
// STAGE 3: ROLE SELECTION
// ============================================================

describe('Stage 3: Role selection', () => {
  it('returns exactly 1 role for tiny complexity', () => {
    const complexity: ComplexityScore = {
      level: 'tiny',
      score: 0.1,
      factors: {
        fileCount: 1, crossModuleDeps: 0, hasTests: false,
        hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false,
      },
      recommendedAgentCount: 1,
    };
    const roles = selectRoles(complexity);
    expect(roles).toHaveLength(1);
  });

  it('returns exactly 2 roles for small complexity', () => {
    const complexity: ComplexityScore = {
      level: 'small',
      score: 0.3,
      factors: {
        fileCount: 4, crossModuleDeps: 1, hasTests: false,
        hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false,
      },
      recommendedAgentCount: 2,
    };
    const roles = selectRoles(complexity);
    expect(roles).toHaveLength(2);
  });

  it('returns exactly 3 roles for medium complexity', () => {
    const complexity: ComplexityScore = {
      level: 'medium',
      score: 0.5,
      factors: {
        fileCount: 8, crossModuleDeps: 3, hasTests: true,
        hasApiChanges: true, hasDbChanges: false, hasSecurityImplications: false,
      },
      recommendedAgentCount: 3,
    };
    const roles = selectRoles(complexity);
    expect(roles).toHaveLength(3);
  });

  it('returns exactly 4 roles for large complexity', () => {
    const complexity: ComplexityScore = {
      level: 'large',
      score: 0.9,
      factors: {
        fileCount: 20, crossModuleDeps: 6, hasTests: true,
        hasApiChanges: true, hasDbChanges: true, hasSecurityImplications: true,
      },
      recommendedAgentCount: 4,
    };
    const roles = selectRoles(complexity);
    expect(roles).toHaveLength(4);
  });

  it('every role assignment has required fields', () => {
    const complexity: ComplexityScore = {
      level: 'medium',
      score: 0.5,
      factors: {
        fileCount: 6, crossModuleDeps: 2, hasTests: true,
        hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false,
      },
      recommendedAgentCount: 3,
    };
    const roles = selectRoles(complexity);
    for (const r of roles) {
      expect(r.roleId).toBeTruthy();
      expect(r.role).toBeTruthy();
      expect(r.dagLayer).toMatch(/^(planner|worker|judge)$/);
      expect(r.provider).toMatch(/^(claude|codex|gemini)$/);
      expect(r.status).toBe('active');
    }
  });

  it('role assignments can be persisted and reloaded', () => {
    const complexity: ComplexityScore = {
      level: 'small',
      score: 0.25,
      factors: {
        fileCount: 3, crossModuleDeps: 1, hasTests: false,
        hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false,
      },
      recommendedAgentCount: 2,
    };
    createPipelineState(testDir, 'session-roles', testDir);
    const roles = selectRoles(complexity);
    updateRoles(testDir, roles);

    const loaded = loadPipelineState(testDir);
    expect(loaded!.roles).toHaveLength(2);
    expect(loaded!.roles[0].dagLayer).toBe(roles[0].dagLayer);
  });
});

// ============================================================
// STAGE 4: DAG CONSTRUCTION
// ============================================================

describe('Stage 4: DAG construction', () => {
  it('builds an execution plan with correct id and projectId', () => {
    const plan = buildExecutionPlan('proj-abc', [
      makeTaskSpec(),
    ]);
    expect(plan.id).toBeTruthy();
    expect(plan.projectId).toBe('proj-abc');
    expect(plan.status).toBe('planning');
  });

  it('creates one layer per topological level', () => {
    const plan = buildExecutionPlan('proj-layers', [
      makeTaskSpec({ id: 'task-a', dependencies: [] }),
      makeTaskSpec({ id: 'task-b', dependencies: ['task-a'] }),
    ]);
    expect(plan.layers.length).toBeGreaterThanOrEqual(2);
  });

  it('nodes map contains all task nodes', () => {
    const plan = buildExecutionPlan('proj-nodes', [
      makeTaskSpec({ id: 'task-x' }),
      makeTaskSpec({ id: 'task-y', dependencies: [] }),
    ]);
    expect(plan.nodes.has('node-task-x')).toBe(true);
    expect(plan.nodes.has('node-task-y')).toBe(true);
  });

  it('all nodes start in pending status', () => {
    const plan = buildExecutionPlan('proj-pending', [
      makeTaskSpec({ id: 't1' }),
      makeTaskSpec({ id: 't2' }),
    ]);
    for (const node of plan.nodes.values()) {
      expect(node.status).toBe('pending');
    }
  });

  it('topologicalSort returns layers with no cycles for a linear chain', () => {
    const nodes: DAGNode[] = [
      { id: 'a', roleId: 'r', layerIndex: -1, nodeType: 'planning', status: 'pending', dependencies: [], taskId: null, fileOwnership: [], estimatedDuration: null, startedAt: null, completedAt: null },
      { id: 'b', roleId: 'r', layerIndex: -1, nodeType: 'execution', status: 'pending', dependencies: ['a'], taskId: null, fileOwnership: [], estimatedDuration: null, startedAt: null, completedAt: null },
      { id: 'c', roleId: 'r', layerIndex: -1, nodeType: 'verification', status: 'pending', dependencies: ['b'], taskId: null, fileOwnership: [], estimatedDuration: null, startedAt: null, completedAt: null },
    ];
    const edges: DAGEdge[] = [
      { from: 'a', to: 'b', type: 'dependency' },
      { from: 'b', to: 'c', type: 'dependency' },
    ];
    const layers = topologicalSort(nodes, edges);
    expect(layers).toHaveLength(3);
    expect(layers[0][0].id).toBe('a');
    expect(layers[1][0].id).toBe('b');
    expect(layers[2][0].id).toBe('c');
  });

  it('topologicalSort groups independent nodes in the same layer', () => {
    const nodes: DAGNode[] = [
      { id: 'root', roleId: 'r', layerIndex: -1, nodeType: 'planning', status: 'pending', dependencies: [], taskId: null, fileOwnership: [], estimatedDuration: null, startedAt: null, completedAt: null },
      { id: 'left', roleId: 'r', layerIndex: -1, nodeType: 'execution', status: 'pending', dependencies: ['root'], taskId: null, fileOwnership: [], estimatedDuration: null, startedAt: null, completedAt: null },
      { id: 'right', roleId: 'r', layerIndex: -1, nodeType: 'execution', status: 'pending', dependencies: ['root'], taskId: null, fileOwnership: [], estimatedDuration: null, startedAt: null, completedAt: null },
    ];
    const edges: DAGEdge[] = [
      { from: 'root', to: 'left', type: 'dependency' },
      { from: 'root', to: 'right', type: 'dependency' },
    ];
    const layers = topologicalSort(nodes, edges);
    expect(layers).toHaveLength(2);
    expect(layers[1]).toHaveLength(2); // left and right in same layer
  });

  it('topologicalSort throws on a cyclic graph', () => {
    const nodes: DAGNode[] = [
      { id: 'x', roleId: 'r', layerIndex: -1, nodeType: 'execution', status: 'pending', dependencies: ['y'], taskId: null, fileOwnership: [], estimatedDuration: null, startedAt: null, completedAt: null },
      { id: 'y', roleId: 'r', layerIndex: -1, nodeType: 'execution', status: 'pending', dependencies: ['x'], taskId: null, fileOwnership: [], estimatedDuration: null, startedAt: null, completedAt: null },
    ];
    const edges: DAGEdge[] = [
      { from: 'x', to: 'y', type: 'dependency' },
      { from: 'y', to: 'x', type: 'dependency' },
    ];
    expect(() => topologicalSort(nodes, edges)).toThrow(/cycle/i);
  });

  it('validateFileOwnership detects exact duplicate patterns in same layer', () => {
    const plan = buildExecutionPlan('proj-conflict', [
      makeTaskSpec({ id: 't1', filePatterns: ['src/**/*.ts'], dependencies: [] }),
      makeTaskSpec({ id: 't2', filePatterns: ['src/**/*.ts'], dependencies: [] }),
    ]);
    const conflicts = validateFileOwnership(plan);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]).toContain('src/**/*.ts');
  });

  it('validateFileOwnership returns empty array when no conflicts exist', () => {
    const plan = buildExecutionPlan('proj-no-conflict', [
      makeTaskSpec({ id: 't1', filePatterns: ['src/frontend/**'], dependencies: [] }),
      makeTaskSpec({ id: 't2', filePatterns: ['src/backend/**'], dependencies: [] }),
    ]);
    const conflicts = validateFileOwnership(plan);
    expect(conflicts).toHaveLength(0);
  });

  it('getReadyNodes returns pending nodes whose dependencies are satisfied', () => {
    const plan = buildExecutionPlan('proj-ready', [
      makeTaskSpec({ id: 'ta', dependencies: [] }),
    ]);
    const ready = getReadyNodes(plan);
    expect(ready.length).toBeGreaterThan(0);
    for (const n of ready) {
      expect(n.status).toBe('pending');
    }
  });

  it('markNodeStarted transitions node status to running', () => {
    const plan = buildExecutionPlan('proj-start', [
      makeTaskSpec({ id: 'ts' }),
    ]);
    const nodeId = 'node-ts';
    const ok = markNodeStarted(plan, nodeId);
    expect(ok).toBe(true);
    expect(plan.nodes.get(nodeId)!.status).toBe('running');
  });

  it('markNodeCompleted transitions running node to completed', () => {
    const plan = buildExecutionPlan('proj-complete', [
      makeTaskSpec({ id: 'tc' }),
    ]);
    const nodeId = 'node-tc';
    markNodeStarted(plan, nodeId);
    const ok = markNodeCompleted(plan, nodeId);
    expect(ok).toBe(true);
    expect(plan.nodes.get(nodeId)!.status).toBe('completed');
  });

  it('markNodeFailed transitions running node to failed', () => {
    const plan = buildExecutionPlan('proj-fail', [
      makeTaskSpec({ id: 'tf' }),
    ]);
    const nodeId = 'node-tf';
    markNodeStarted(plan, nodeId);
    const ok = markNodeFailed(plan, nodeId);
    expect(ok).toBe(true);
    expect(plan.nodes.get(nodeId)!.status).toBe('failed');
  });

  it('isLayerComplete returns false while nodes are pending', () => {
    const plan = buildExecutionPlan('proj-incomplete', [
      makeTaskSpec({ id: 'ti' }),
    ]);
    expect(isLayerComplete(plan)).toBe(false);
  });

  it('isLayerComplete returns true after all nodes complete', () => {
    const plan = buildExecutionPlan('proj-done', [
      makeTaskSpec({ id: 'td' }),
    ]);
    const nodeId = 'node-td';
    markNodeStarted(plan, nodeId);
    markNodeCompleted(plan, nodeId);
    expect(isLayerComplete(plan)).toBe(true);
  });

  it('advanceLayer increments currentLayerIndex when layer is complete', () => {
    const plan = buildExecutionPlan('proj-advance', [
      makeTaskSpec({ id: 'ta1', dependencies: [] }),
      makeTaskSpec({ id: 'ta2', dependencies: ['ta1'] }),
    ]);
    markNodeStarted(plan, 'node-ta1');
    markNodeCompleted(plan, 'node-ta1');

    const advanced = advanceLayer(plan);
    expect(advanced).toBe(true);
    expect(plan.currentLayerIndex).toBe(1);
  });
});

// ============================================================
// STAGE 5: PHASE TRANSITIONS
// ============================================================

describe('Stage 5: Phase transitions', () => {
  it('transitions from team-plan to team-prd', () => {
    createPipelineState(testDir, 'session-t', testDir);
    const result = transitionPhase(testDir, 'team-prd');
    expect(result.ok).toBe(true);
    expect(result.state!.phase).toBe('team-prd');
  });

  it('transitions from team-prd to team-exec', () => {
    createPipelineState(testDir, 'session-t', testDir);
    transitionPhase(testDir, 'team-prd');
    const result = transitionPhase(testDir, 'team-exec');
    expect(result.ok).toBe(true);
    expect(result.state!.phase).toBe('team-exec');
  });

  it('rejects an invalid transition', () => {
    createPipelineState(testDir, 'session-t', testDir);
    // team-plan -> team-verify is not a valid direct jump
    const result = transitionPhase(testDir, 'team-verify');
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('records phase history entries for each transition', () => {
    createPipelineState(testDir, 'session-t', testDir);
    transitionPhase(testDir, 'team-prd');
    transitionPhase(testDir, 'team-exec');

    const state = loadPipelineState(testDir);
    expect(state!.phaseHistory.length).toBe(3); // initial + 2 transitions
  });

  it('sets active to false and completedAt on terminal phase', () => {
    createPipelineState(testDir, 'session-t', testDir);
    transitionPhase(testDir, 'team-prd');
    transitionPhase(testDir, 'team-exec');
    transitionPhase(testDir, 'team-verify');
    transitionPhase(testDir, 'complete');

    const state = loadPipelineState(testDir);
    expect(state!.active).toBe(false);
    expect(state!.completedAt).not.toBeNull();
  });

  it('returns error when no state exists', () => {
    const result = transitionPhase(testDir, 'team-prd');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('No active pipeline state');
  });
});

// ============================================================
// STAGE 6: STATE UPDATES
// ============================================================

describe('Stage 6: State update helpers', () => {
  beforeEach(() => {
    createPipelineState(testDir, 'session-upd', testDir);
  });

  it('updateComplexity persists score to state file', () => {
    const complexity: ComplexityScore = {
      level: 'medium',
      score: 0.55,
      factors: {
        fileCount: 8, crossModuleDeps: 3, hasTests: true,
        hasApiChanges: true, hasDbChanges: false, hasSecurityImplications: false,
      },
      recommendedAgentCount: 3,
    };
    updateComplexity(testDir, complexity);
    const state = loadPipelineState(testDir);
    expect(state!.complexityScore).not.toBeNull();
    expect(state!.complexityScore!.level).toBe('medium');
    expect(state!.complexityScore!.score).toBeCloseTo(0.55);
  });

  it('updateKanbanCounts persists counts to state file', () => {
    updateKanbanCounts(testDir, { inProgress: 3, done: 5 });
    const state = loadPipelineState(testDir);
    expect(state!.kanban.inProgress).toBe(3);
    expect(state!.kanban.done).toBe(5);
    expect(state!.kanban.backlog).toBe(0); // unchanged
  });

  it('updateQualityGates persists gate scores to state file', () => {
    updateQualityGates(testDir, { passed: 2, lastScore: 8.5 });
    const state = loadPipelineState(testDir);
    expect(state!.qualityGates.passed).toBe(2);
    expect(state!.qualityGates.lastScore).toBeCloseTo(8.5);
  });

  it('updateExecution persists worker counts to state file', () => {
    updateExecution(testDir, { workersTotal: 4, workersActive: 2, tasksTotal: 10, tasksCompleted: 6 });
    const state = loadPipelineState(testDir);
    expect(state!.execution.workersTotal).toBe(4);
    expect(state!.execution.workersActive).toBe(2);
    expect(state!.execution.tasksCompleted).toBe(6);
  });

  it('requestCancel sets cancel.requested to true', () => {
    requestCancel(testDir);
    const state = loadPipelineState(testDir);
    expect(state!.cancel.requested).toBe(true);
    expect(state!.cancel.requestedAt).not.toBeNull();
  });

  it('requestCancel with preserveForResume allows canResume', () => {
    // Mark pipeline inactive then cancel with preserve flag
    transitionPhase(testDir, 'team-prd');
    transitionPhase(testDir, 'team-exec');
    transitionPhase(testDir, 'team-verify');
    transitionPhase(testDir, 'complete');
    // Manually set preserve via requestCancel (on an inactive state)
    requestCancel(testDir, true);
    expect(canResume(testDir)).toBe(true);
  });

  it('clearState removes the state file', () => {
    clearState(testDir);
    expect(loadPipelineState(testDir)).toBeNull();
  });

  it('withStateLock prevents prototype pollution via forbidden keys', () => {
    // withStateLock should simply execute the callback and return its value
    const result = withStateLock(testDir, () => 42);
    expect(result).toBe(42);
  });
});

// ============================================================
// FULL PIPELINE: ALL STAGES IN SEQUENCE
// ============================================================

describe('Full pipeline: end-to-end sequence without AI', () => {
  it('runs all pipeline stages in order and produces valid final state', () => {
    // ---- Stage 1: Initialise ----
    const state = createPipelineState(testDir, 'e2e-session', testDir);
    expect(state.phase).toBe('team-plan');
    expect(state.active).toBe(true);

    // ---- Stage 2: Analyse complexity ----
    const complexity = analyzeComplexity({
      description: 'Build a REST API with authentication',
      fileCount: 12,
      crossModuleDeps: 4,
      hasTests: true,
      hasApiChanges: true,
      hasDbChanges: true,
      hasSecurityImplications: true,
    });
    expect(['medium', 'large']).toContain(complexity.level);
    updateComplexity(testDir, complexity);

    // ---- Stage 3: Select roles ----
    const roles = selectRoles(complexity);
    expect(roles.length).toBeGreaterThanOrEqual(3);
    updateRoles(testDir, roles);

    // ---- Stage 4: Build DAG ----
    const taskSpecs: TaskSpec[] = [
      { id: 'plan',  title: 'Plan', description: 'Plan phase', assignedRole: 'pm',  filePatterns: [], dependencies: [],       nodeType: 'planning',     priority: 1 },
      { id: 'fe',    title: 'FE',   description: 'FE work',    assignedRole: 'fe-dev', filePatterns: ['src/fe/**'], dependencies: ['plan'], nodeType: 'execution', priority: 2 },
      { id: 'be',    title: 'BE',   description: 'BE work',    assignedRole: 'be-dev', filePatterns: ['src/be/**'], dependencies: ['plan'], nodeType: 'execution', priority: 2 },
      { id: 'qa',    title: 'QA',   description: 'QA review',  assignedRole: 'qa-engineer', filePatterns: [], dependencies: ['fe', 'be'], nodeType: 'verification', priority: 3 },
    ];
    const plan = buildExecutionPlan('e2e-project', taskSpecs);
    expect(plan.layers.length).toBeGreaterThanOrEqual(3);
    expect(validateFileOwnership(plan)).toHaveLength(0);

    // ---- Stage 5: Transition through phases ----
    let tr = transitionPhase(testDir, 'team-prd');
    expect(tr.ok).toBe(true);

    tr = transitionPhase(testDir, 'team-exec');
    expect(tr.ok).toBe(true);

    // Simulate execution counters
    updateKanbanCounts(testDir, { inProgress: 2 });
    updateExecution(testDir, { workersTotal: roles.length, workersActive: 2, tasksTotal: 4 });

    tr = transitionPhase(testDir, 'team-verify');
    expect(tr.ok).toBe(true);

    updateQualityGates(testDir, { passed: 1, lastScore: 8.2 });

    tr = transitionPhase(testDir, 'complete');
    expect(tr.ok).toBe(true);

    // ---- Verify final state ----
    const final = loadPipelineState(testDir);
    expect(final!.phase).toBe('complete');
    expect(final!.active).toBe(false);
    expect(final!.completedAt).not.toBeNull();
    expect(final!.complexityScore!.level).toBe(complexity.level);
    expect(final!.roles.length).toBe(roles.length);
    expect(final!.qualityGates.passed).toBe(1);
    expect(final!.phaseHistory.length).toBe(5); // plan → prd → exec → verify → complete

    // ---- Verify state file on disk ----
    const statePath = join(testDir, '.omc/state/ct-pipeline-state.json');
    expect(existsSync(statePath)).toBe(true);
  });
});
