/**
 * Claude Team - Agent Definitions
 *
 * 9 role-based agent registry replacing OMC's 30+ generic agents.
 * Each agent maps to a development team role with specific persona.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AgentConfig, RoleType, ModelType } from '../shared/types.js';
import { ROLE_DEFINITIONS } from '../shared/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Agents directory relative to dist/agents/
const AGENTS_DIR = join(__dirname, '..', '..', 'agents');

/**
 * Load an agent prompt from the agents/ directory.
 */
export function loadAgentPrompt(name: string): string {
  const promptPath = join(AGENTS_DIR, `${name}.md`);
  if (!existsSync(promptPath)) {
    return `You are the ${name} agent. Follow team protocol and complete assigned tasks.`;
  }
  return readFileSync(promptPath, 'utf-8');
}

/**
 * Load the shared preamble that all agents receive.
 */
export function loadSharedPreamble(): string {
  const preamblePath = join(AGENTS_DIR, '_shared-preamble.md');
  if (!existsSync(preamblePath)) {
    return '';
  }
  return readFileSync(preamblePath, 'utf-8');
}

/**
 * Build a complete agent prompt with shared preamble + role-specific content.
 */
function buildPrompt(roleName: string): string {
  const preamble = loadSharedPreamble();
  const rolePrompt = loadAgentPrompt(roleName);
  return preamble ? `${preamble}\n\n---\n\n${rolePrompt}` : rolePrompt;
}

// ============================================================
// ROLE-BASED AGENT DEFINITIONS
// ============================================================

/**
 * Build an AgentConfig from ROLE_DEFINITIONS to avoid drift.
 */
function agentFromRole(role: RoleType): AgentConfig {
  const def = ROLE_DEFINITIONS[role];
  return {
    name: role,
    description: def.description,
    prompt: buildPrompt(role),
    model: def.model as ModelType,
    defaultModel: def.model as ModelType,
    role,
    provider: def.provider,
    dagLayer: def.dagLayer,
  };
}

export const pmAgent: AgentConfig = agentFromRole('pm');
export const plAgent: AgentConfig = agentFromRole('pl');
export const feDevAgent: AgentConfig = agentFromRole('fe-dev');
export const beDevAgent: AgentConfig = agentFromRole('be-dev');
export const qaEngineerAgent: AgentConfig = agentFromRole('qa-engineer');
export const uiUxDesignerAgent: AgentConfig = agentFromRole('ui-ux-designer');
export const devopsEngineerAgent: AgentConfig = agentFromRole('devops-engineer');
export const securitySpecialistAgent: AgentConfig = agentFromRole('security-specialist');
export const dbaAgent: AgentConfig = agentFromRole('dba');

// ============================================================
// AGENT REGISTRY
// ============================================================

const ALL_AGENTS: Record<string, AgentConfig> = {
  'pm': pmAgent,
  'pl': plAgent,
  'fe-dev': feDevAgent,
  'be-dev': beDevAgent,
  'qa-engineer': qaEngineerAgent,
  'ui-ux-designer': uiUxDesignerAgent,
  'devops-engineer': devopsEngineerAgent,
  'security-specialist': securitySpecialistAgent,
  'dba': dbaAgent,
};

/**
 * Get all agent definitions.
 */
export function getAgentDefinitions(
  overrides?: Partial<Record<string, Partial<AgentConfig>>>
): Record<string, AgentConfig> {
  const result: Record<string, AgentConfig> = {};

  for (const [name, config] of Object.entries(ALL_AGENTS)) {
    const override = overrides?.[name];
    result[name] = {
      ...config,
      ...(override?.description ? { description: override.description } : {}),
      ...(override?.prompt ? { prompt: override.prompt } : {}),
      ...(override?.model ? { model: override.model } : {}),
      ...(override?.tools ? { tools: override.tools } : {}),
    };
  }

  return result;
}

/**
 * Get a single agent by role name.
 */
export function getAgent(role: RoleType): AgentConfig | null {
  return ALL_AGENTS[role] ?? null;
}

/**
 * Get agents by DAG layer.
 */
export function getAgentsByLayer(layer: 'planner' | 'worker' | 'judge'): AgentConfig[] {
  return Object.values(ALL_AGENTS).filter(a => a.dagLayer === layer);
}
