/**
 * Communication Protocol unit tests
 *
 * Tests: message creation, validation, send/receive permissions.
 */
import { describe, it, expect } from 'vitest';
import {
  createMessage,
  validateMessage,
  canSend,
  canReceive,
  SEND_PERMISSIONS,
  RECEIVE_PERMISSIONS,
} from '../../src/communication/protocol.js';
import type { MessageType, RoleType, TeamMessage } from '../../src/shared/types.js';

// ============================================================
// CREATE MESSAGE
// ============================================================

describe('createMessage', () => {
  it('should create a task_assignment message', () => {
    const msg = createMessage('task_assignment', 'pm', 'fe-dev', {
      taskId: 'task-1',
      subject: 'Build login form',
      description: 'Create a login form with email and password fields',
      fileOwnership: ['src/components/Login.tsx'],
      priority: 1,
    });

    expect(msg.messageType).toBe('task_assignment');
    expect(msg.fromRole).toBe('pm');
    expect(msg.toRole).toBe('fe-dev');
    expect(msg.channel).toBe('dm');
    expect(msg.id).toMatch(/^msg-/);
    expect(msg.timestamp).toBeDefined();

    const payload = JSON.parse(msg.content);
    expect(payload.taskId).toBe('task-1');
    expect(payload.subject).toBe('Build login form');
  });

  it('should create a status_report message', () => {
    const msg = createMessage('status_report', 'be-dev', 'pl', {
      taskId: 'task-2',
      status: 'in-progress',
      progress: 50,
      summary: 'API endpoints done, working on DB queries',
      filesModified: ['src/api/users.ts'],
    });

    expect(msg.messageType).toBe('status_report');
    const payload = JSON.parse(msg.content);
    expect(payload.progress).toBe(50);
  });

  it('should use broadcast channel when specified', () => {
    const msg = createMessage('escalation', 'pl', 'all', {
      taskId: 'task-3',
      severity: 'critical',
      reason: 'Shared type changed',
      context: {},
    }, 'broadcast');

    expect(msg.channel).toBe('broadcast');
    expect(msg.toRole).toBe('all');
  });

  it('should generate unique message IDs', () => {
    const msg1 = createMessage('status_report', 'fe-dev', 'pl', {
      taskId: 't1', status: 'started', progress: 0, summary: 'Starting',
    });
    const msg2 = createMessage('status_report', 'fe-dev', 'pl', {
      taskId: 't2', status: 'started', progress: 0, summary: 'Starting',
    });

    expect(msg1.id).not.toBe(msg2.id);
  });
});

// ============================================================
// VALIDATE MESSAGE
// ============================================================

