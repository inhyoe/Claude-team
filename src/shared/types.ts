/**
 * Claude Team - Shared Types
 *
 * Role-based development team simulation types.
 * Extends OMC v4.2.11 type system with Role, Kanban, DAG, and Quality Gate types.
 */

// ============================================================
// MODEL & PROVIDER TYPES
// ============================================================

export type ModelType = 'sonnet' | 'opus' | 'haiku' | 'inherit';

export type ProviderType = 'claude' | 'codex' | 'gemini';

export type DelegationTool = 'Task' | 'ask_codex' | 'ask_gemini';

// ============================================================
// ROLE SYSTEM
// ============================================================

export type RoleType =
  | 'pm'
  | 'pl'
  | 'fe-dev'
  | 'be-dev'
  | 'qa-engineer'
  | 'ui-ux-designer'
  | 'devops-engineer'
  | 'security-specialist'
  | 'dba';

export type DAGLayerType = 'planner' | 'worker' | 'judge';

export interface RoleDefinition {
  role: RoleType;
  persona: string;
  model: ModelType;
  provider: ProviderType;
  dagLayer: DAGLayerType;
  mergeableWith: RoleType[];
  description: string;
  capabilities: string[];
}

export interface RoleAssignment {
  roleId: string;
  role: RoleType;
  dagLayer: DAGLayerType;
  personaName: string;
  agentName: string;
  provider: ProviderType;
  model: ModelType;
  isMergedInto: string | null;
  mergedRoles: RoleType[];
  status: 'active' | 'idle' | 'completed' | 'failed';
}

// ============================================================
// COMPLEXITY ANALYSIS
// ============================================================

export type ComplexityLevel = 'tiny' | 'small' | 'medium' | 'large';

export interface ComplexityScore {
  level: ComplexityLevel;
  score: number; // 0.0 - 1.0
  factors: {
    fileCount: number;
    crossModuleDeps: number;
    hasTests: boolean;
    hasApiChanges: boolean;
    hasDbChanges: boolean;
    hasSecurityImplications: boolean;
  };
  recommendedAgentCount: number; // 1-4
}

// ============================================================
// DAG TYPES
// ============================================================

export type DAGNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export type DAGNodeType = 'planning' | 'design' | 'execution' | 'verification' | 'deployment';

export interface DAGNode {
  id: string;
  roleId: string;
  layerIndex: number;
  nodeType: DAGNodeType;
  status: DAGNodeStatus;
  dependencies: string[]; // node IDs
  taskId: string | null;
  fileOwnership: string[]; // glob patterns
  estimatedDuration: number | null; // minutes
  startedAt: string | null;
  completedAt: string | null;
}

export interface DAGEdge {
  from: string; // node ID
  to: string;   // node ID
  type: 'dependency' | 'gate';
}

export interface DAGLayer {
  index: number;
  nodeType: DAGNodeType;
  nodes: DAGNode[];
  gateType: GateType | null;
}

