/**
 * Claude Team - Constants
 *
 * Role definitions, provider mappings, and configuration constants.
 */

import type {
  RoleType,
  RoleDefinition,
  ComplexityLevel,
  KanbanStatus,
  GateVerdict,
  DAGLayerType,
  ProviderType,
  DelegationTool,
} from './types.js';

// ============================================================
// ROLE DEFINITIONS
// ============================================================

export const ROLE_DEFINITIONS: Record<RoleType, RoleDefinition> = {
  'pm': {
    role: 'pm',
    persona: 'Alex',
    model: 'opus',
    provider: 'claude',
    dagLayer: 'planner',
    mergeableWith: ['pl'],
    description: 'Project Manager - Requirements, priorities, stakeholder communication',
    capabilities: ['requirements-analysis', 'priority-management', 'prd-creation', 'sprint-planning'],
  },
  'pl': {
    role: 'pl',
    persona: 'Jordan',
    model: 'opus',
    provider: 'claude',
    dagLayer: 'planner',
    mergeableWith: ['pm', 'fe-dev', 'be-dev', 'qa-engineer'],
    description: 'Project Lead / Tech Lead - Architecture, technical decisions, conflict resolution',
    capabilities: ['architecture-design', 'api-design', 'code-review', 'conflict-resolution', 'file-ownership-assignment'],
  },
  'fe-dev': {
    role: 'fe-dev',
    persona: 'Sam',
    model: 'sonnet',
    provider: 'claude',
    dagLayer: 'worker',
    mergeableWith: ['ui-ux-designer', 'pl', 'be-dev'],
    description: 'Frontend Developer - UI implementation, client-side logic',
    capabilities: ['frontend-implementation', 'component-development', 'state-management', 'responsive-design'],
  },
  'be-dev': {
    role: 'be-dev',
    persona: 'Morgan',
    model: 'sonnet',
    provider: 'claude',
    dagLayer: 'worker',
    mergeableWith: ['dba', 'pl', 'fe-dev'],
    description: 'Backend Developer - API implementation, business logic, server-side code',
    capabilities: ['api-implementation', 'business-logic', 'database-queries', 'middleware'],
  },
  'qa-engineer': {
    role: 'qa-engineer',
    persona: 'Riley',
    model: 'sonnet',
    provider: 'codex',
    dagLayer: 'judge',
    mergeableWith: ['security-specialist', 'pl'],
    description: 'QA Engineer - Test strategy, test execution, quality verification',
    capabilities: ['test-strategy', 'test-execution', 'regression-testing', 'code-review'],
  },
  'ui-ux-designer': {
    role: 'ui-ux-designer',
    persona: 'Taylor',
    model: 'sonnet',
    provider: 'claude',
    dagLayer: 'worker',
    mergeableWith: ['fe-dev'],
    description: 'UI/UX Designer - User experience, visual design, prototyping',
    capabilities: ['ui-design', 'ux-research', 'prototyping', 'accessibility'],
  },
  'devops-engineer': {
    role: 'devops-engineer',
    persona: 'Casey',
    model: 'sonnet',
    provider: 'codex',
    dagLayer: 'worker',
    mergeableWith: ['security-specialist'],
    description: 'DevOps Engineer - CI/CD, deployment, infrastructure',
    capabilities: ['ci-cd', 'deployment', 'infrastructure', 'monitoring', 'docker'],
  },
  'security-specialist': {
    role: 'security-specialist',
    persona: 'Avery',
    model: 'opus',
    provider: 'codex',
    dagLayer: 'judge',
    mergeableWith: ['qa-engineer'],
    description: 'Security Specialist - Security audits, vulnerability assessment, compliance',
    capabilities: ['security-audit', 'vulnerability-assessment', 'penetration-testing', 'compliance'],
  },
  'dba': {
    role: 'dba',
    persona: 'Drew',
    model: 'sonnet',
    provider: 'codex',
    dagLayer: 'worker',
    mergeableWith: ['be-dev'],
    description: 'Database Administrator - Schema design, query optimization, data modeling',
    capabilities: ['schema-design', 'query-optimization', 'data-modeling', 'migration'],
  },
};

// ============================================================
// COMPLEXITY THRESHOLDS
// ============================================================

export const COMPLEXITY_THRESHOLDS: Record<ComplexityLevel, { min: number; max: number; agentCount: number }> = {
  'tiny':   { min: 0.0, max: 0.2, agentCount: 1 },
  'small':  { min: 0.2, max: 0.4, agentCount: 2 },
  'medium': { min: 0.4, max: 0.7, agentCount: 3 },
  'large':  { min: 0.7, max: 1.0, agentCount: 4 },
};

