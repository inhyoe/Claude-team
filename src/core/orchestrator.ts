/**
 * Claude Team - DAG Orchestrator
 *
 * Main execution orchestrator that drives DAG-based execution plans.
 * Coordinates node dispatch, gate evaluation, escalation, and kanban sync.
 *
 * ARCHITECTURE: This is the "nervous system" that connects:
 * - DAG engine (topological execution order)
 * - Kanban board (status tracking)
 * - Quality gates (evaluation & escalation)
 * - Node dispatch (actual work execution via callbacks)
 */

import type {
  ExecutionPlan,
  DAGNode,
  DAGLayer,
  GateType,
  RoleType,
} from '../shared/types.js';
import type { GateEvaluationInput, GateEvaluationResult } from '../quality/gates.js';
import type { EscalationDecision } from '../quality/escalation.js';
import type { HookRegistry } from '../hooks/lifecycle.js';
import {
  getReadyNodes,
  isLayerComplete,
  advanceLayer,
  markNodeStarted,
  markNodeCompleted,
  markNodeFailed,
} from './dag-engine.js';
import { evaluateGate } from '../quality/gates.js';
import { determineEscalation } from '../quality/escalation.js';
import { nowIso } from '../shared/utils.js';
import { WORKER_TIMEOUT_MS } from '../shared/constants.js';
import { savePlanNodes, loadPlanNodes } from '../persistence/dag-nodes-repo.js';

// ============================================================
// INTERFACES
// ============================================================

/**
 * Configuration for the orchestrator.
 */
export interface OrchestratorConfig {
  cwd: string;
  projectId: string;
  plan: ExecutionPlan;
  hooks?: HookRegistry;
  nodeTimeoutMs?: number;
  onNodeDispatch?: (node: DAGNode) => Promise<NodeResult>;
  onGateEvaluate?: (layer: DAGLayer, nodes: DAGNode[]) => Promise<GateEvaluationInput[]>;
  onEscalation?: (decision: EscalationDecision) => Promise<void>;
  onLayerComplete?: (layerIndex: number) => void;
  onPlanComplete?: (plan: ExecutionPlan) => void;
}

/**
 * Result from executing a single DAG node.
 */
export interface NodeResult {
  nodeId: string;
  success: boolean;
  error?: string;
  artifacts?: string[];
}

// GateEvaluationInput is imported from quality/gates.ts to avoid duplicate exports

/**
 * Runtime state of the orchestrator.
 */
export interface OrchestratorState {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  currentLayerIndex: number;
  nodesDispatched: number;
  nodesCompleted: number;
  nodesFailed: number;
  gatesPassed: number;
  gatesFailed: number;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
}

// ============================================================
// ORCHESTRATOR
// ============================================================

/**
 * Main DAG execution orchestrator.
 *
 * Drives the execution loop:
 * 1. Get ready nodes in current layer
 * 2. Dispatch nodes in parallel
 * 3. Collect results
 * 4. Update DAG and kanban state
 * 5. Evaluate layer gates
 * 6. Advance to next layer
 * 7. Repeat until plan complete or failed
 */
export class Orchestrator {
  private config: Required<Omit<OrchestratorConfig, 'hooks'>>;
  private hooks: HookRegistry | null;
  private state: OrchestratorState;
  private cancelRequested: boolean = false;

  constructor(config: OrchestratorConfig) {
    this.hooks = config.hooks ?? null;
    this.config = {
      cwd: config.cwd,
      projectId: config.projectId,
      plan: config.plan,
      nodeTimeoutMs: config.nodeTimeoutMs ?? WORKER_TIMEOUT_MS,
      onNodeDispatch: config.onNodeDispatch ?? this.defaultNodeDispatch.bind(this),
      onGateEvaluate: config.onGateEvaluate ?? this.defaultGateEvaluate.bind(this),
      onEscalation: config.onEscalation ?? this.defaultEscalation.bind(this),
      onLayerComplete: config.onLayerComplete ?? (() => {}),
      onPlanComplete: config.onPlanComplete ?? (() => {}),
    };

    this.state = {
      status: 'idle',
      currentLayerIndex: 0,
      nodesDispatched: 0,
      nodesCompleted: 0,
      nodesFailed: 0,
      gatesPassed: 0,
      gatesFailed: 0,
      startedAt: null,
      completedAt: null,
      lastError: null,
    };

    // Warn if no hook registry provided (kanban sync won't be active)
    if (!this.hooks) {
      console.warn('[Orchestrator] No HookRegistry provided - kanban sync will not be active');
    }
  }

