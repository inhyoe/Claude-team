/**
 * Claude Team - Communication Protocol
 *
 * JSON schema contracts for structured inter-agent messaging.
 * All messages are validated before routing through the message bus.
 */

import type {
  MessageType,
  ChannelType,
  TeamMessage,
  RoleType,
  GateVerdict,
  ArtifactType,
  ReviewDimensions,
} from '../shared/types.js';

// ============================================================
// MESSAGE PAYLOAD SCHEMAS
// ============================================================

export interface TaskAssignmentPayload {
  taskId: string;
  subject: string;
  description: string;
  fileOwnership: string[];
  priority: number;
  sprintId?: string;
  dagNodeId?: string;
}

export interface StatusReportPayload {
  taskId: string;
  status: 'started' | 'in-progress' | 'completed' | 'blocked' | 'failed';
  progress: number; // 0-100
  summary: string;
  filesModified?: string[];
  blockerDescription?: string;
}

export interface ReviewRequestPayload {
  taskId: string;
  artifactPath: string;
  artifactType: ArtifactType;
  reviewType: 'code-review' | 'qa-review' | 'security-review' | 'design-review';
  changedFiles: string[];
  description: string;
}

export interface ReviewResultPayload {
  taskId: string;
  verdict: GateVerdict;
  score: number;
  dimensions: ReviewDimensions;
  feedback: string;
  attempt: number;
  maxAttempts: number;
  requiresRework: boolean;
  reworkGuidance?: string;
}

export interface EscalationPayload {
  taskId: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  reason: string;
  suggestedAction?: string;
  context: Record<string, unknown>;
}

export interface ArtifactHandoffPayload {
  artifactId: string;
  artifactType: ArtifactType;
  filePath: string;
  producedBy: RoleType;
  consumedBy: RoleType;
  description: string;
}

export interface GateResultPayload {
  gateType: string;
  verdict: GateVerdict;
  score: number;
  taskId: string;
  feedback: string;
}

// Map message types to their payload types
export type MessagePayloadMap = {
  task_assignment: TaskAssignmentPayload;
  status_report: StatusReportPayload;
  review_request: ReviewRequestPayload;
  review_result: ReviewResultPayload;
  escalation: EscalationPayload;
  artifact_handoff: ArtifactHandoffPayload;
  gate_result: GateResultPayload;
};

// ============================================================
// MESSAGE FACTORY
// ============================================================

/**
 * Create a validated team message with typed payload.
 */
export function createMessage<T extends MessageType>(
  type: T,
  from: RoleType,
  to: RoleType | 'all',
  payload: MessagePayloadMap[T],
  channel: ChannelType = 'dm'
): TeamMessage {
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    id,
    fromRole: from,
    toRole: to,
    messageType: type,
    channel,
    content: JSON.stringify(payload),
    metadata: { ...payload },
    timestamp: new Date().toISOString(),
  };
}

// ============================================================
// MESSAGE VALIDATION
// ============================================================

/**
 * Validate a message payload matches its declared type.
 */
export function validateMessage(message: TeamMessage): { valid: boolean; error?: string } {
  try {
    const payload = typeof message.content === 'string'
      ? JSON.parse(message.content)
      : message.content;

    switch (message.messageType) {
      case 'task_assignment':
        return validateTaskAssignment(payload);
      case 'status_report':
        return validateStatusReport(payload);
      case 'review_request':
        return validateReviewRequest(payload);
      case 'review_result':
        return validateReviewResult(payload);
      case 'escalation':
        return validateEscalation(payload);
      case 'artifact_handoff':
        return validateArtifactHandoff(payload);
      case 'gate_result':
        return validateGateResult(payload);
      default:
        return { valid: false, error: `Unknown message type: ${message.messageType}` };
    }
  } catch {
    return { valid: false, error: 'Invalid JSON content' };
  }
}

function validateTaskAssignment(p: unknown): { valid: boolean; error?: string } {
  const payload = p as Record<string, unknown>;
  if (!payload.taskId || typeof payload.taskId !== 'string') return { valid: false, error: 'Missing taskId' };
  if (!payload.subject || typeof payload.subject !== 'string') return { valid: false, error: 'Missing subject' };
  if (!payload.description || typeof payload.description !== 'string') return { valid: false, error: 'Missing description' };
  return { valid: true };
}

function validateStatusReport(p: unknown): { valid: boolean; error?: string } {
  const payload = p as Record<string, unknown>;
  if (!payload.taskId || typeof payload.taskId !== 'string') return { valid: false, error: 'Missing taskId' };
  if (!payload.status || typeof payload.status !== 'string') return { valid: false, error: 'Missing status' };
  if (typeof payload.progress !== 'number') return { valid: false, error: 'Missing progress' };
  return { valid: true };
}

