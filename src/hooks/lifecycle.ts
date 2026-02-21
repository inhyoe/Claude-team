/**
 * Claude Team - Lifecycle Hook System
 *
 * Event-driven hook registry for pipeline orchestration.
 * Components register listeners; the orchestrator emits events.
 */

import type { DAGNode, DAGLayer } from '../shared/types.js';
import { nowIso } from '../shared/utils.js';

// Event types
export type HookEventType =
  | 'node:dispatched'
  | 'node:started'
  | 'node:completed'
  | 'node:failed'
  | 'layer:started'
  | 'layer:completed'
  | 'gate:evaluating'
  | 'gate:passed'
  | 'gate:failed'
  | 'phase:changed'
  | 'plan:started'
  | 'plan:completed'
  | 'plan:failed'
  | 'escalation:triggered';

// Event payload union type
export interface HookEvent {
  type: HookEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

// Specific event data interfaces
export interface NodeEvent extends HookEvent {
  data: {
    nodeId: string;
    taskId: string | null;
    roleId: string;
    layerIndex: number;
    [key: string]: unknown;
  };
}

export interface LayerEvent extends HookEvent {
  data: {
    layerIndex: number;
    nodeCount: number;
    gateType: string | null;
    [key: string]: unknown;
  };
}

export interface GateEvent extends HookEvent {
  data: {
    taskId: string;
    gateType: string;
    verdict?: string;
    score?: number;
    [key: string]: unknown;
  };
}

// Hook listener type
export type HookListener = (event: HookEvent) => void | Promise<void>;

// HookRegistry class
export class HookRegistry {
  private listeners: Map<HookEventType, HookListener[]> = new Map();
  private allListeners: HookListener[] = [];  // wildcard listeners

  /**
   * Register a listener for a specific event type.
   */
  on(eventType: HookEventType, listener: HookListener): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, []);
    }
    this.listeners.get(eventType)!.push(listener);

    // Return unsubscribe function
    return () => {
      const list = this.listeners.get(eventType);
      if (list) {
        const idx = list.indexOf(listener);
        if (idx !== -1) list.splice(idx, 1);
      }
    };
  }

  /**
   * Register a listener for ALL events (wildcard).
   */
  onAll(listener: HookListener): () => void {
    this.allListeners.push(listener);

    // Return unsubscribe function
    return () => {
      const idx = this.allListeners.indexOf(listener);
      if (idx !== -1) this.allListeners.splice(idx, 1);
    };
  }

  /**
   * Emit an event to all matching listeners.
   * Catches and logs listener errors (never throws).
   */
  async emit(event: HookEvent): Promise<void> {
    // Get listeners for this event type
    const typeListeners = this.listeners.get(event.type) ?? [];
    const allToCall = [...typeListeners, ...this.allListeners];

    // Call each listener, catching any errors
    for (const listener of allToCall) {
      try {
        const result = listener(event);
        if (result instanceof Promise) {
          await result;
        }
      } catch (error) {
        console.error(`[HookRegistry] Listener error for ${event.type}:`, error);
      }
    }
  }

  /**
   * Helper: emit a node event.
   */
  async emitNodeEvent(
    type: 'node:dispatched' | 'node:started' | 'node:completed' | 'node:failed',
    node: DAGNode,
    extra?: Record<string, unknown>
  ): Promise<void> {
    const event: NodeEvent = {
      type,
      timestamp: nowIso(),
      data: {
        nodeId: node.id,
        taskId: node.taskId,
        roleId: node.roleId,
        layerIndex: node.layerIndex,
        ...extra,
      },
    };
    await this.emit(event);
  }

  /**
   * Helper: emit a layer event.
   */
  async emitLayerEvent(
    type: 'layer:started' | 'layer:completed',
    layer: DAGLayer,
    extra?: Record<string, unknown>
  ): Promise<void> {
    const event: LayerEvent = {
      type,
      timestamp: nowIso(),
      data: {
        layerIndex: layer.index,
        nodeCount: layer.nodes.length,
        gateType: layer.gateType,
        ...extra,
      },
    };
    await this.emit(event);
  }

  /**
   * Helper: emit a gate event.
   */
  async emitGateEvent(
    type: 'gate:evaluating' | 'gate:passed' | 'gate:failed',
    taskId: string,
    gateType: string,
    extra?: Record<string, unknown>
  ): Promise<void> {
    const event: GateEvent = {
      type,
      timestamp: nowIso(),
      data: {
        taskId,
        gateType,
        ...extra,
      },
    };
    await this.emit(event);
  }

  /**
   * Remove all listeners.
   */
  clear(): void {
    this.listeners.clear();
    this.allListeners = [];
  }

  /**
   * Get count of registered listeners.
   */
  listenerCount(eventType?: HookEventType): number {
    if (eventType === undefined) {
      let total = this.allListeners.length;
      for (const list of this.listeners.values()) {
        total += list.length;
      }
      return total;
    }
    return (this.listeners.get(eventType)?.length ?? 0) + this.allListeners.length;
  }
}