  /**
   * Main execution loop.
   * Runs until plan completes, fails, or cancel is requested.
   */
  async run(): Promise<OrchestratorState> {
    if (this.state.status === 'running') {
      throw new Error('Orchestrator is already running');
    }
    this.state.status = 'running';
    this.state.startedAt = nowIso();
    this.state.currentLayerIndex = this.config.plan.currentLayerIndex;

    // Persist plan nodes to SQLite at start
    savePlanNodes(this.config.cwd, this.config.projectId, this.config.plan);

    await this.hooks?.emit({
      type: 'plan:started',
      timestamp: nowIso(),
      data: { planId: this.config.plan.id, projectId: this.config.projectId },
    });

    try {
      while (
        this.config.plan.status !== 'completed' &&
        this.config.plan.status !== 'failed' &&
        !this.cancelRequested
      ) {
        const layerProcessed = await this.processLayer();

        if (!layerProcessed) {
          // No progress made — either waiting or error
          const readyNodes = getReadyNodes(this.config.plan);
          const layerComplete = isLayerComplete(this.config.plan);

          const currentLayer = this.config.plan.layers[this.config.plan.currentLayerIndex];
          const runningNodes = currentLayer ? currentLayer.nodes.filter(n => n.status === 'running') : [];
          if (readyNodes.length === 0 && runningNodes.length === 0 && !layerComplete) {
            throw new Error('Deadlock detected: no ready nodes and layer not complete');
          }

          // Layer complete but couldn't advance (likely waiting for gate or at end)
          if (layerComplete && !advanceLayer(this.config.plan)) {
            break;
          }
        }
      }

      // Determine final status
      if (this.cancelRequested) {
        this.state.status = 'cancelled';
      } else if (this.config.plan.status === 'completed') {
        this.state.status = 'completed';
        this.config.onPlanComplete(this.config.plan);
        await this.hooks?.emit({
          type: 'plan:completed',
          timestamp: nowIso(),
          data: { planId: this.config.plan.id, projectId: this.config.projectId, state: this.state },
        });
      } else if (this.config.plan.status === 'failed') {
        this.state.status = 'failed';
      }

    } catch (error) {
      this.state.status = 'failed';
      this.state.lastError = error instanceof Error ? error.message : String(error);
      this.config.plan.status = 'failed';
      await this.hooks?.emit({
        type: 'plan:failed',
        timestamp: nowIso(),
        data: { planId: this.config.plan.id, error: this.state.lastError },
      });
    } finally {
      this.state.completedAt = nowIso();
    }

    return this.state;
  }

