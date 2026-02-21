/**
 * Hook Registry unit tests
 *
 * Tests: event registration, emission, wildcard listeners,
 * error handling, async listeners, unsubscribe, listener counts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  HookRegistry,
  type HookEvent,
  type HookListener,
} from '../../src/hooks/lifecycle.js';
import type { DAGNode, DAGLayer } from '../../src/shared/types.js';

// ============================================================
// HELPERS
// ============================================================

function createMockNode(id: string): DAGNode {
  return {
    id,
    roleId: 'be-dev',
    layerIndex: 0,
    nodeType: 'execution',
    status: 'pending',
    dependencies: [],
    taskId: `task-${id}`,
    fileOwnership: [],
    estimatedDuration: null,
    startedAt: null,
    completedAt: null,
  };
}

function createMockLayer(index: number): DAGLayer {
  return {
    index,
    nodes: [],
    gateType: null,
  };
}

// ============================================================
// REGISTRATION
// ============================================================

describe('HookRegistry - on()', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it('should register a listener for an event type', () => {
    const listener = vi.fn();
    registry.on('node:started', listener);

    expect(registry.listenerCount('node:started')).toBe(1);
  });

  it('should return an unsubscribe function', () => {
    const listener = vi.fn();
    const unsubscribe = registry.on('node:started', listener);

    expect(typeof unsubscribe).toBe('function');
    expect(registry.listenerCount('node:started')).toBe(1);

    unsubscribe();
    expect(registry.listenerCount('node:started')).toBe(0);
  });

  it('should register multiple listeners for same event', () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    registry.on('node:started', listener1);
    registry.on('node:started', listener2);

    expect(registry.listenerCount('node:started')).toBe(2);
  });

  it('should register listeners for different events', () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    registry.on('node:started', listener1);
    registry.on('node:completed', listener2);

    expect(registry.listenerCount('node:started')).toBe(1);
    expect(registry.listenerCount('node:completed')).toBe(1);
  });
});

// ============================================================
// WILDCARD LISTENERS
// ============================================================

describe('HookRegistry - onAll()', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it('should register a wildcard listener', () => {
    const listener = vi.fn();
    registry.onAll(listener);

    const totalCount = registry.listenerCount();
    expect(totalCount).toBe(1);
  });

  it('should return an unsubscribe function', () => {
    const listener = vi.fn();
    const unsubscribe = registry.onAll(listener);

    expect(typeof unsubscribe).toBe('function');

    unsubscribe();
    expect(registry.listenerCount()).toBe(0);
  });

  it('should receive all event types', async () => {
    const receivedEvents: string[] = [];
    const listener = vi.fn((event: HookEvent) => {
      receivedEvents.push(event.type);
    });

    registry.onAll(listener);

    await registry.emit({
      type: 'node:started',
      timestamp: new Date().toISOString(),
      data: {},
    });

    await registry.emit({
      type: 'node:completed',
      timestamp: new Date().toISOString(),
      data: {},
    });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(receivedEvents).toContain('node:started');
    expect(receivedEvents).toContain('node:completed');
  });
});

// ============================================================
// EMIT
// ============================================================

describe('HookRegistry - emit()', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it('should call matching listeners', async () => {
    const listener = vi.fn();
    registry.on('node:started', listener);

    const event: HookEvent = {
      type: 'node:started',
      timestamp: new Date().toISOString(),
      data: { nodeId: 'test-node' },
    };

    await registry.emit(event);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('should not call listeners for different event types', async () => {
    const startedListener = vi.fn();
    const completedListener = vi.fn();

    registry.on('node:started', startedListener);
    registry.on('node:completed', completedListener);

    await registry.emit({
      type: 'node:started',
      timestamp: new Date().toISOString(),
      data: {},
    });

    expect(startedListener).toHaveBeenCalledTimes(1);
    expect(completedListener).toHaveBeenCalledTimes(0);
  });

  it('should call both specific and wildcard listeners', async () => {
    const specificListener = vi.fn();
    const wildcardListener = vi.fn();

    registry.on('node:started', specificListener);
    registry.onAll(wildcardListener);

    await registry.emit({
      type: 'node:started',
      timestamp: new Date().toISOString(),
      data: {},
    });

    expect(specificListener).toHaveBeenCalledTimes(1);
    expect(wildcardListener).toHaveBeenCalledTimes(1);
  });

  it('should handle async listeners', async () => {
    const results: string[] = [];

    const asyncListener: HookListener = async (event: HookEvent) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      results.push('async');
    };

    registry.on('node:started', asyncListener);

    await registry.emit({
      type: 'node:started',
      timestamp: new Date().toISOString(),
      data: {},
    });

    expect(results).toContain('async');
  });

  it('should catch and log listener errors without throwing', async () => {
    const errorListener: HookListener = () => {
      throw new Error('Listener error');
    };

    const workingListener = vi.fn();

    registry.on('node:started', errorListener);
    registry.on('node:started', workingListener);

    // Suppress console.error for this test
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await registry.emit({
      type: 'node:started',
      timestamp: new Date().toISOString(),
      data: {},
    });

    // Working listener should still be called
    expect(workingListener).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('should handle async listener errors', async () => {
    const asyncErrorListener: HookListener = async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      throw new Error('Async error');
    };

    const workingListener = vi.fn();

    registry.on('node:started', asyncErrorListener);
    registry.on('node:started', workingListener);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await registry.emit({
      type: 'node:started',
      timestamp: new Date().toISOString(),
      data: {},
    });

    expect(workingListener).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('should handle empty listener list', async () => {
    await registry.emit({
      type: 'node:started',
      timestamp: new Date().toISOString(),
      data: {},
    });

    // Should not throw
    expect(true).toBe(true);
  });
});

// ============================================================
// HELPER EMITTERS
// ============================================================

describe('HookRegistry - emitNodeEvent()', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it('should emit node event with correct structure', async () => {
    const listener = vi.fn();
    registry.on('node:started', listener);

    const node = createMockNode('test-node');
    await registry.emitNodeEvent('node:started', node);

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0];
    expect(event.type).toBe('node:started');
    expect(event.data.nodeId).toBe('test-node');
    expect(event.data.taskId).toBe('task-test-node');
    expect(event.data.roleId).toBe('be-dev');
    expect(event.data.layerIndex).toBe(0);
  });

  it('should include extra data', async () => {
    const listener = vi.fn();
    registry.on('node:completed', listener);

    const node = createMockNode('test-node');
    await registry.emitNodeEvent('node:completed', node, {
      duration: 120,
      artifacts: ['file1.ts', 'file2.ts'],
    });

    const event = listener.mock.calls[0][0];
    expect(event.data.duration).toBe(120);
    expect(event.data.artifacts).toEqual(['file1.ts', 'file2.ts']);
  });
});

describe('HookRegistry - emitLayerEvent()', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it('should emit layer event with correct structure', async () => {
    const listener = vi.fn();
    registry.on('layer:started', listener);

    const layer = createMockLayer(1);
    await registry.emitLayerEvent('layer:started', layer);

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0];
    expect(event.type).toBe('layer:started');
    expect(event.data.layerIndex).toBe(1);
    expect(event.data.nodeCount).toBe(0);
    expect(event.data.gateType).toBeNull();
  });

  it('should include extra data', async () => {
    const listener = vi.fn();
    registry.on('layer:completed', listener);

    const layer = createMockLayer(2);
    await registry.emitLayerEvent('layer:completed', layer, {
      duration: 300,
      nodesCompleted: 5,
    });

    const event = listener.mock.calls[0][0];
    expect(event.data.duration).toBe(300);
    expect(event.data.nodesCompleted).toBe(5);
  });
});

describe('HookRegistry - emitGateEvent()', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it('should emit gate event with correct structure', async () => {
    const listener = vi.fn();
    registry.on('gate:passed', listener);

    await registry.emitGateEvent('gate:passed', 'task-1', 'code-review');

    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0];
    expect(event.type).toBe('gate:passed');
    expect(event.data.taskId).toBe('task-1');
    expect(event.data.gateType).toBe('code-review');
  });

  it('should include extra data', async () => {
    const listener = vi.fn();
    registry.on('gate:failed', listener);

    await registry.emitGateEvent('gate:failed', 'task-2', 'qa-review', {
      score: 4.5,
      verdict: 'fail',
      attemptsRemaining: 2,
    });

    const event = listener.mock.calls[0][0];
    expect(event.data.score).toBe(4.5);
    expect(event.data.verdict).toBe('fail');
    expect(event.data.attemptsRemaining).toBe(2);
  });
});

// ============================================================
// CLEAR
// ============================================================

describe('HookRegistry - clear()', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it('should remove all listeners', () => {
    registry.on('node:started', vi.fn());
    registry.on('node:completed', vi.fn());
    registry.onAll(vi.fn());

    expect(registry.listenerCount()).toBeGreaterThan(0);

    registry.clear();

    expect(registry.listenerCount()).toBe(0);
    expect(registry.listenerCount('node:started')).toBe(0);
    expect(registry.listenerCount('node:completed')).toBe(0);
  });
});

// ============================================================
// LISTENER COUNT
// ============================================================

describe('HookRegistry - listenerCount()', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it('should count listeners for specific event type', () => {
    registry.on('node:started', vi.fn());
    registry.on('node:started', vi.fn());
    registry.on('node:completed', vi.fn());

    expect(registry.listenerCount('node:started')).toBe(2);
    expect(registry.listenerCount('node:completed')).toBe(1);
  });

  it('should count total listeners when no type specified', () => {
    registry.on('node:started', vi.fn());
    registry.on('node:completed', vi.fn());
    registry.on('layer:started', vi.fn());

    expect(registry.listenerCount()).toBe(3);
  });

  it('should include wildcard listeners in specific event count', () => {
    registry.on('node:started', vi.fn());
    registry.onAll(vi.fn());

    // Wildcard listener counts toward all event types
    expect(registry.listenerCount('node:started')).toBe(2);
  });

  it('should include wildcard listeners in total count', () => {
    registry.on('node:started', vi.fn());
    registry.onAll(vi.fn());
    registry.onAll(vi.fn());

    expect(registry.listenerCount()).toBe(3);
  });

  it('should return 0 for unregistered event types', () => {
    expect(registry.listenerCount('node:started')).toBe(0);
  });
});

// ============================================================
// LISTENER ERROR ISOLATION
// ============================================================

describe('HookRegistry - listener error isolation', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it('should not block other listeners when one fails', async () => {
    const listener1 = vi.fn(() => {
      throw new Error('Listener 1 error');
    });
    const listener2 = vi.fn();
    const listener3 = vi.fn();

    registry.on('node:started', listener1);
    registry.on('node:started', listener2);
    registry.on('node:started', listener3);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await registry.emit({
      type: 'node:started',
      timestamp: new Date().toISOString(),
      data: {},
    });

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
    expect(listener3).toHaveBeenCalledTimes(1);

    consoleErrorSpy.mockRestore();
  });

  it('should handle async listener failure without blocking others', async () => {
    const asyncFailListener: HookListener = async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      throw new Error('Async fail');
    };

    const listener2 = vi.fn();

    registry.on('node:started', asyncFailListener);
    registry.on('node:started', listener2);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await registry.emit({
      type: 'node:started',
      timestamp: new Date().toISOString(),
      data: {},
    });

    expect(listener2).toHaveBeenCalledTimes(1);

    consoleErrorSpy.mockRestore();
  });
});