// ============================================================
// ROLE MERGE CONFIGURATIONS
// ============================================================

export interface MergeConfiguration {
  agentCount: number;
  layout: Array<{
    name: string;
    roles: RoleType[];
    dagLayer: DAGLayerType;
    provider: ProviderType;
    model: 'opus' | 'sonnet';
  }>;
}

export const MERGE_CONFIGURATIONS: Record<ComplexityLevel, MergeConfiguration> = {
  'tiny': {
    agentCount: 1,
    layout: [
      { name: 'Lead', roles: ['pl', 'pm', 'fe-dev', 'be-dev', 'qa-engineer'], dagLayer: 'planner', provider: 'claude', model: 'opus' },
    ],
  },
  'small': {
    agentCount: 2,
    layout: [
      { name: 'Lead', roles: ['pl', 'pm'], dagLayer: 'planner', provider: 'claude', model: 'opus' },
      { name: 'Worker', roles: ['fe-dev', 'be-dev'], dagLayer: 'worker', provider: 'claude', model: 'sonnet' },
    ],
  },
  'medium': {
    agentCount: 3,
    layout: [
      { name: 'PM', roles: ['pm'], dagLayer: 'planner', provider: 'claude', model: 'opus' },
      { name: 'Lead+Worker', roles: ['pl', 'fe-dev', 'be-dev'], dagLayer: 'worker', provider: 'claude', model: 'sonnet' },
      { name: 'QA', roles: ['qa-engineer'], dagLayer: 'judge', provider: 'codex', model: 'sonnet' },
    ],
  },
  'large': {
    agentCount: 4,
    layout: [
      { name: 'PM', roles: ['pm'], dagLayer: 'planner', provider: 'claude', model: 'opus' },
      { name: 'PL', roles: ['pl'], dagLayer: 'planner', provider: 'claude', model: 'opus' },
      { name: 'Dev', roles: ['fe-dev', 'be-dev'], dagLayer: 'worker', provider: 'claude', model: 'sonnet' },
      { name: 'QA+Security', roles: ['qa-engineer', 'security-specialist'], dagLayer: 'judge', provider: 'codex', model: 'sonnet' },
    ],
  },
};

// ============================================================
// KANBAN VALID TRANSITIONS
// ============================================================

export const VALID_KANBAN_TRANSITIONS: Record<KanbanStatus, KanbanStatus[]> = {
  'backlog':     ['todo', 'blocked', 'cancelled'],
  'todo':        ['in-progress', 'blocked', 'backlog', 'cancelled'],
  'in-progress': ['review', 'blocked', 'failed', 'cancelled'],
  'review':      ['done', 'in-progress', 'failed', 'cancelled'], // in-progress = review rejected
  'done':        [], // terminal
  'blocked':     ['todo', 'in-progress', 'backlog', 'failed', 'cancelled'],
  'failed':      ['backlog', 'todo', 'cancelled'], // can retry or cancel
  'cancelled':   [], // terminal
};

// ============================================================
// QUALITY GATE THRESHOLDS
// ============================================================

export const QUALITY_GATE_THRESHOLDS: Record<GateVerdict, { minScore: number; maxScore: number; minDimension: number }> = {
  'pass':        { minScore: 7.0, maxScore: 10.0, minDimension: 3 },
  'conditional': { minScore: 5.0, maxScore: 6.9,  minDimension: 2 },
  'reject':      { minScore: 3.0, maxScore: 4.9,  minDimension: 1 },
  'auto-reject': { minScore: 0.0, maxScore: 2.9,  minDimension: 0 },
};

export const MAX_REVIEW_ATTEMPTS = 3;

// ============================================================
// PROVIDER CONFIGURATION
// ============================================================

export const PROVIDER_TOOL_MAP: Record<ProviderType, DelegationTool> = {
  'claude': 'Task',
  'codex': 'ask_codex',
  'gemini': 'ask_gemini',
};

export const PROVIDER_FALLBACK: Record<ProviderType, ProviderType> = {
  'claude': 'claude',   // no fallback needed
  'codex': 'claude',    // fallback to claude sonnet
  'gemini': 'claude',   // fallback to claude sonnet
};

// ============================================================
// DATABASE CONSTANTS
// ============================================================

export const DB_NAME = 'claude-team.db';
export const DB_SCHEMA_VERSION = 3;
export const DB_STATE_DIR = '.omc/state';

// ============================================================
// ARTIFACT PATHS
// ============================================================

export const ARTIFACT_BASE_DIR = '.omc/artifacts';

// ============================================================
// TIMEOUTS
// ============================================================

export const WORKER_TIMEOUT_MS = 15 * 60 * 1000;    // 15 minutes per layer
