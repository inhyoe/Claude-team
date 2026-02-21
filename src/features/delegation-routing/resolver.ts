/**
 * Claude Team - Delegation Routing Resolver
 *
 * Maps roles to providers and resolves the appropriate delegation tool.
 * Handles provider fallback when primary provider is unavailable.
 */

import type {
  RoleType,
  ProviderType,
  ModelType,
  DelegationTool,
} from '../../shared/types.js';
import {
  ROLE_DEFINITIONS,
  PROVIDER_TOOL_MAP,
  PROVIDER_FALLBACK,
} from '../../shared/constants.js';

// ============================================================
// DELEGATION RESOLUTION
// ============================================================

export interface DelegationTarget {
  tool: DelegationTool;
  provider: ProviderType;
  model: ModelType;
  isFallback: boolean;
  reason: string;
}

/**
 * Resolve the delegation target for a role.
 */
export function resolveDelegation(
  role: RoleType,
  providerOverride?: ProviderType,
  modelOverride?: ModelType
): DelegationTarget {
  const roleDef = ROLE_DEFINITIONS[role];
  if (!roleDef) {
    return {
      tool: 'Task',
      provider: 'claude',
      model: 'sonnet',
      isFallback: true,
      reason: `Unknown role: ${role}, defaulting to Claude`,
    };
  }

  const provider = providerOverride ?? roleDef.provider;
  const model = modelOverride ?? roleDef.model;
  const tool = PROVIDER_TOOL_MAP[provider];

  return {
    tool,
    provider,
    model,
    isFallback: false,
    reason: `${role} (${roleDef.persona}) -> ${provider}/${model}`,
  };
}

/**
 * Resolve with fallback if primary provider check fails.
 */
export function resolveDelegationWithFallback(
  role: RoleType,
  availableProviders: Set<ProviderType>
): DelegationTarget {
  const primary = resolveDelegation(role);

  if (availableProviders.has(primary.provider)) {
    return primary;
  }

  // Use fallback
  const fallbackProvider = PROVIDER_FALLBACK[primary.provider];
  if (availableProviders.has(fallbackProvider)) {
    return {
      tool: PROVIDER_TOOL_MAP[fallbackProvider],
      provider: fallbackProvider,
      model: fallbackProvider === 'claude' ? 'sonnet' : primary.model,
      isFallback: true,
      reason: `${role} fallback: ${primary.provider} unavailable, using ${fallbackProvider}`,
    };
  }

  // Last resort: Claude
  return {
    tool: 'Task',
    provider: 'claude',
    model: 'sonnet',
    isFallback: true,
    reason: `${role} last-resort fallback to Claude sonnet`,
  };
}

// ============================================================
// BATCH RESOLUTION
// ============================================================

/**
 * Resolve delegation targets for multiple roles.
 */
export function resolveTeamDelegations(
  roles: RoleType[],
  availableProviders?: Set<ProviderType>
): Map<RoleType, DelegationTarget> {
  const result = new Map<RoleType, DelegationTarget>();

  for (const role of roles) {
    const target = availableProviders
      ? resolveDelegationWithFallback(role, availableProviders)
      : resolveDelegation(role);
    result.set(role, target);
  }

  return result;
}

/**
 * Get a summary of provider distribution for a team.
 */
export function getProviderDistribution(
  delegations: Map<RoleType, DelegationTarget>
): Record<ProviderType, RoleType[]> {
  const dist: Record<ProviderType, RoleType[]> = {
    claude: [],
    codex: [],
    gemini: [],
  };

  for (const [role, target] of delegations) {
    dist[target.provider].push(role);
  }

  return dist;
}

/**
 * Check if MCP tools are needed for a team configuration.
 */
export function needsMcpTools(delegations: Map<RoleType, DelegationTarget>): {
  needsCodex: boolean;
  needsGemini: boolean;
} {
  let needsCodex = false;
  let needsGemini = false;

  for (const target of delegations.values()) {
    if (target.provider === 'codex') needsCodex = true;
    if (target.provider === 'gemini') needsGemini = true;
  }

  return { needsCodex, needsGemini };
}
