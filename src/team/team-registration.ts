/**
 * Claude Team - Team Registration
 *
 * Role-aware team registration and Claude Code team integration.
 * Maps CT role assignments to Claude Code's TeamCreate/Task team APIs.
 */

import type {
  RoleType,
  ProviderType,
  ModelType,
  ComplexityScore,
} from '../shared/types.js';
import { ROLE_DEFINITIONS, PROVIDER_TOOL_MAP } from '../shared/constants.js';
import type { TeamMember, TeamConfiguration } from './unified-team.js';

// ============================================================
// REGISTRATION TYPES
// ============================================================

export interface TeamRegistration {
  teamName: string;
  description: string;
  members: RegisteredMember[];
  createdAt: string;
}

export interface RegisteredMember {
  name: string;
  role: RoleType;
  agentType: string;       // OMC subagent_type for Claude, or 'mcp_codex'/'mcp_gemini'
  model: ModelType;
  provider: ProviderType;
  spawnConfig: ClaudeSpawnConfig | McpSpawnConfig;
}

export interface ClaudeSpawnConfig {
  type: 'claude';
  subagentType: string;
  teamName: string;
  name: string;
  prompt: string;
  mode?: string;
}

export interface McpSpawnConfig {
  type: 'mcp';
  tool: string;          // 'ask_codex' or 'ask_gemini'
  promptFile: string;
  outputFile: string;
  workingDirectory: string;
}

// ============================================================
// TEAM REGISTRATION
// ============================================================

/**
 * Convert a TeamConfiguration into spawn configurations for Claude Code.
 */
export function registerTeam(
  teamName: string,
  description: string,
  config: TeamConfiguration,
  workingDirectory: string
): TeamRegistration {
  const members: RegisteredMember[] = config.members.map(member => ({
    name: member.name,
    role: member.role,
    agentType: resolveAgentType(member),
    model: member.model,
    provider: member.provider,
    spawnConfig: buildSpawnConfig(member, teamName, workingDirectory),
  }));

  return {
    teamName,
    description,
    members,
    createdAt: new Date().toISOString(),
  };
}

// ============================================================
// AGENT TYPE RESOLUTION
// ============================================================

/**
 * Map a role to the appropriate OMC subagent type.
 */
function resolveAgentType(member: TeamMember): string {
  if (member.provider !== 'claude') {
    return `mcp_${member.provider}`;
  }

  // Map roles to OMC subagent types
  const roleToAgent: Record<RoleType, string> = {
    'pm': 'oh-my-claudecode:planner',
    'pl': 'oh-my-claudecode:architect',
    'fe-dev': 'oh-my-claudecode:executor',
    'be-dev': 'oh-my-claudecode:executor',
    'qa-engineer': 'oh-my-claudecode:test-engineer',
    'ui-ux-designer': 'oh-my-claudecode:designer',
    'devops-engineer': 'oh-my-claudecode:executor',
    'security-specialist': 'oh-my-claudecode:security-reviewer',
    'dba': 'oh-my-claudecode:executor',
  };

  return roleToAgent[member.role] ?? 'oh-my-claudecode:executor';
}

// ============================================================
// SPAWN CONFIG BUILDERS
// ============================================================

/**
 * Build the appropriate spawn configuration for a team member.
 */
function buildSpawnConfig(
  member: TeamMember,
  teamName: string,
  workingDirectory: string
): ClaudeSpawnConfig | McpSpawnConfig {
  if (member.provider === 'claude') {
    return buildClaudeSpawnConfig(member, teamName);
  }
  return buildMcpSpawnConfig(member, teamName, workingDirectory);
}

/**
 * Build Claude Code Task tool spawn config.
 */
function buildClaudeSpawnConfig(member: TeamMember, teamName: string): ClaudeSpawnConfig {
  return {
    type: 'claude',
    subagentType: resolveAgentType(member),
    teamName,
    name: member.name,
    prompt: member.preamble,
  };
}

/**
 * Build MCP (Codex/Gemini) spawn config.
 */
function buildMcpSpawnConfig(
  member: TeamMember,
  teamName: string,
  workingDirectory: string
): McpSpawnConfig {
  const tool = PROVIDER_TOOL_MAP[member.provider];
  const basePath = `.omc/state/${teamName}`;

  return {
    type: 'mcp',
    tool,
    promptFile: `${basePath}/${member.name}-prompt.md`,
    outputFile: `${basePath}/${member.name}-output.md`,
    workingDirectory,
  };
}

// ============================================================
// TEAM CREATE HELPERS
// ============================================================

/**
 * Generate a team slug from a description.
 */
export function generateTeamSlug(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 40)
    .replace(/-$/, '');
}

/**
 * Build the TeamCreate payload for Claude Code.
 */
export function buildTeamCreatePayload(
  teamName: string,
  description: string
): { team_name: string; description: string } {
  return { team_name: teamName, description };
}

/**
 * Build a Task tool spawn payload for a Claude team member.
 */
export function buildTaskSpawnPayload(
  config: ClaudeSpawnConfig
): {
  subagent_type: string;
  team_name: string;
  name: string;
  prompt: string;
  description: string;
} {
  return {
    subagent_type: config.subagentType,
    team_name: config.teamName,
    name: config.name,
    prompt: config.prompt,
    description: `Spawn ${config.name}`,
  };
}

// ============================================================
// TEAM STATUS
// ============================================================

/**
 * Format a team registration for display.
 */
export function formatRegistration(reg: TeamRegistration): string {
  const lines: string[] = [
    `Team: ${reg.teamName}`,
    `Description: ${reg.description}`,
    `Members: ${reg.members.length}`,
    '',
  ];

  for (const m of reg.members) {
    const providerTag = m.provider === 'claude' ? 'Claude' :
      m.provider === 'codex' ? 'Codex' : 'Gemini';
    lines.push(`  ${m.name}: ${m.role} [${providerTag}/${m.model}] -> ${m.agentType}`);
  }

  return lines.join('\n');
}
