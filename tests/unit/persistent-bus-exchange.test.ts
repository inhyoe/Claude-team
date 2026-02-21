/**
 * PersistentMessageBus and Artifact Exchange unit tests
 *
 * Tests: message validation, send/poll/ack, permissions, broadcast,
 * artifact production/reading, status updates, review artifacts, filtering.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PersistentMessageBus,
  createPersistentBus,
  buildTeamMessage,
} from '../../src/communication/persistent-bus.js';
import {
  getArtifactsDir,
  getTaskArtifactDir,
  produceArtifact,
  readArtifactContent,
  listTaskArtifactFiles,
  approveArtifact,
  rejectArtifact,
  submitForReview,
  produceReviewArtifact,
  getProjectArtifacts,
} from '../../src/communication/artifact-exchange.js';
import type { TeamMessage, RoleType } from '../../src/shared/types.js';
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
  `).run(projectId, 'Test Project', dir, 'session-bus-test');
}

/** Seed a task row so FK constraints pass for artifacts. */
function seedTask(dir: string, tid: string): void {
  const db = getDb(dir)!;
  const ts = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO tasks (id, project_id, title, kanban_status, priority, created_at, updated_at, moved_at)
    VALUES (?, ?, ?, 'backlog', 3, ?, ?, ?)
  `).run(tid, projectId, `Task ${tid}`, ts, ts, ts);
}

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'ct-bus-exchange-test-'));
  await initDb(testDir);
  seedProject(testDir);
  seedTask(testDir, taskId);
  seedTask(testDir, 'task-002');
  seedTask(testDir, 'task-003');
});

afterEach(() => {
  if (testDir) {
    closeDb(testDir);
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================
// PERSISTENT MESSAGE BUS - SEND & VALIDATION
// ============================================================

describe('PersistentMessageBus - send', () => {
  it('sends a valid message and returns queued=true', async () => {
    const bus = new PersistentMessageBus(testDir, projectId);
    const message = buildTeamMessage(
      'pm',
      'fe-dev',
      'task_assignment',
      JSON.stringify({ taskId, subject: 'Build UI', description: 'Create login form', fileOwnership: [] })
    );

    const result = await bus.send(message);

    expect(result.queued).toBe(true);
    expect(result.messageId).not.toBeNull();
    expect(result.error).toBeUndefined();
  });

  it('sends a valid status_report message', async () => {
    const bus = new PersistentMessageBus(testDir, projectId);
    const message = buildTeamMessage(
      'fe-dev',
      'pm',
      'status_report',
      JSON.stringify({ taskId, status: 'in-progress', progress: 50, summary: 'Working on it' })
    );

    const result = await bus.send(message);

    expect(result.queued).toBe(true);
    expect(result.messageId).not.toBeNull();
  });

  it('rejects message with missing required fields', async () => {
    const bus = new PersistentMessageBus(testDir, projectId);
    const message = buildTeamMessage(
      'pm',
      'fe-dev',
      'task_assignment',
      JSON.stringify({ taskId }) // missing subject, description
    );

    const result = await bus.send(message);

    expect(result.queued).toBe(false);
    expect(result.messageId).toBeNull();
    expect(result.error).toContain('Validation failed');
  });

  it('rejects message when sender lacks send permission', async () => {
    const bus = new PersistentMessageBus(testDir, projectId);
    const message = buildTeamMessage(
      'fe-dev', // fe-dev cannot send task_assignment
      'be-dev',
      'task_assignment',
      JSON.stringify({ taskId, subject: 'Test', description: 'Test', fileOwnership: [] })
    );

    const result = await bus.send(message);

    expect(result.queued).toBe(false);
    expect(result.messageId).toBeNull();
    expect(result.error).toContain('cannot send');
  });

  it('rejects message when receiver lacks receive permission', async () => {
    const bus = new PersistentMessageBus(testDir, projectId);
    const message = buildTeamMessage(
      'pm',
      'pm', // pm cannot receive task_assignment
      'task_assignment',
      JSON.stringify({ taskId, subject: 'Test', description: 'Test', fileOwnership: [] })
    );

    const result = await bus.send(message);

    expect(result.queued).toBe(false);
    expect(result.messageId).toBeNull();
    expect(result.error).toContain('cannot receive');
  });
});

// ============================================================
// PERSISTENT MESSAGE BUS - POLL & ACK
// ============================================================

describe('PersistentMessageBus - poll', () => {
  it('polls messages and returns TeamMessage format', async () => {
    const bus = new PersistentMessageBus(testDir, projectId);
    const message = buildTeamMessage(
      'pm',
      'fe-dev',
      'task_assignment',
      JSON.stringify({ taskId, subject: 'Build UI', description: 'Create login form', fileOwnership: [] })
    );
    await bus.send(message);

    const messages = await bus.poll('fe-dev');

    expect(messages).toHaveLength(1);
    expect(messages[0].fromRole).toBe('pm');
    expect(messages[0].toRole).toBe('fe-dev');
    expect(messages[0].messageType).toBe('task_assignment');
    expect(messages[0].id).toContain('msg-');
  });

  it('returns empty array when no messages', async () => {
    const bus = new PersistentMessageBus(testDir, projectId);

    const messages = await bus.poll('fe-dev');

    expect(messages).toEqual([]);
  });

  it('respects limit parameter', async () => {
    const bus = new PersistentMessageBus(testDir, projectId);

    // Send 3 messages
    for (let i = 0; i < 3; i++) {
      const message = buildTeamMessage(
        'pm',
        'fe-dev',
        'task_assignment',
        JSON.stringify({ taskId: `task-${i}`, subject: `Task ${i}`, description: 'Test', fileOwnership: [] })
      );
      await bus.send(message);
    }

    const messages = await bus.poll('fe-dev', 2);

    expect(messages).toHaveLength(2);
  });
});

describe('PersistentMessageBus - ack', () => {
  it('acknowledges a message by ID', async () => {
    const bus = new PersistentMessageBus(testDir, projectId);
    const message = buildTeamMessage(
      'pm',
      'fe-dev',
      'task_assignment',
      JSON.stringify({ taskId, subject: 'Build UI', description: 'Create login form', fileOwnership: [] })
    );
    const result = await bus.send(message);

    await bus.ack(result.messageId!);

    // Message should be acknowledged in DB
    const pending = await bus.pending('fe-dev');
    expect(pending).toBe(0);
  });

  it('acknowledges all messages for a role', async () => {
    const bus = new PersistentMessageBus(testDir, projectId);

    // Send 2 messages
    for (let i = 0; i < 2; i++) {
      const message = buildTeamMessage(
        'pm',
        'fe-dev',
        'task_assignment',
        JSON.stringify({ taskId: `task-${i}`, subject: `Task ${i}`, description: 'Test', fileOwnership: [] })
      );
      await bus.send(message);
    }

    // Poll messages first to mark them as delivered
    await bus.poll('fe-dev');

    await bus.ackAll('fe-dev');

    const pending = await bus.pending('fe-dev');
    expect(pending).toBe(0);
  });
});

describe('PersistentMessageBus - pending', () => {
  it('returns count of pending messages', async () => {
    const bus = new PersistentMessageBus(testDir, projectId);
    const message = buildTeamMessage(
      'pm',
      'fe-dev',
      'task_assignment',
      JSON.stringify({ taskId, subject: 'Build UI', description: 'Create login form', fileOwnership: [] })
    );
    await bus.send(message);

    const count = await bus.pending('fe-dev');

    expect(count).toBe(1);
  });

  it('returns 0 when no pending messages', async () => {
    const bus = new PersistentMessageBus(testDir, projectId);

    const count = await bus.pending('fe-dev');

    expect(count).toBe(0);
  });
});

// ============================================================
// PERSISTENT MESSAGE BUS - BROADCAST & CLEANUP
// ============================================================

describe('PersistentMessageBus - broadcast', () => {
  it('broadcasts to multiple roles with receive permission', async () => {
    const bus = new PersistentMessageBus(testDir, projectId);
    const message = {
      id: 'msg-broadcast',
      fromRole: 'pm' as RoleType,
      messageType: 'escalation' as const,
      channel: 'broadcast' as const,
      content: JSON.stringify({ taskId, severity: 'high', reason: 'Critical issue', context: {} }),
      metadata: {},
      timestamp: new Date().toISOString(),
    };

    await bus.broadcast(message, ['pl', 'pm']);

    // Only pl should receive (pm cannot receive escalation)
    const plMessages = await bus.poll('pl');
    const pmMessages = await bus.poll('pm');

    expect(plMessages).toHaveLength(1);
    expect(pmMessages).toHaveLength(1); // pm can receive escalation
  });

  it('filters out roles without receive permission', async () => {
    const bus = new PersistentMessageBus(testDir, projectId);
    const message = {
      id: 'msg-broadcast-2',
      fromRole: 'pm' as RoleType,
      messageType: 'task_assignment' as const,
      channel: 'broadcast' as const,
      content: JSON.stringify({ taskId, subject: 'Test', description: 'Test', fileOwnership: [] }),
      metadata: {},
      timestamp: new Date().toISOString(),
    };

    await bus.broadcast(message, ['fe-dev', 'pm']); // pm cannot receive task_assignment

    const feMessages = await bus.poll('fe-dev');
    const pmMessages = await bus.poll('pm');

    expect(feMessages).toHaveLength(1);
    expect(pmMessages).toHaveLength(0); // filtered out
  });
});

describe('PersistentMessageBus - cleanup', () => {
  it('returns count of expired messages', async () => {
    const bus = new PersistentMessageBus(testDir, projectId);

    const count = await bus.cleanup();

    expect(count).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================
// PERSISTENT MESSAGE BUS - HELPERS
// ============================================================

describe('buildTeamMessage', () => {
  it('builds a valid TeamMessage', () => {
    const message = buildTeamMessage(
      'pm',
      'fe-dev',
      'task_assignment',
      'test content'
    );

    expect(message.fromRole).toBe('pm');
    expect(message.toRole).toBe('fe-dev');
    expect(message.messageType).toBe('task_assignment');
    expect(message.content).toBe('test content');
    expect(message.channel).toBe('dm');
    expect(message.id).toContain('msg-');
  });

  it('builds a TeamMessage with custom channel and metadata', () => {
    const message = buildTeamMessage(
      'fe-dev',
      'pm',
      'status_report',
      'progress update',
      'broadcast',
      { taskId: 'task-123' }
    );

    expect(message.channel).toBe('broadcast');
    expect(message.metadata).toEqual({ taskId: 'task-123' });
  });
});

describe('createPersistentBus', () => {
  it('creates a PersistentMessageBus instance', () => {
    const bus = createPersistentBus(testDir, projectId);

    expect(bus).toBeInstanceOf(PersistentMessageBus);
  });
});

// ============================================================
// ARTIFACT EXCHANGE - PATH HELPERS
// ============================================================

describe('getArtifactsDir', () => {
  it('returns correct artifacts directory path', () => {
    const dir = getArtifactsDir(testDir);

    expect(dir).toBe(join(testDir, '.omc/artifacts'));
  });
});

describe('getTaskArtifactDir', () => {
  it('returns correct task artifact directory path', () => {
    const dir = getTaskArtifactDir(testDir, sprintId, taskId);

    expect(dir).toBe(join(testDir, '.omc/artifacts', sprintId, taskId));
  });

  it('sanitizes path components to prevent traversal', () => {
    // After sanitization removes .. and /, empty or invalid strings should fail
    // Using only slashes results in empty string after sanitization
    expect(() => {
      getTaskArtifactDir(testDir, '///', taskId);
    }).toThrow('Invalid path component');
  });

  it('blocks invalid characters in components', () => {
    expect(() => {
      getTaskArtifactDir(testDir, 'sprint@invalid', taskId);
    }).toThrow('Invalid path component');
  });
});

// ============================================================
// ARTIFACT EXCHANGE - PRODUCE & READ
// ============================================================

describe('produceArtifact', () => {
  it('creates file on disk', () => {
    const artifact = produceArtifact({
      cwd: testDir,
      projectId,
      taskId,
      sprintId,
      producedBy: 'pm',
      artifactType: 'prd',
      content: '# Product Requirements\n\nBuild a login form.',
    });

    const filePath = join(testDir, artifact.filePath);
    expect(existsSync(filePath)).toBe(true);
  });

  it('registers artifact in DB', () => {
    const artifact = produceArtifact({
      cwd: testDir,
      projectId,
      taskId,
      sprintId,
      producedBy: 'pm',
      artifactType: 'prd',
      content: 'PRD content',
    });

    expect(artifact.id).toContain('art-');
    expect(artifact.producedByRole).toBe('pm');
    expect(artifact.artifactType).toBe('prd');
    expect(artifact.status).toBe('draft');
  });

  it('uses custom filename when provided', () => {
    const artifact = produceArtifact({
      cwd: testDir,
      projectId,
      taskId,
      sprintId,
      producedBy: 'be-dev',
      artifactType: 'api-spec',
      content: 'openapi: 3.0.0',
      filename: 'custom-api.yaml',
    });

    expect(artifact.filePath).toContain('custom-api.yaml');
    const filePath = join(testDir, artifact.filePath);
    expect(existsSync(filePath)).toBe(true);
  });

  it('uses default filename when not provided', () => {
    const artifact = produceArtifact({
      cwd: testDir,
      projectId,
      taskId,
      sprintId,
      producedBy: 'pm',
      artifactType: 'prd',
      content: 'PRD content',
    });

    expect(artifact.filePath).toContain('prd.md');
  });
});

describe('readArtifactContent', () => {
  it('reads file content from filesystem', () => {
    const artifact = produceArtifact({
      cwd: testDir,
      projectId,
      taskId,
      sprintId,
      producedBy: 'qa-engineer',
      artifactType: 'test-plan',
      content: '# Test Plan\n\n1. Unit tests\n2. Integration tests',
    });

    const content = readArtifactContent(testDir, artifact);

    expect(content).toBe('# Test Plan\n\n1. Unit tests\n2. Integration tests');
  });

  it('returns null for missing file', () => {
    const artifact = {
      id: 'art-missing',
      producedByRole: 'pm' as RoleType,
      artifactType: 'prd' as const,
      filePath: '.omc/artifacts/nonexistent/file.md',
      status: 'draft' as const,
      approvedBy: null,
      taskId,
      sprintId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const content = readArtifactContent(testDir, artifact);

    expect(content).toBeNull();
  });
});

describe('listTaskArtifactFiles', () => {
  it('lists files in task artifact directory', () => {
    produceArtifact({
      cwd: testDir,
      projectId,
      taskId,
      sprintId,
      producedBy: 'pm',
      artifactType: 'prd',
      content: 'PRD content',
    });

    produceArtifact({
      cwd: testDir,
      projectId,
      taskId,
      sprintId,
      producedBy: 'be-dev',
      artifactType: 'api-spec',
      content: 'API spec',
    });

    const files = listTaskArtifactFiles(testDir, sprintId, taskId);

    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.some(f => f.endsWith('prd.md'))).toBe(true);
    expect(files.some(f => f.endsWith('api-spec.yaml'))).toBe(true);
  });

  it('returns empty array for nonexistent directory', () => {
    const files = listTaskArtifactFiles(testDir, 'sprint-999', 'task-999');

    expect(files).toEqual([]);
  });
});

// ============================================================
// ARTIFACT EXCHANGE - STATUS UPDATES
// ============================================================

describe('approveArtifact', () => {
  it('updates artifact status to approved', () => {
    const artifact = produceArtifact({
      cwd: testDir,
      projectId,
      taskId,
      sprintId,
      producedBy: 'fe-dev',
      artifactType: 'api-spec',
      content: 'API spec',
    });

    approveArtifact(testDir, artifact.id, 'qa-engineer');

    const artifacts = getProjectArtifacts(testDir, projectId, { status: 'approved' });
    expect(artifacts.some(a => a.id === artifact.id)).toBe(true);
  });
});

describe('rejectArtifact', () => {
  it('updates artifact status to rejected', () => {
    const artifact = produceArtifact({
      cwd: testDir,
      projectId,
      taskId,
      sprintId,
      producedBy: 'be-dev',
      artifactType: 'schema',
      content: 'CREATE TABLE users...',
    });

    rejectArtifact(testDir, artifact.id);

    const artifacts = getProjectArtifacts(testDir, projectId, { status: 'rejected' });
    expect(artifacts.some(a => a.id === artifact.id)).toBe(true);
  });
});

describe('submitForReview', () => {
  it('updates artifact status to review', () => {
    const artifact = produceArtifact({
      cwd: testDir,
      projectId,
      taskId,
      sprintId,
      producedBy: 'devops-engineer',
      artifactType: 'deploy-config',
      content: 'version: 1.0',
    });

    submitForReview(testDir, artifact.id);

    const artifacts = getProjectArtifacts(testDir, projectId, { status: 'review' });
    expect(artifacts.some(a => a.id === artifact.id)).toBe(true);
  });
});

// ============================================================
// ARTIFACT EXCHANGE - REVIEW ARTIFACTS
// ============================================================

describe('produceReviewArtifact', () => {
  it('creates JSON review artifact', () => {
    const review = {
      reviewType: 'qa-review' as const,
      reviewerRole: 'qa-engineer' as RoleType,
      taskId,
      verdict: 'pass',
      score: 8.5,
      dimensions: {
        correctness: 9,
        security: 8,
        performance: 8,
        maintainability: 9,
        testCoverage: 8,
      },
      feedback: 'Looks good, minor improvements needed.',
      timestamp: new Date().toISOString(),
    };

    const artifact = produceReviewArtifact(testDir, projectId, taskId, sprintId, review);

    expect(artifact.artifactType).toBe('review-report');
    expect(artifact.producedByRole).toBe('qa-engineer');

    const content = readArtifactContent(testDir, artifact);
    expect(content).not.toBeNull();

    const parsed = JSON.parse(content!);
    expect(parsed.score).toBe(8.5);
    expect(parsed.verdict).toBe('pass');
  });
});

// ============================================================
// ARTIFACT EXCHANGE - FILTERING
// ============================================================

describe('getProjectArtifacts', () => {
  it('returns all artifacts for a project', () => {
    produceArtifact({
      cwd: testDir,
      projectId,
      taskId,
      sprintId,
      producedBy: 'pm',
      artifactType: 'prd',
      content: 'PRD',
    });

    produceArtifact({
      cwd: testDir,
      projectId,
      taskId: 'task-002',
      sprintId,
      producedBy: 'be-dev',
      artifactType: 'api-spec',
      content: 'API',
    });

    const artifacts = getProjectArtifacts(testDir, projectId);

    expect(artifacts.length).toBeGreaterThanOrEqual(2);
  });

  it('filters by artifactType', () => {
    produceArtifact({
      cwd: testDir,
      projectId,
      taskId,
      sprintId,
      producedBy: 'pm',
      artifactType: 'prd',
      content: 'PRD',
    });

    produceArtifact({
      cwd: testDir,
      projectId,
      taskId: 'task-002',
      sprintId,
      producedBy: 'be-dev',
      artifactType: 'api-spec',
      content: 'API',
    });

    const artifacts = getProjectArtifacts(testDir, projectId, { artifactType: 'prd' });

    expect(artifacts.every(a => a.artifactType === 'prd')).toBe(true);
  });

  it('filters by status', () => {
    const artifact1 = produceArtifact({
      cwd: testDir,
      projectId,
      taskId,
      sprintId,
      producedBy: 'fe-dev',
      artifactType: 'test-plan',
      content: 'Test plan',
    });

    const artifact2 = produceArtifact({
      cwd: testDir,
      projectId,
      taskId: 'task-002',
      sprintId,
      producedBy: 'qa-engineer',
      artifactType: 'review-report',
      content: 'Review',
    });

    approveArtifact(testDir, artifact1.id, 'qa-engineer');

    const approvedArtifacts = getProjectArtifacts(testDir, projectId, { status: 'approved' });
    const draftArtifacts = getProjectArtifacts(testDir, projectId, { status: 'draft' });

    expect(approvedArtifacts.some(a => a.id === artifact1.id)).toBe(true);
    expect(draftArtifacts.some(a => a.id === artifact2.id)).toBe(true);
  });

  it('filters by producedBy', () => {
    produceArtifact({
      cwd: testDir,
      projectId,
      taskId,
      sprintId,
      producedBy: 'pm',
      artifactType: 'prd',
      content: 'PRD',
    });

    produceArtifact({
      cwd: testDir,
      projectId,
      taskId: 'task-002',
      sprintId,
      producedBy: 'be-dev',
      artifactType: 'api-spec',
      content: 'API',
    });

    const artifacts = getProjectArtifacts(testDir, projectId, { producedBy: 'pm' });

    expect(artifacts.every(a => a.producedByRole === 'pm')).toBe(true);
  });
});