  /**
   * Process a single layer: dispatch ready nodes, wait for completion, evaluate gate.
   * Returns true if progress was made.
   */
  private async processLayer(): Promise<boolean> {
    const readyNodes = getReadyNodes(this.config.plan);

    if (readyNodes.length === 0) {
      // No ready nodes - check if layer is complete
      if (!isLayerComplete(this.config.plan)) {
        return false;
      }

      // Layer complete - evaluate gate if present
      const layer = this.config.plan.layers[this.config.plan.currentLayerIndex];
      if (layer?.gateType) {
        const gateOutcome = await this.evaluateLayerGate(layer);
        if (!gateOutcome.passed) {
          await this.handleGateFailure(layer, gateOutcome.results);
          return false;
        }
      }

      // Advance to next layer
      const prevLayerIndex = this.config.plan.currentLayerIndex;
      const advanced = advanceLayer(this.config.plan);

      if (advanced) {
        this.state.currentLayerIndex = this.config.plan.currentLayerIndex;
        this.config.onLayerComplete(prevLayerIndex);
        if (layer) {
          await this.hooks?.emitLayerEvent('layer:completed', layer);
        }
        return true;
      }

      // No more layers - plan complete
      return false;
    }

    // Dispatch ready nodes
    const results = await this.dispatchNodes(readyNodes);

    // Process results
    for (const result of results) {
      const node = this.config.plan.nodes.get(result.nodeId);
      if (!node) continue;

      if (result.success) {
        markNodeCompleted(this.config.plan, result.nodeId);
        this.state.nodesCompleted++;
        await this.hooks?.emitNodeEvent('node:completed', node, { artifacts: result.artifacts });
      } else {
        markNodeFailed(this.config.plan, result.nodeId);
        this.state.nodesFailed++;
        await this.hooks?.emitNodeEvent('node:failed', node, { error: result.error });
      }
    }

    // Persist updated node states after processing results
    if (results.length > 0) {
      savePlanNodes(this.config.cwd, this.config.projectId, this.config.plan);
    }

    return results.length > 0;
  }