describe('validateMessage', () => {
  it('should validate a well-formed task_assignment', () => {
    const msg = createMessage('task_assignment', 'pm', 'be-dev', {
      taskId: 'task-1',
      subject: 'Test',
      description: 'Test task',
      fileOwnership: [],
      priority: 1,
    });
    expect(validateMessage(msg).valid).toBe(true);
  });

  it('should reject task_assignment missing taskId', () => {
    const msg = makeRawMessage('task_assignment', JSON.stringify({
      subject: 'Test',
      description: 'Missing taskId',
    }));
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('taskId');
  });

  it('should reject task_assignment missing subject', () => {
    const msg = makeRawMessage('task_assignment', JSON.stringify({
      taskId: 'task-1',
      description: 'Missing subject',
    }));
    const result = validateMessage(msg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('subject');
  });

  it('should validate a well-formed status_report', () => {
    const msg = createMessage('status_report', 'fe-dev', 'pl', {
      taskId: 'task-1',
      status: 'completed',
      progress: 100,
      summary: 'Done!',
    });
    expect(validateMessage(msg).valid).toBe(true);
  });

  it('should reject status_report missing progress', () => {
    const msg = makeRawMessage('status_report', JSON.stringify({
      taskId: 'task-1',
      status: 'in-progress',
    }));
    expect(validateMessage(msg).valid).toBe(false);
  });

  it('should validate a well-formed review_result', () => {
    const msg = createMessage('review_result', 'qa-engineer', 'pl', {
      taskId: 'task-1',
      verdict: 'pass',
      score: 8.0,
      dimensions: { correctness: 8, security: 8, performance: 8, maintainability: 8, testCoverage: 8 },
      feedback: 'All good',
      attempt: 1,
      maxAttempts: 3,
      requiresRework: false,
    });
    expect(validateMessage(msg).valid).toBe(true);
  });

  it('should reject review_result missing score', () => {
    const msg = makeRawMessage('review_result', JSON.stringify({
      taskId: 'task-1',
      verdict: 'pass',
    }));
    expect(validateMessage(msg).valid).toBe(false);
  });

  it('should validate escalation messages', () => {
    const msg = createMessage('escalation', 'be-dev', 'pl', {
      taskId: 'task-1',
      severity: 'high',
      reason: 'Cannot resolve merge conflict',
      context: { affectedFiles: ['src/shared/types.ts'] },
    });
    expect(validateMessage(msg).valid).toBe(true);
  });

  it('should reject escalation missing severity', () => {
    const msg = makeRawMessage('escalation', JSON.stringify({
      taskId: 'task-1',
      reason: 'Problem',
    }));
    expect(validateMessage(msg).valid).toBe(false);
  });

  it('should validate gate_result messages', () => {
    const msg = createMessage('gate_result', 'qa-engineer', 'pl', {
      gateType: 'code-review',
      verdict: 'pass',
      score: 7.5,
      taskId: 'task-1',
      feedback: 'Clean code',
    });
    expect(validateMessage(msg).valid).toBe(true);
  });

  it('should reject invalid JSON content', () => {
    const msg = makeRawMessage('task_assignment', 'not valid json {{{');
    expect(validateMessage(msg).valid).toBe(false);
    expect(validateMessage(msg).error).toContain('Invalid JSON');
  });

  it('should reject unknown message types', () => {
    const msg = makeRawMessage('unknown_type' as MessageType, JSON.stringify({}));
    expect(validateMessage(msg).valid).toBe(false);
    expect(validateMessage(msg).error).toContain('Unknown message type');
  });
});

// ============================================================
// SEND / RECEIVE PERMISSIONS
// ============================================================

describe('canSend', () => {
  it('should allow PM to send task_assignment', () => {
    expect(canSend('pm', 'task_assignment')).toBe(true);
  });

  it('should allow PL to send task_assignment', () => {
    expect(canSend('pl', 'task_assignment')).toBe(true);
  });

  it('should not allow FE dev to send task_assignment', () => {
    expect(canSend('fe-dev', 'task_assignment')).toBe(false);
  });

  it('should allow workers to send status_report', () => {
    expect(canSend('fe-dev', 'status_report')).toBe(true);
    expect(canSend('be-dev', 'status_report')).toBe(true);
  });

  it('should not allow PM to send status_report', () => {
    expect(canSend('pm', 'status_report')).toBe(false);
  });

  it('should allow QA to send review_result', () => {
    expect(canSend('qa-engineer', 'review_result')).toBe(true);
  });

  it('should not allow FE dev to send review_result', () => {
    expect(canSend('fe-dev', 'review_result')).toBe(false);
  });

  it('should allow any role to send escalation', () => {
    const allRoles: RoleType[] = [
      'pm', 'pl', 'fe-dev', 'be-dev', 'qa-engineer',
      'ui-ux-designer', 'devops-engineer', 'security-specialist', 'dba',
    ];
    for (const role of allRoles) {
      expect(canSend(role, 'escalation')).toBe(true);
    }
  });
});

describe('canReceive', () => {
  it('should allow workers to receive task_assignment', () => {
    expect(canReceive('fe-dev', 'task_assignment')).toBe(true);
    expect(canReceive('be-dev', 'task_assignment')).toBe(true);
  });

  it('should not allow PM to receive task_assignment', () => {
    expect(canReceive('pm', 'task_assignment')).toBe(false);
  });

  it('should allow PM/PL to receive status_report', () => {
    expect(canReceive('pm', 'status_report')).toBe(true);
    expect(canReceive('pl', 'status_report')).toBe(true);
  });

  it('should not allow workers to receive status_report', () => {
    expect(canReceive('fe-dev', 'status_report')).toBe(false);
  });

  it('should allow all roles to receive artifact_handoff', () => {
    expect(canReceive('pm', 'artifact_handoff')).toBe(true);
    expect(canReceive('fe-dev', 'artifact_handoff')).toBe(true);
    expect(canReceive('qa-engineer', 'artifact_handoff')).toBe(true);
  });

  it('should allow PL/PM to receive escalation', () => {
    expect(canReceive('pl', 'escalation')).toBe(true);
    expect(canReceive('pm', 'escalation')).toBe(true);
  });

  it('should not allow workers to receive escalation', () => {
    expect(canReceive('fe-dev', 'escalation')).toBe(false);
  });
});

// ============================================================
// HELPERS
// ============================================================

function makeRawMessage(type: MessageType, content: string): TeamMessage {
  return {
    id: 'test-msg',
    fromRole: 'pm',
    toRole: 'fe-dev',
    messageType: type,
    channel: 'dm',
    content,
    metadata: {},
    timestamp: new Date().toISOString(),
  };
}
