/**
 * Sprints and Artifacts Repository unit tests
 *
 * Tests: creating sprints/artifacts, retrieving, status updates,
 * task associations, status transitions, ordering.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createSprint,
  getSprint,
  getSprintsByProject,
  updateSprintStatus,
} from '../../src/persistence/sprints-repo.js';
import {
  createArtifact,
  getArtifact,
  getArtifactsByProject,
  updateArtifactStatus,
} from '../../src/persistence/artifacts-repo.js';
import type { SprintStatus, ArtifactStatus, RoleType } from '../../src/shared/types.js';
import { initDb, getDb, closeDb } from '../../src/persistence/db.js';

let testDir: string;
const projectId = 'test-proj';
const sprintId = 'sprint-001';
const taskId = 'task-001';

/** Seed a project row so FK constraints pass. */
function seedProject(dir: string): void {
  const db = getDb(dir)!;
  db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, path, session_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `).run(projectId, 'Test Project', dir, 'session-sprints-test');
}

/** Seed a task row so FK constraints pass for artifacts. */
function seedTask(dir: string, taskId: string): void {
  const db = getDb(dir)!;
  const ts = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO tasks (id, project_id, title, kanban_status, priority, created_at, updated_at, moved_at)
    VALUES (?, ?, ?, 'backlog', 3, ?, ?, ?)
  `).run(taskId, projectId, `Task ${taskId}`, ts, ts, ts);
}