export interface ExecutionPlan {
  id: string;
  projectId: string;
  layers: DAGLayer[];
  nodes: Map<string, DAGNode>;
  edges: DAGEdge[];
  currentLayerIndex: number;
  status: 'planning' | 'executing' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// KANBAN TYPES
// ============================================================

export type KanbanStatus =
  | 'backlog'
  | 'todo'
  | 'in-progress'
  | 'review'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export interface KanbanItem {
  id: string;
  /** Same as id. Retained for compatibility with routing/messaging APIs that reference taskId. */
  taskId: string;
  title: string;
  status: KanbanStatus;
  assignedRole: RoleType | null;
  priority: number; // 1 (highest) - 5 (lowest)
  complexityScore: number;
  fileOwnership: string[];
  reviewScore: number | null;
  sprintId: string | null;
  dagNodeId: string | null;
  createdAt: string;
  updatedAt: string;
  movedAt: string;
}

export interface KanbanTransition {
  itemId: string;
  fromStatus: KanbanStatus;
  toStatus: KanbanStatus;
  movedBy: RoleType;
  reason: string;
  timestamp: string;
}

// ============================================================
// QUALITY GATE TYPES
// ============================================================

export type GateType = 'design-review' | 'code-review' | 'qa-review' | 'security-review' | 'pl-approval';

export type GateVerdict = 'pass' | 'conditional' | 'reject' | 'auto-reject';

export interface ReviewDimensions {
  correctness: number;    // 1-10
  security: number;       // 1-10
  performance: number;    // 1-10
  maintainability: number; // 1-10
  testCoverage: number;   // 1-10
}

export interface QualityGateResult {
  id: string;
  gateType: GateType;
  reviewerRole: RoleType;
  taskId: string;
  score: number;          // average of dimensions
  dimensions: ReviewDimensions;
  verdict: GateVerdict;
  feedback: string;
  attempt: number;
  maxAttempts: number;
  createdAt: string;
}

// ============================================================
// COMMUNICATION TYPES
// ============================================================

export type MessageType =
  | 'task_assignment'
  | 'status_report'
  | 'review_request'
  | 'review_result'
  | 'escalation'
  | 'artifact_handoff'
  | 'gate_result';

export type ChannelType = 'dm' | 'broadcast' | 'artifact';

export interface TeamMessage {
  id: string;
  fromRole: RoleType;
  toRole: RoleType | 'all';
  messageType: MessageType;
  channel: ChannelType;
  content: string;
  metadata: Record<string, unknown>;
  timestamp: string;
}

// ============================================================
// ARTIFACT TYPES
// ============================================================

export type ArtifactType = 'prd' | 'api-spec' | 'schema' | 'review-report' | 'test-plan' | 'deploy-config' | 'security-audit';

export type ArtifactStatus = 'draft' | 'review' | 'approved' | 'rejected';

export interface Artifact {
  id: string;
  producedByRole: RoleType;
  artifactType: ArtifactType;
  filePath: string;
  status: ArtifactStatus;
  approvedBy: RoleType | null;
  taskId: string;
  sprintId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// SPRINT TYPES
// ============================================================

export type SprintStatus = 'planning' | 'active' | 'review' | 'completed';

export interface Sprint {
  id: string;
  projectId: string;
  sprintNumber: number;
  goal: string;
  status: SprintStatus;
  velocityScore: number | null;
  taskIds: string[];
  startedAt: string;
  completedAt: string | null;
}

// ============================================================
// PROJECT STATE
// ============================================================

export interface ProjectState {
  id: string;
  name: string;
  path: string;
  sessionId: string;
  status: 'active' | 'paused' | 'completed' | 'failed';
  currentSprintId: string | null;
  executionPlanId: string | null;
  roles: RoleAssignment[];
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// TEAM PIPELINE (Fork of OMC TeamPipelineState)
// ============================================================

export const TEAM_PIPELINE_SCHEMA_VERSION = 2;

export type TeamPipelinePhase =
  | 'team-plan'
  | 'team-prd'
  | 'team-exec'
  | 'team-verify'
  | 'team-fix'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface TeamPhaseHistoryEntry {
  phase: TeamPipelinePhase;
  enteredAt: string;
  reason?: string;
  activeRoles?: RoleType[];
}

export interface TeamPipelineState {
  schemaVersion: number;
  mode: 'claude-team';
  active: boolean;
  sessionId: string;
  projectPath: string;

  phase: TeamPipelinePhase;
  phaseHistory: TeamPhaseHistoryEntry[];

  iteration: number;
  maxIterations: number;

  // Role-specific additions
  roles: RoleAssignment[];
  complexityScore: ComplexityScore | null;
  executionPlanId: string | null;
  currentSprintId: string | null;

  // Kanban tracking
  kanban: {
    backlog: number;
    todo: number;
    inProgress: number;
    review: number;
    done: number;
    blocked: number;
    failed: number;
    cancelled: number;
  };

  // Quality gate tracking
  qualityGates: {
    passed: number;
    failed: number;
    pending: number;
    lastScore: number | null;
  };

  execution: {
    workersTotal: number;
    workersActive: number;
    tasksTotal: number;
    tasksCompleted: number;
    tasksFailed: number;
  };

  fixLoop: {
    attempt: number;
    maxAttempts: number;
    lastFailureReason: string | null;
  };

  cancel: {
    requested: boolean;
    requestedAt: string | null;
    preserveForResume: boolean;
  };

  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TeamTransitionResult {
  ok: boolean;
  state: TeamPipelineState | null;
  reason?: string;
}

// ============================================================
// AGENT CONFIG (Fork of OMC AgentConfig)
// ============================================================

export interface AgentConfig {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: ModelType;
  defaultModel?: ModelType;
  role?: RoleType;
  provider?: ProviderType;
  dagLayer?: DAGLayerType;
}