function validateReviewRequest(p: unknown): { valid: boolean; error?: string } {
  const payload = p as Record<string, unknown>;
  if (!payload.taskId || typeof payload.taskId !== 'string') return { valid: false, error: 'Missing taskId' };
  if (!payload.artifactPath || typeof payload.artifactPath !== 'string') return { valid: false, error: 'Missing artifactPath' };
  if (!payload.reviewType || typeof payload.reviewType !== 'string') return { valid: false, error: 'Missing reviewType' };
  return { valid: true };
}

function validateReviewResult(p: unknown): { valid: boolean; error?: string } {
  const payload = p as Record<string, unknown>;
  if (!payload.taskId || typeof payload.taskId !== 'string') return { valid: false, error: 'Missing taskId' };
  if (!payload.verdict || typeof payload.verdict !== 'string') return { valid: false, error: 'Missing verdict' };
  if (typeof payload.score !== 'number') return { valid: false, error: 'Missing score' };
  return { valid: true };
}

function validateEscalation(p: unknown): { valid: boolean; error?: string } {
  const payload = p as Record<string, unknown>;
  if (!payload.taskId || typeof payload.taskId !== 'string') return { valid: false, error: 'Missing taskId' };
  if (!payload.severity || typeof payload.severity !== 'string') return { valid: false, error: 'Missing severity' };
  if (!payload.reason || typeof payload.reason !== 'string') return { valid: false, error: 'Missing reason' };
  return { valid: true };
}

function validateArtifactHandoff(p: unknown): { valid: boolean; error?: string } {
  const payload = p as Record<string, unknown>;
  if (!payload.artifactId || typeof payload.artifactId !== 'string') return { valid: false, error: 'Missing artifactId' };
  if (!payload.filePath || typeof payload.filePath !== 'string') return { valid: false, error: 'Missing filePath' };
  return { valid: true };
}

function validateGateResult(p: unknown): { valid: boolean; error?: string } {
  const payload = p as Record<string, unknown>;
  if (!payload.gateType || typeof payload.gateType !== 'string') return { valid: false, error: 'Missing gateType' };
  if (!payload.verdict || typeof payload.verdict !== 'string') return { valid: false, error: 'Missing verdict' };
  if (typeof payload.score !== 'number') return { valid: false, error: 'Missing score' };
  return { valid: true };
}

// ============================================================
// ROUTING RULES
// ============================================================
// NOTE: These permissions are enforced by MessageBus.route() but NOT
// by the MCP bridge, which operates on JSON state files directly.
// Permissions are advisory when messages bypass the MessageBus.

/** Defines which roles can send which message types. */
export const SEND_PERMISSIONS: Record<MessageType, RoleType[]> = {
  task_assignment: ['pm', 'pl'],
  status_report: ['fe-dev', 'be-dev', 'ui-ux-designer', 'devops-engineer', 'dba'],
  review_request: ['fe-dev', 'be-dev', 'ui-ux-designer', 'devops-engineer', 'dba', 'pl'],
  review_result: ['qa-engineer', 'security-specialist', 'pl'],
  escalation: ['pm', 'pl', 'fe-dev', 'be-dev', 'qa-engineer', 'ui-ux-designer', 'devops-engineer', 'security-specialist', 'dba'],
  artifact_handoff: ['pm', 'pl', 'fe-dev', 'be-dev', 'ui-ux-designer', 'devops-engineer', 'dba'],
  gate_result: ['qa-engineer', 'security-specialist', 'pl'],
};

/** Defines which roles can receive which message types. */
export const RECEIVE_PERMISSIONS: Record<MessageType, RoleType[] | 'all'> = {
  task_assignment: ['fe-dev', 'be-dev', 'ui-ux-designer', 'devops-engineer', 'dba', 'qa-engineer', 'security-specialist'],
  status_report: ['pm', 'pl'],
  review_request: ['qa-engineer', 'security-specialist', 'pl'],
  review_result: ['pl', 'fe-dev', 'be-dev', 'ui-ux-designer', 'devops-engineer', 'dba'],
  escalation: ['pl', 'pm'],
  artifact_handoff: 'all',
  gate_result: ['pl', 'pm'],
};

/**
 * Check if a role can send a specific message type.
 */
export function canSend(role: RoleType, messageType: MessageType): boolean {
  return SEND_PERMISSIONS[messageType].includes(role);
}

/**
 * Check if a role can receive a specific message type.
 */
export function canReceive(role: RoleType, messageType: MessageType): boolean {
  const perms = RECEIVE_PERMISSIONS[messageType];
  return perms === 'all' || perms.includes(role);
}
