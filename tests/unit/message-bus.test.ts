/**
 * Message Bus + Preamble unit tests
 *
 * Tests: message routing (DM, broadcast, artifact), permission enforcement,
 * handler subscription, preamble generation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  MessageBus,
  buildSendMessageDM,
  buildSendMessageBroadcast,
  formatMessage,
} from '../../src/communication/message-bus.js';
import { createMessage } from '../../src/communication/protocol.js';
import { buildRolePreamble, buildMcpRolePreamble, CT_WORKER_PREAMBLE } from '../../src/agents/preamble.js';
import type { TeamMessage, RoleType } from '../../src/shared/types.js';

// ============================================================
// MESSAGE BUS
// ============================================================

describe('MessageBus', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus('/tmp/test-cwd', 'test-project');
  });

  describe('subscribe/unsubscribe', () => {
    it('should register handler for a role', () => {
      bus.subscribe('fe-dev', () => {});
      expect(bus.isRoleActive('fe-dev')).toBe(true);
    });

    it('should report inactive for unsubscribed roles', () => {
      expect(bus.isRoleActive('fe-dev')).toBe(false);
    });

    it('should remove handlers on unsubscribe', () => {
      bus.subscribe('fe-dev', () => {});
      bus.unsubscribe('fe-dev');
      expect(bus.isRoleActive('fe-dev')).toBe(false);
    });

    it('should list registered roles', () => {
      bus.subscribe('fe-dev', () => {});
      bus.subscribe('be-dev', () => {});
      const roles = bus.getRegisteredRoles();
      expect(roles).toContain('fe-dev');
      expect(roles).toContain('be-dev');
    });

    it('should clear all handlers', () => {
      bus.subscribe('fe-dev', () => {});
      bus.subscribe('be-dev', () => {});
      bus.clear();
      expect(bus.getRegisteredRoles()).toHaveLength(0);
    });
  });

  describe('route DM', () => {
    it('should deliver DM to registered handler', async () => {
      let received: TeamMessage | null = null;
      bus.subscribe('fe-dev', (msg) => { received = msg; });

      const msg = createMessage('task_assignment', 'pl', 'fe-dev', {
        taskId: 't1', subject: 'Test', description: 'Test task',
        fileOwnership: [], priority: 1,
      });

      const result = await bus.route(msg);
      expect(result.delivered).toBe(true);
      expect(result.recipients).toContain('fe-dev');
      expect(received).not.toBeNull();
    });

    it('should reject DM to "all"', async () => {
      const msg = createMessage('task_assignment', 'pl', 'all', {
        taskId: 't1', subject: 'Test', description: 'Test task',
        fileOwnership: [], priority: 1,
      });
      msg.channel = 'dm';

      const result = await bus.route(msg);
      expect(result.delivered).toBe(false);
      expect(result.errors[0]).toContain('specific recipient');
    });

    it('should fail when no handlers registered', async () => {
      const msg = createMessage('task_assignment', 'pl', 'fe-dev', {
        taskId: 't1', subject: 'Test', description: 'Test task',
        fileOwnership: [], priority: 1,
      });

      const result = await bus.route(msg);
      expect(result.delivered).toBe(false);
      expect(result.errors[0]).toContain('No handlers');
    });

    it('should reject unauthorized sender', async () => {
      bus.subscribe('pl', () => {});
      // fe-dev cannot send task_assignment
      const msg = createMessage('task_assignment', 'fe-dev', 'pl', {
        taskId: 't1', subject: 'Test', description: 'Test task',
        fileOwnership: [], priority: 1,
      });

      const result = await bus.route(msg);
      expect(result.delivered).toBe(false);
      expect(result.errors[0]).toContain('cannot send');
    });

    it('should reject unauthorized receiver', async () => {
      bus.subscribe('pm', () => {});
      // PM cannot receive task_assignment
      const msg = createMessage('task_assignment', 'pl', 'pm', {
        taskId: 't1', subject: 'Test', description: 'Test task',
        fileOwnership: [], priority: 1,
      });

      const result = await bus.route(msg);
      expect(result.delivered).toBe(false);
      expect(result.errors[0]).toContain('cannot receive');
    });
  });

  describe('route broadcast', () => {
    it('should deliver to all eligible roles except sender', async () => {
      const received: RoleType[] = [];
      bus.subscribe('fe-dev', () => { received.push('fe-dev'); });
      bus.subscribe('be-dev', () => { received.push('be-dev'); });
      bus.subscribe('pl', () => { received.push('pl'); });

      // artifact_handoff has receive permission 'all', so everyone can receive
      const msg = createMessage('artifact_handoff', 'pl', 'all', {
        artifactId: 'art-1', artifactType: 'review-report' as const,
        filePath: '/test/path', producedBy: 'pl' as RoleType,
        consumedBy: 'fe-dev' as RoleType, description: 'Broadcast test',
      }, 'broadcast');

      const result = await bus.route(msg);
      expect(result.delivered).toBe(true);
      // pl should not receive own broadcast
      expect(received).not.toContain('pl');
      // others should receive
      expect(received).toContain('fe-dev');
      expect(received).toContain('be-dev');
    });
  });

  describe('route artifact', () => {
    it('should route artifact to specific recipient like DM', async () => {
      let received = false;
      bus.subscribe('qa-engineer', () => { received = true; });

      const msg = createMessage('artifact_handoff', 'fe-dev', 'qa-engineer', {
        artifactId: 'art-1', artifactType: 'review-report' as const,
        filePath: '/test/path', producedBy: 'fe-dev' as RoleType,
        consumedBy: 'qa-engineer' as RoleType, description: 'Review this',
      }, 'artifact');

      const result = await bus.route(msg);
      expect(result.delivered).toBe(true);
      expect(received).toBe(true);
    });
  });
});

// ============================================================
// CONVENIENCE FUNCTIONS
// ============================================================

describe('buildSendMessageDM', () => {
  it('should build DM payload', () => {
    const payload = buildSendMessageDM('worker-1', 'hello', 'greeting');
    expect(payload.type).toBe('message');
    expect(payload.recipient).toBe('worker-1');
    expect(payload.content).toBe('hello');
    expect(payload.summary).toBe('greeting');
  });
});

describe('buildSendMessageBroadcast', () => {
  it('should build broadcast payload', () => {
    const payload = buildSendMessageBroadcast('stop all', 'urgent');
    expect(payload.type).toBe('broadcast');
    expect(payload.content).toBe('stop all');
  });
});

describe('formatMessage', () => {
  it('should format message for display', () => {
    const msg = createMessage('status_report', 'fe-dev', 'pl', {
      taskId: 't1', status: 'completed' as const, progress: 100, summary: 'Done',
    });
    const formatted = formatMessage(msg);
    expect(formatted).toContain('fe-dev');
    expect(formatted).toContain('pl');
    expect(formatted).toContain('status_report');
  });
});

// ============================================================
// PREAMBLE BUILDER
// ============================================================

describe('buildRolePreamble', () => {
  it('should include role name', () => {
    const preamble = buildRolePreamble('fe-dev', 'worker-1', 'test-team');
    expect(preamble).toContain('fe-dev');
  });

  it('should include persona name', () => {
    const preamble = buildRolePreamble('pm', 'worker-1', 'test-team');
    expect(preamble).toContain('Alex');
  });

  it('should include team name', () => {
    const preamble = buildRolePreamble('be-dev', 'worker-1', 'my-team');
    expect(preamble).toContain('TEAM: my-team');
  });

  it('should include worker name', () => {
    const preamble = buildRolePreamble('be-dev', 'be-dev-morgan', 'test-team');
    expect(preamble).toContain('YOUR NAME: be-dev-morgan');
    expect(preamble).toContain('be-dev-morgan');
  });

  it('should show merged roles', () => {
    const preamble = buildRolePreamble('fe-dev', 'worker-1', 'test-team', ['ui-ux-designer']);
    expect(preamble).toContain('ui-ux-designer');
  });

  it('should include file ownership when provided', () => {
    const preamble = buildRolePreamble('fe-dev', 'worker-1', 'test-team', [], ['src/ui/**', 'src/components/**']);
    expect(preamble).toContain('src/ui/**');
    expect(preamble).toContain('src/components/**');
  });

  it('should use "unassigned" as default sprint_id', () => {
    const preamble = buildRolePreamble('fe-dev', 'worker-1', 'test-team');
    expect(preamble).toContain('unassigned');
    expect(preamble).not.toContain('{sprint_id}');
  });

  it('should use provided sprint_id', () => {
    const preamble = buildRolePreamble('fe-dev', 'worker-1', 'test-team', [], [], 'sprint-1');
    expect(preamble).toContain('sprint-1');
  });

  it('should return base preamble for unknown roles', () => {
    const preamble = buildRolePreamble('unknown' as RoleType, 'w-1', 'team');
    expect(preamble).toBe(CT_WORKER_PREAMBLE);
  });
});

describe('buildMcpRolePreamble', () => {
  it('should include role and task info', () => {
    const preamble = buildMcpRolePreamble('qa-engineer', 'Review code', 'Check for bugs', '/project');
    expect(preamble).toContain('qa-engineer');
    expect(preamble).toContain('Review code');
    expect(preamble).toContain('Check for bugs');
    expect(preamble).toContain('/project');
  });

  it('should include merged roles', () => {
    const preamble = buildMcpRolePreamble('qa-engineer', 'Test', 'Desc', '/p', ['security-specialist']);
    expect(preamble).toContain('security-specialist');
  });

  it('should include capabilities', () => {
    const preamble = buildMcpRolePreamble('fe-dev', 'Build UI', 'Create components', '/p');
    expect(preamble).toContain('frontend-implementation');
  });
});
