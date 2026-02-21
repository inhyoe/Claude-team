/**
 * Claude Team - Role Assignment Hook Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HookRegistry } from '../../src/hooks/lifecycle.js';
import { createRoleAssignmentHook } from '../../src/hooks/role-assignment/index.js';
import type {
  RoleAssignmentHookConfig,
  RoleReassignmentEvent,
} from '../../src/hooks/role-assignment/types.js';

describe('Role Assignment Hook', () => {
  let hooks: HookRegistry;
  let config: RoleAssignmentHookConfig;

  beforeEach(() => {
    hooks = new HookRegistry();
    config = {
      cwd: '/test/project',
      projectId: 'test-project-123',
      enableProviderFailover: true,
      enableIdleDetection: true,
    };
  });

  describe('Hook Creation and Detachment', () => {
    it('should create hook with default config', () => {
      const hook = createRoleAssignmentHook(config, hooks);
      expect(hook).toBeDefined();
      expect(hook.detach).toBeInstanceOf(Function);
    });

    it('should register listeners on creation', () => {
      const initialCount = hooks.listenerCount();
      createRoleAssignmentHook(config, hooks);
      const afterCount = hooks.listenerCount();

      // Should register: node:failed, node:completed, layer:completed
      expect(afterCount).toBeGreaterThan(initialCount);
    });

    it('should unregister all listeners on detach', () => {
      const hook = createRoleAssignmentHook(config, hooks);
      const withHookCount = hooks.listenerCount();

      hook.detach();
      const afterDetachCount = hooks.listenerCount();

      expect(afterDetachCount).toBeLessThan(withHookCount);
    });
  });

  describe('Node Failure Handling', () => {
    it('should trigger reassignment callback on node failure', async () => {
      const onReassignment = vi.fn();
      const testConfig: RoleAssignmentHookConfig = {
        ...config,
        onRoleReassignment: onReassignment,
      };

      createRoleAssignmentHook(testConfig, hooks);

      // Emit node:failed event
      await hooks.emitNodeEvent('node:failed', {
        id: 'node-1',
        roleId: 'qa-engineer-abc123',
        layerIndex: 1,
        nodeType: 'execution',
        status: 'failed',
        dependencies: [],
        taskId: 'task-1',
        fileOwnership: [],
        estimatedDuration: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
      });

      expect(onReassignment).toHaveBeenCalledTimes(1);
      const event: RoleReassignmentEvent = onReassignment.mock.calls[0][0];
      expect(event.roleId).toBe('qa-engineer-abc123');
      expect(event.role).toBe('qa-engineer');
      expect(event.reason).toBe('node-failure');
      expect(event.failedNodeId).toBe('node-1');
      expect(event.failedTaskId).toBe('task-1');
    });

    it('should attempt provider failover for codex role', async () => {
      const onReassignment = vi.fn();
      const testConfig: RoleAssignmentHookConfig = {
        ...config,
        onRoleReassignment: onReassignment,
      };

      createRoleAssignmentHook(testConfig, hooks);

      await hooks.emitNodeEvent('node:failed', {
        id: 'node-1',
        roleId: 'qa-engineer-xyz',
        layerIndex: 1,
        nodeType: 'execution',
        status: 'failed',
        dependencies: [],
        taskId: 'task-1',
        fileOwnership: [],
        estimatedDuration: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
      });

      expect(onReassignment).toHaveBeenCalledTimes(1);
      const event: RoleReassignmentEvent = onReassignment.mock.calls[0][0];
      // qa-engineer defaults to 'codex', should failover to 'claude'
      expect(event.previousProvider).toBe('codex');
    });

    it('should not trigger callback when failover disabled', async () => {
      const onReassignment = vi.fn();
      const testConfig: RoleAssignmentHookConfig = {
        ...config,
        enableProviderFailover: false,
        onRoleReassignment: onReassignment,
      };

      createRoleAssignmentHook(testConfig, hooks);

      await hooks.emitNodeEvent('node:failed', {
        id: 'node-1',
        roleId: 'qa-engineer-abc',
        layerIndex: 1,
        nodeType: 'execution',
        status: 'failed',
        dependencies: [],
        taskId: 'task-1',
        fileOwnership: [],
        estimatedDuration: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
      });

      expect(onReassignment).not.toHaveBeenCalled();
    });
  });

  describe('Role Idle Detection', () => {
    it('should detect idle roles on layer completion', async () => {
      const onIdle = vi.fn();
      const testConfig: RoleAssignmentHookConfig = {
        ...config,
        onRoleIdle: onIdle,
      };

      createRoleAssignmentHook(testConfig, hooks);

      // Complete a node (mark role as active)
      await hooks.emitNodeEvent('node:completed', {
        id: 'node-1',
        roleId: 'fe-dev-123',
        layerIndex: 0,
        nodeType: 'execution',
        status: 'completed',
        dependencies: [],
        taskId: 'task-1',
        fileOwnership: [],
        estimatedDuration: null,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });

      // Complete the layer
      await hooks.emitLayerEvent('layer:completed', {
        index: 0,
        nodeType: 'execution',
        nodes: [],
        gateType: null,
      });

      expect(onIdle).toHaveBeenCalledTimes(1);
      expect(onIdle).toHaveBeenCalledWith('fe-dev-123', 'fe-dev');
    });

    it('should not detect idle when detection disabled', async () => {
      const onIdle = vi.fn();
      const testConfig: RoleAssignmentHookConfig = {
        ...config,
        enableIdleDetection: false,
        onRoleIdle: onIdle,
      };

      createRoleAssignmentHook(testConfig, hooks);

      await hooks.emitNodeEvent('node:completed', {
        id: 'node-1',
        roleId: 'fe-dev-123',
        layerIndex: 0,
        nodeType: 'execution',
        status: 'completed',
        dependencies: [],
        taskId: 'task-1',
        fileOwnership: [],
        estimatedDuration: null,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });

      await hooks.emitLayerEvent('layer:completed', {
        index: 0,
        nodeType: 'execution',
        nodes: [],
        gateType: null,
      });

      expect(onIdle).not.toHaveBeenCalled();
    });

    it('should track multiple roles in same layer', async () => {
      const onIdle = vi.fn();
      const testConfig: RoleAssignmentHookConfig = {
        ...config,
        onRoleIdle: onIdle,
      };

      createRoleAssignmentHook(testConfig, hooks);

      // Complete multiple nodes in same layer
      await hooks.emitNodeEvent('node:completed', {
        id: 'node-1',
        roleId: 'fe-dev-123',
        layerIndex: 0,
        nodeType: 'execution',
        status: 'completed',
        dependencies: [],
        taskId: 'task-1',
        fileOwnership: [],
        estimatedDuration: null,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });

      await hooks.emitNodeEvent('node:completed', {
        id: 'node-2',
        roleId: 'be-dev-456',
        layerIndex: 0,
        nodeType: 'execution',
        status: 'completed',
        dependencies: [],
        taskId: 'task-2',
        fileOwnership: [],
        estimatedDuration: null,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });

      // Complete the layer
      await hooks.emitLayerEvent('layer:completed', {
        index: 0,
        nodeType: 'execution',
        nodes: [],
        gateType: null,
      });

      expect(onIdle).toHaveBeenCalledTimes(2);
      expect(onIdle).toHaveBeenCalledWith('fe-dev-123', 'fe-dev');
      expect(onIdle).toHaveBeenCalledWith('be-dev-456', 'be-dev');
    });
  });

  describe('Config Validation', () => {
    it('should use default values when optional config missing', () => {
      const minimalConfig: RoleAssignmentHookConfig = {
        cwd: '/test',
        projectId: 'test-123',
      };

      const hook = createRoleAssignmentHook(minimalConfig, hooks);
      expect(hook).toBeDefined();
      expect(hook.detach).toBeInstanceOf(Function);
    });

    it('should respect explicit false for enableProviderFailover', () => {
      const onReassignment = vi.fn();
      const testConfig: RoleAssignmentHookConfig = {
        ...config,
        enableProviderFailover: false,
        onRoleReassignment: onReassignment,
      };

      createRoleAssignmentHook(testConfig, hooks);
      expect(onReassignment).not.toHaveBeenCalled();
    });

    it('should respect explicit false for enableIdleDetection', () => {
      const onIdle = vi.fn();
      const testConfig: RoleAssignmentHookConfig = {
        ...config,
        enableIdleDetection: false,
        onRoleIdle: onIdle,
      };

      createRoleAssignmentHook(testConfig, hooks);
      expect(onIdle).not.toHaveBeenCalled();
    });
  });
});