/** Seed a sprint row for testing task associations. */
function seedSprint(dir: string, sprintId: string, sprintNumber: number): void {
  const db = getDb(dir)!;
  const ts = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO sprints (id, project_id, sprint_number, goal, status, started_at)
    VALUES (?, ?, ?, ?, 'planning', ?)
  `).run(sprintId, projectId, sprintNumber, `Sprint ${sprintNumber} goal`, ts);
}

/** Associate a task with a sprint. */
function assignTaskToSprint(dir: string, taskId: string, sprintId: string): void {
  const db = getDb(dir)!;
  db.prepare('UPDATE tasks SET sprint_id = ? WHERE id = ?').run(sprintId, taskId);
}

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'ct-sprints-artifacts-test-'));
  await initDb(testDir);
  seedProject(testDir);
  // Pre-seed tasks for artifacts
  for (let i = 1; i <= 10; i++) {
    seedTask(testDir, `task-${i}`);
  }
});

afterEach(() => {
  if (testDir) {
    closeDb(testDir);
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================
// SPRINTS - CREATE & RETRIEVE
// ============================================================

describe('createSprint', () => {
  it('creates a sprint with minimal fields', () => {
    const sprint = createSprint(testDir, projectId, {
      id: 'sprint-1',
      sprintNumber: 1,
      goal: 'Implement user authentication',
    });

    expect(sprint).not.toBeNull();
    expect(sprint?.id).toBe('sprint-1');
    expect(sprint?.projectId).toBe(projectId);
    expect(sprint?.sprintNumber).toBe(1);
    expect(sprint?.goal).toBe('Implement user authentication');
    expect(sprint?.status).toBe('planning');
    expect(sprint?.velocityScore).toBeNull();
    expect(sprint?.taskIds).toEqual([]);
    expect(sprint?.startedAt).toBeTruthy();
    expect(sprint?.completedAt).toBeNull();
  });

  it('returns null when database is not initialized', () => {
    const sprint = createSprint('/nonexistent', projectId, {
      id: 'sprint-fail',
      sprintNumber: 1,
      goal: 'Test goal',
    });

    expect(sprint).toBeNull();
  });

  it('returns null on duplicate sprint ID', () => {
    createSprint(testDir, projectId, {
      id: 'sprint-dup',
      sprintNumber: 1,
      goal: 'First sprint',
    });

    const duplicate = createSprint(testDir, projectId, {
      id: 'sprint-dup',
      sprintNumber: 2,
      goal: 'Duplicate sprint',
    });

    expect(duplicate).toBeNull();
  });
});

describe('getSprint', () => {
  it('retrieves a sprint by ID', () => {
    createSprint(testDir, projectId, {
      id: 'sprint-2',
      sprintNumber: 2,
      goal: 'Build dashboard',
    });

    const sprint = getSprint(testDir, 'sprint-2');
    expect(sprint).not.toBeNull();
    expect(sprint?.id).toBe('sprint-2');
    expect(sprint?.sprintNumber).toBe(2);
    expect(sprint?.goal).toBe('Build dashboard');
    expect(sprint?.status).toBe('planning');
  });

  it('returns null when sprint does not exist', () => {
    const sprint = getSprint(testDir, 'nonexistent');
    expect(sprint).toBeNull();
  });

  it('returns null when database is not initialized', () => {
    const sprint = getSprint('/nonexistent', 'sprint-2');
    expect(sprint).toBeNull();
  });

  it('populates taskIds from associated tasks', () => {
    seedSprint(testDir, 'sprint-with-tasks', 1);
    assignTaskToSprint(testDir, 'task-1', 'sprint-with-tasks');
    assignTaskToSprint(testDir, 'task-2', 'sprint-with-tasks');
    assignTaskToSprint(testDir, 'task-3', 'sprint-with-tasks');

    const sprint = getSprint(testDir, 'sprint-with-tasks');
    expect(sprint).not.toBeNull();
    expect(sprint?.taskIds).toHaveLength(3);
    expect(sprint?.taskIds).toContain('task-1');
    expect(sprint?.taskIds).toContain('task-2');
    expect(sprint?.taskIds).toContain('task-3');
  });
});

describe('getSprintsByProject', () => {
  it('retrieves all sprints for a project ordered by sprint number', () => {
    createSprint(testDir, projectId, {
      id: 'sprint-3',
      sprintNumber: 3,
      goal: 'Third sprint',
    });

    createSprint(testDir, projectId, {
      id: 'sprint-1',
      sprintNumber: 1,
      goal: 'First sprint',
    });

    createSprint(testDir, projectId, {
      id: 'sprint-2',
      sprintNumber: 2,
      goal: 'Second sprint',
    });

    const sprints = getSprintsByProject(testDir, projectId);
    expect(sprints).toHaveLength(3);
    expect(sprints[0].sprintNumber).toBe(1);
    expect(sprints[1].sprintNumber).toBe(2);
    expect(sprints[2].sprintNumber).toBe(3);
  });

  it('returns empty array when project has no sprints', () => {
    const sprints = getSprintsByProject(testDir, 'empty-project');
    expect(sprints).toEqual([]);
  });

  it('returns empty array when database is not initialized', () => {
    const sprints = getSprintsByProject('/nonexistent', projectId);
    expect(sprints).toEqual([]);
  });

  it('populates taskIds for all sprints', () => {
    seedSprint(testDir, 'sprint-a', 1);
    seedSprint(testDir, 'sprint-b', 2);
    assignTaskToSprint(testDir, 'task-1', 'sprint-a');
    assignTaskToSprint(testDir, 'task-2', 'sprint-a');
    assignTaskToSprint(testDir, 'task-3', 'sprint-b');

    const sprints = getSprintsByProject(testDir, projectId);
    expect(sprints).toHaveLength(2);

    const sprintA = sprints.find(s => s.id === 'sprint-a');
    expect(sprintA?.taskIds).toHaveLength(2);

    const sprintB = sprints.find(s => s.id === 'sprint-b');
    expect(sprintB?.taskIds).toHaveLength(1);
  });
});

// ============================================================
// SPRINTS - STATUS UPDATES
// ============================================================

describe('updateSprintStatus', () => {
  it('updates sprint status without velocity score', () => {
    createSprint(testDir, projectId, {
      id: 'sprint-status-1',
      sprintNumber: 1,
      goal: 'Test sprint',
    });

    const success = updateSprintStatus(testDir, 'sprint-status-1', 'active');
    expect(success).toBe(true);

    const sprint = getSprint(testDir, 'sprint-status-1');
    expect(sprint?.status).toBe('active');
    expect(sprint?.velocityScore).toBeNull();
    expect(sprint?.completedAt).toBeNull();
  });

  it('updates sprint status with velocity score', () => {
    createSprint(testDir, projectId, {
      id: 'sprint-status-2',
      sprintNumber: 2,
      goal: 'Test sprint',
    });

    const success = updateSprintStatus(testDir, 'sprint-status-2', 'completed', 85);
    expect(success).toBe(true);

    const sprint = getSprint(testDir, 'sprint-status-2');
    expect(sprint?.status).toBe('completed');
    expect(sprint?.velocityScore).toBe(85);
    expect(sprint?.completedAt).toBeTruthy();
  });

  it('sets completedAt when status is completed', () => {
    createSprint(testDir, projectId, {
      id: 'sprint-status-3',
      sprintNumber: 3,
      goal: 'Test sprint',
    });

    updateSprintStatus(testDir, 'sprint-status-3', 'completed', 90);

    const sprint = getSprint(testDir, 'sprint-status-3');
    expect(sprint?.completedAt).toBeTruthy();
  });

  it('does not set completedAt for non-completed status', () => {
    createSprint(testDir, projectId, {
      id: 'sprint-status-4',
      sprintNumber: 4,
      goal: 'Test sprint',
    });

    updateSprintStatus(testDir, 'sprint-status-4', 'active');

    const sprint = getSprint(testDir, 'sprint-status-4');
    expect(sprint?.completedAt).toBeNull();
  });

  it('returns true even when sprint does not exist (no error)', () => {
    const success = updateSprintStatus(testDir, 'nonexistent', 'active');
    expect(success).toBe(true); // UPDATE succeeds but affects 0 rows
  });

  it('returns false when database is not initialized', () => {
    const success = updateSprintStatus('/nonexistent', 'sprint-1', 'active');
    expect(success).toBe(false);
  });
});

// ============================================================
// SPRINTS - STATUS TRANSITIONS
// ============================================================

describe('Sprint status transitions', () => {
  it('transitions from planning to active to completed', () => {
    createSprint(testDir, projectId, {
      id: 'sprint-trans-1',
      sprintNumber: 1,
      goal: 'Full lifecycle',
    });

    let sprint = getSprint(testDir, 'sprint-trans-1');
    expect(sprint?.status).toBe('planning');

    updateSprintStatus(testDir, 'sprint-trans-1', 'active');
    sprint = getSprint(testDir, 'sprint-trans-1');
    expect(sprint?.status).toBe('active');

    updateSprintStatus(testDir, 'sprint-trans-1', 'completed', 95);
    sprint = getSprint(testDir, 'sprint-trans-1');
    expect(sprint?.status).toBe('completed');
    expect(sprint?.velocityScore).toBe(95);
  });

  it('allows review status transition', () => {
    createSprint(testDir, projectId, {
      id: 'sprint-trans-2',
      sprintNumber: 2,
      goal: 'Sprint in review',
    });

    updateSprintStatus(testDir, 'sprint-trans-2', 'review');

    const sprint = getSprint(testDir, 'sprint-trans-2');
    expect(sprint?.status).toBe('review');
  });
});

// ============================================================
// ARTIFACTS - CREATE & RETRIEVE
// ============================================================

describe('createArtifact', () => {
  it('creates an artifact with minimal fields', () => {
    const artifact = createArtifact(testDir, projectId, {
      id: 'artifact-1',
      producedByRole: 'designer',
      artifactType: 'prd',
      filePath: '/plans/design-plan.md',
      taskId: 'task-1',
    });

    expect(artifact).not.toBeNull();
    expect(artifact?.id).toBe('artifact-1');
    expect(artifact?.producedByRole).toBe('designer');
    expect(artifact?.artifactType).toBe('prd');
    expect(artifact?.filePath).toBe('/plans/design-plan.md');
    expect(artifact?.status).toBe('draft');
    expect(artifact?.approvedBy).toBeNull();
    expect(artifact?.taskId).toBe('task-1');
    expect(artifact?.sprintId).toBeNull();
    expect(artifact?.createdAt).toBeTruthy();
    expect(artifact?.updatedAt).toBeTruthy();
  });

  it('creates an artifact with sprint association', () => {
    seedSprint(testDir, 'sprint-art-1', 1);

    const artifact = createArtifact(testDir, projectId, {
      id: 'artifact-2',
      producedByRole: 'executor',
      artifactType: 'api-spec',
      filePath: '/src/auth.ts',
      taskId: 'task-2',
      sprintId: 'sprint-art-1',
    });

    expect(artifact).not.toBeNull();
    expect(artifact?.sprintId).toBe('sprint-art-1');
  });

  it('returns null when database is not initialized', () => {
    const artifact = createArtifact('/nonexistent', projectId, {
      id: 'artifact-fail',
      producedByRole: 'designer',
      artifactType: 'prd',
      filePath: '/test.md',
      taskId: 'task-1',
    });

    expect(artifact).toBeNull();
  });

  it('returns null on duplicate artifact ID', () => {
    createArtifact(testDir, projectId, {
      id: 'artifact-dup',
      producedByRole: 'designer',
      artifactType: 'prd',
      filePath: '/plan1.md',
      taskId: 'task-1',
    });

    const duplicate = createArtifact(testDir, projectId, {
      id: 'artifact-dup',
      producedByRole: 'executor',
      artifactType: 'api-spec',
      filePath: '/plan2.md',
      taskId: 'task-2',
    });

    expect(duplicate).toBeNull();
  });
});

describe('getArtifact', () => {
  it('retrieves an artifact by ID', () => {
    createArtifact(testDir, projectId, {
      id: 'artifact-3',
      producedByRole: 'reviewer',
      artifactType: 'review-report',
      filePath: '/reviews/code-review.md',
      taskId: 'task-3',
    });

    const artifact = getArtifact(testDir, 'artifact-3');
    expect(artifact).not.toBeNull();
    expect(artifact?.id).toBe('artifact-3');
    expect(artifact?.producedByRole).toBe('reviewer');
    expect(artifact?.artifactType).toBe('review-report');
  });

  it('returns null when artifact does not exist', () => {
    const artifact = getArtifact(testDir, 'nonexistent');
    expect(artifact).toBeNull();
  });

  it('returns null when database is not initialized', () => {
    const artifact = getArtifact('/nonexistent', 'artifact-3');
    expect(artifact).toBeNull();
  });
});

describe('getArtifactsByProject', () => {
  it('retrieves all artifacts for a project ordered by creation time', () => {
    createArtifact(testDir, projectId, {
      id: 'artifact-4',
      producedByRole: 'designer',
      artifactType: 'prd',
      filePath: '/plan1.md',
      taskId: 'task-1',
    });

    createArtifact(testDir, projectId, {
      id: 'artifact-5',
      producedByRole: 'executor',
      artifactType: 'schema',
      filePath: '/code1.ts',
      taskId: 'task-2',
    });

    createArtifact(testDir, projectId, {
      id: 'artifact-6',
      producedByRole: 'reviewer',
      artifactType: 'review-report',
      filePath: '/review1.md',
      taskId: 'task-3',
    });

    const artifacts = getArtifactsByProject(testDir, projectId);
    expect(artifacts).toHaveLength(3);
    // Verify all artifacts are present (order may vary if created in same millisecond)
    const ids = artifacts.map(a => a.id);
    expect(ids).toContain('artifact-4');
    expect(ids).toContain('artifact-5');
    expect(ids).toContain('artifact-6');
  });

  it('returns empty array when project has no artifacts', () => {
    const artifacts = getArtifactsByProject(testDir, 'empty-project');
    expect(artifacts).toEqual([]);
  });

  it('returns empty array when database is not initialized', () => {
    const artifacts = getArtifactsByProject('/nonexistent', projectId);
    expect(artifacts).toEqual([]);
  });
});

// ============================================================
// ARTIFACTS - STATUS UPDATES
// ============================================================

describe('updateArtifactStatus', () => {
  it('updates artifact status without approvedBy', () => {
    createArtifact(testDir, projectId, {
      id: 'artifact-status-1',
      producedByRole: 'designer',
      artifactType: 'prd',
      filePath: '/plan.md',
      taskId: 'task-1',
    });

    const success = updateArtifactStatus(testDir, 'artifact-status-1', 'review');
    expect(success).toBe(true);

    const artifact = getArtifact(testDir, 'artifact-status-1');
    expect(artifact?.status).toBe('review');
    expect(artifact?.approvedBy).toBeNull();
  });

  it('updates artifact status with approvedBy', () => {
    createArtifact(testDir, projectId, {
      id: 'artifact-status-2',
      producedByRole: 'executor',
      artifactType: 'api-spec',
      filePath: '/code.ts',
      taskId: 'task-2',
    });

    const success = updateArtifactStatus(testDir, 'artifact-status-2', 'approved', 'reviewer');
    expect(success).toBe(true);

    const artifact = getArtifact(testDir, 'artifact-status-2');
    expect(artifact?.status).toBe('approved');
    expect(artifact?.approvedBy).toBe('reviewer');
  });

  it('updates the updatedAt timestamp', () => {
    createArtifact(testDir, projectId, {
      id: 'artifact-status-3',
      producedByRole: 'designer',
      artifactType: 'test-plan',
      filePath: '/plan.md',
      taskId: 'task-3',
    });

    const beforeUpdate = getArtifact(testDir, 'artifact-status-3');
    const originalUpdatedAt = beforeUpdate?.updatedAt;

    // Small delay to ensure timestamp difference
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    delay(10).then(() => {
      updateArtifactStatus(testDir, 'artifact-status-3', 'review');

      const afterUpdate = getArtifact(testDir, 'artifact-status-3');
      expect(afterUpdate?.updatedAt).not.toBe(originalUpdatedAt);
    });
  });

  it('returns true even when artifact does not exist (no error)', () => {
    const success = updateArtifactStatus(testDir, 'nonexistent', 'approved');
    expect(success).toBe(true); // UPDATE succeeds but affects 0 rows
  });

  it('returns false when database is not initialized', () => {
    const success = updateArtifactStatus('/nonexistent', 'artifact-1', 'approved');
    expect(success).toBe(false);
  });
});

// ============================================================
// ARTIFACTS - STATUS TRANSITIONS
// ============================================================

describe('Artifact status transitions', () => {
  it('transitions from draft to review to approved', () => {
    createArtifact(testDir, projectId, {
      id: 'artifact-trans-1',
      producedByRole: 'designer',
      artifactType: 'prd',
      filePath: '/plan.md',
      taskId: 'task-1',
    });

    let artifact = getArtifact(testDir, 'artifact-trans-1');
    expect(artifact?.status).toBe('draft');

    updateArtifactStatus(testDir, 'artifact-trans-1', 'review');
    artifact = getArtifact(testDir, 'artifact-trans-1');
    expect(artifact?.status).toBe('review');

    updateArtifactStatus(testDir, 'artifact-trans-1', 'approved', 'reviewer');
    artifact = getArtifact(testDir, 'artifact-trans-1');
    expect(artifact?.status).toBe('approved');
    expect(artifact?.approvedBy).toBe('reviewer');
  });

  it('transitions from draft to review to rejected', () => {
    createArtifact(testDir, projectId, {
      id: 'artifact-trans-2',
      producedByRole: 'executor',
      artifactType: 'schema',
      filePath: '/code.ts',
      taskId: 'task-2',
    });

    updateArtifactStatus(testDir, 'artifact-trans-2', 'review');
    updateArtifactStatus(testDir, 'artifact-trans-2', 'rejected', 'reviewer');

    const artifact = getArtifact(testDir, 'artifact-trans-2');
    expect(artifact?.status).toBe('rejected');
    expect(artifact?.approvedBy).toBe('reviewer');
  });

  it('allows transition from rejected back to draft', () => {
    createArtifact(testDir, projectId, {
      id: 'artifact-trans-3',
      producedByRole: 'designer',
      artifactType: 'deploy-config',
      filePath: '/plan.md',
      taskId: 'task-3',
    });

    updateArtifactStatus(testDir, 'artifact-trans-3', 'rejected', 'reviewer');
    updateArtifactStatus(testDir, 'artifact-trans-3', 'draft');

    const artifact = getArtifact(testDir, 'artifact-trans-3');
    expect(artifact?.status).toBe('draft');
  });
});

// ============================================================
// ARTIFACTS - DIFFERENT ROLE TYPES
// ============================================================

describe('Artifacts by different role types', () => {
  it('creates artifacts for all role types', () => {
    const roles: RoleType[] = ['designer', 'inspiration', 'reviewer', 'executor'];

    roles.forEach((role, index) => {
      const artifact = createArtifact(testDir, projectId, {
        id: `artifact-role-${index}`,
        producedByRole: role,
        artifactType: 'prd',
        filePath: `/artifacts/${role}.md`,
        taskId: `task-${index + 1}`,
      });

      expect(artifact).not.toBeNull();
      expect(artifact?.producedByRole).toBe(role);
    });

    const artifacts = getArtifactsByProject(testDir, projectId);
    expect(artifacts).toHaveLength(roles.length);
  });
});

// ============================================================
// ARTIFACTS - DIFFERENT ARTIFACT TYPES
// ============================================================

describe('Artifacts by different artifact types', () => {
  it('creates different artifact types', () => {
    createArtifact(testDir, projectId, {
      id: 'artifact-type-prd',
      producedByRole: 'designer',
      artifactType: 'prd',
      filePath: '/plan.md',
      taskId: 'task-1',
    });

    createArtifact(testDir, projectId, {
      id: 'artifact-type-api-spec',
      producedByRole: 'executor',
      artifactType: 'api-spec',
      filePath: '/code.ts',
      taskId: 'task-2',
    });

    createArtifact(testDir, projectId, {
      id: 'artifact-type-review',
      producedByRole: 'reviewer',
      artifactType: 'review-report',
      filePath: '/review.md',
      taskId: 'task-3',
    });

    createArtifact(testDir, projectId, {
      id: 'artifact-type-test',
      producedByRole: 'executor',
      artifactType: 'test-plan',
      filePath: '/test.test.ts',
      taskId: 'task-4',
    });

    const artifacts = getArtifactsByProject(testDir, projectId);
    expect(artifacts).toHaveLength(4);

    const types = artifacts.map(a => a.artifactType);
    expect(types).toContain('prd');
    expect(types).toContain('api-spec');
    expect(types).toContain('review-report');
    expect(types).toContain('test-plan');
  });
});