  /**
   * Dispatch a batch of ready nodes in parallel.
   */
  private async dispatchNodes(nodes: DAGNode[]): Promise<NodeResult[]> {
    // Mark all nodes as started and emit events
    for (const node of nodes) {
      markNodeStarted(this.config.plan, node.id);
      this.state.nodesDispatched++;
      await this.hooks?.emitNodeEvent('node:started', node);
    }

    // Dispatch all nodes in parallel with timeout
    const dispatchPromises = nodes.map(async (node) => {
      let timerId: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutPromise = new Promise<NodeResult>((_, reject) => {
          timerId = setTimeout(() => {
            reject(new Error(`Node ${node.id} timed out after ${this.config.nodeTimeoutMs}ms`));
          }, this.config.nodeTimeoutMs);
        });

        const resultPromise = this.config.onNodeDispatch(node);
        const result = await Promise.race([resultPromise, timeoutPromise]);
        clearTimeout(timerId);
        return result;
      } catch (error) {
        clearTimeout(timerId);
        return {
          nodeId: node.id,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    return await Promise.all(dispatchPromises);
  }

  /**
   * Evaluate the quality gate for a completed layer.
   */
  private async evaluateLayerGate(layer: DAGLayer): Promise<{ passed: boolean; results: GateEvaluationResult[] }> {
    if (!layer.gateType) return { passed: true, results: [] };

    // Get completed nodes in this layer that have tasks
    const completedNodes = layer.nodes.filter(
      n => n.status === 'completed' && n.taskId !== null
    );

    if (completedNodes.length === 0) {
      // No tasks to evaluate - gate passes by default
      return { passed: true, results: [] };
    }

    // Get gate evaluation inputs from callback
    const evaluationInputs = await this.config.onGateEvaluate(layer, completedNodes);

    if (evaluationInputs.length === 0) {
      // No evaluations provided - gate passes by default
      return { passed: true, results: [] };
    }

    // Evaluate each gate
    const results: GateEvaluationResult[] = [];
    for (const input of evaluationInputs) {
      await this.hooks?.emitGateEvent('gate:evaluating', input.taskId, layer.gateType!);
      const result = evaluateGate(input);
      results.push(result);

      if (result.verdict === 'pass') {
        this.state.gatesPassed++;
        await this.hooks?.emitGateEvent('gate:passed', input.taskId, layer.gateType!, {
          score: result.result.score, verdict: result.verdict,
        });
      } else {
        this.state.gatesFailed++;
        await this.hooks?.emitGateEvent('gate:failed', input.taskId, layer.gateType!, {
          score: result.result.score, verdict: result.verdict,
        });
      }
    }

    // Gate passes if all evaluations pass
    const allPassed = results.every(r => r.verdict === 'pass');
    return { passed: allPassed, results };
  }

  /**
   * Handle gate failure with escalation logic.
   */
  private async handleGateFailure(
    layer: DAGLayer,
    gateResults: GateEvaluationResult[]
  ): Promise<void> {
    if (!layer.gateType) return;

    // Determine escalation for each failed gate
    for (const gateResult of gateResults) {
      if (gateResult.verdict === 'pass') continue;

      const decision = determineEscalation(
        this.config.cwd,
        gateResult.result.taskId,
        layer.gateType,
        gateResult.result
      );

      await this.config.onEscalation(decision);

      await this.hooks?.emit({
        type: 'escalation:triggered',
        timestamp: nowIso(),
        data: { taskId: gateResult.result.taskId, action: decision.action, reason: decision.reason, targetRole: decision.targetRole },
      });

      // Handle specific escalation actions
      switch (decision.action) {
        case 'retry':
          // Reset node to pending for retry
          const nodeToRetry = Array.from(this.config.plan.nodes.values()).find(
            n => n.taskId === gateResult.result.taskId
          );
          if (nodeToRetry) {
            nodeToRetry.status = 'pending';
            nodeToRetry.startedAt = null;
            nodeToRetry.completedAt = null;
          }
          break;

        case 'escalate-pl':
        case 'escalate-pm':
        case 'upgrade-model':
          // These require human/external intervention - pause execution
          this.state.status = 'paused';
          break;

        case 'accept-risk':
          // Continue despite gate failure
          this.state.gatesPassed++;
          break;

        case 'abandon':
        case 'split-task':
          // Mark plan as failed
          this.config.plan.status = 'failed';
          break;
      }
    }
  }

  /**
   * Request cancellation of the orchestrator.
   */
  requestCancel(): void {
    this.cancelRequested = true;
  }

  /**
   * Get current orchestrator state.
   */
  getState(): OrchestratorState {
    return { ...this.state };
  }

  /**
   * Resume execution by loading DAG nodes from SQLite.
   * Returns true if nodes were successfully restored.
   */
  resume(): boolean {
    const restoredNodes = loadPlanNodes(this.config.cwd, this.config.plan.id);

    if (!restoredNodes) {
      return false;
    }

    // Replace the in-memory nodes map with restored state
    this.config.plan.nodes = restoredNodes;

    // Sync layer nodes references to restored nodes
    for (const layer of this.config.plan.layers) {
      layer.nodes = layer.nodes.map(layerNode => {
        const restored = restoredNodes.get(layerNode.id);
        return restored ?? layerNode;
      });
    }

    // Recalculate currentLayerIndex: find first layer with non-completed nodes
    let resumeLayerIndex = 0;
    for (let i = 0; i < this.config.plan.layers.length; i++) {
      const layer = this.config.plan.layers[i];
      const allDone = layer.nodes.every(n =>
        n.status === 'completed' || n.status === 'failed' || n.status === 'skipped'
      );
      if (!allDone) {
        resumeLayerIndex = i;
        break;
      }
      resumeLayerIndex = i + 1; // all layers complete = point past last layer
    }
    this.config.plan.currentLayerIndex = resumeLayerIndex;
    this.state.currentLayerIndex = resumeLayerIndex;

    return true;
  }

  // ============================================================
  // DEFAULT CALLBACKS
  // ============================================================

  /**
   * Default node dispatch (no-op, returns success).
   */
  private async defaultNodeDispatch(node: DAGNode): Promise<NodeResult> {
    return {
      nodeId: node.id,
      success: true,
      artifacts: [],
    };
  }

  /**
   * Default gate evaluation (no-op, returns empty array).
   */
  private async defaultGateEvaluate(
    layer: DAGLayer,
    nodes: DAGNode[]
  ): Promise<GateEvaluationInput[]> {
    return [];
  }

  /**
   * Default escalation handler (no-op).
   */
  private async defaultEscalation(decision: EscalationDecision): Promise<void> {
    // No-op by default
  }
}

// ============================================================
// CONVENIENCE FACTORY
// ============================================================

/**
 * Create a new orchestrator instance.
 */
export function createOrchestrator(config: OrchestratorConfig): Orchestrator {
  return new Orchestrator(config);
}
