/**
 * Claude Team - Role Merger
 *
 * Merges roles based on complexity to achieve 1-4 agent optimization.
 * Rules: No cross-layer merging, same provider only.
 */

import type { RoleType, RoleAssignment, ComplexityScore, DAGLayerType, ProviderType } from '../shared/types.js';
import { ROLE_DEFINITIONS, MERGE_CONFIGURATIONS } from '../shared/constants.js';

export interface MergeResult {
  assignments: RoleAssignment[];
  mergeLog: string[];
}

/**
 * Merge roles based on complexity score.
 * Returns optimized role assignments (1-4 agents).
 */
export function mergeRoles(complexity: ComplexityScore): MergeResult {
  const config = MERGE_CONFIGURATIONS[complexity.level];
  const assignments: RoleAssignment[] = [];
  const mergeLog: string[] = [];

  for (const slot of config.layout) {
    const primaryRole = slot.roles[0];
    const def = ROLE_DEFINITIONS[primaryRole];
    const mergedRoles = slot.roles.slice(1);

    const assignment: RoleAssignment = {
      roleId: `role-${slot.name.toLowerCase()}-${Date.now()}`,
      role: primaryRole,
      dagLayer: slot.dagLayer,
      personaName: def.persona,
      agentName: '',
      provider: slot.provider,
      model: slot.model,
      isMergedInto: null,
      mergedRoles,
      status: 'active',
    };

    assignments.push(assignment);

    if (mergedRoles.length > 0) {
      mergeLog.push(
        `${slot.name}: ${primaryRole} absorbs [${mergedRoles.join(', ')}] (${slot.dagLayer}/${slot.provider})`
      );
    } else {
      mergeLog.push(`${slot.name}: ${primaryRole} standalone (${slot.dagLayer}/${slot.provider})`);
    }
  }

  mergeLog.unshift(`Complexity: ${complexity.level} (${complexity.score.toFixed(2)}) → ${config.agentCount} agents`);

  return { assignments, mergeLog };
}

/**
 * Validate that a merge configuration doesn't violate rules.
 * Cross-layer merging is allowed if mergeableWith permits it (for low-complexity tasks).
 */
export function validateMerge(roles: RoleType[]): { valid: boolean; error?: string } {
  if (roles.length === 0) return { valid: false, error: 'No roles to merge' };
  if (roles.length === 1) return { valid: true };

  // Check same provider
  const providers = new Set(roles.map(r => ROLE_DEFINITIONS[r]?.provider));
  if (providers.size > 1) {
    return {
      valid: false,
      error: `Cannot merge across providers: ${[...providers].join(', ')}`,
    };
  }

  // Check mergeability
  for (const role of roles) {
    const def = ROLE_DEFINITIONS[role];
    if (!def) return { valid: false, error: `Unknown role: ${role}` };

    for (const other of roles) {
      if (other === role) continue;
      if (!def.mergeableWith.includes(other)) {
        // Check if other can merge with role
        const otherDef = ROLE_DEFINITIONS[other];
        if (!otherDef?.mergeableWith.includes(role)) {
          return {
            valid: false,
            error: `${role} and ${other} are not mergeable`,
          };
        }
      }
    }
  }

  return { valid: true };
}

/**
 * Get the effective capabilities of a merged role.
 */
export function getMergedCapabilities(primaryRole: RoleType, mergedRoles: RoleType[]): string[] {
  const capabilities = new Set<string>();

  const primary = ROLE_DEFINITIONS[primaryRole];
  if (primary) {
    for (const cap of primary.capabilities) {
      capabilities.add(cap);
    }
  }

  for (const role of mergedRoles) {
    const def = ROLE_DEFINITIONS[role];
    if (def) {
      for (const cap of def.capabilities) {
        capabilities.add(cap);
      }
    }
  }

  return [...capabilities];
}

/**
 * Suggest optimal role configuration for a given agent count.
 *
 * Note on case 1: Single-agent mode assigns all roles to one agent, which intentionally
 * ignores merge constraints (mergeableWith). This is a deliberate design choice for
 * minimal-resource scenarios. "1-agent mode uses a single agent for all roles ignoring
 * merge constraints."
 *
 * Cases 2-4 are constructed to satisfy mergeableWith constraints:
 *   pm.mergeableWith = ['pl']
 *   pl.mergeableWith = ['pm', 'fe-dev', 'be-dev', 'qa-engineer']
 *   fe-dev.mergeableWith = ['ui-ux-designer', 'pl', 'be-dev']
 *   be-dev.mergeableWith = ['dba', 'pl', 'fe-dev']
 *   qa-engineer.mergeableWith = ['security-specialist', 'pl']
 */
export function suggestRoleConfig(agentCount: number): RoleType[][] {
  // Clamp to supported range (1-4 agents per design constraint)
  const clamped = Math.max(1, Math.min(agentCount, 4));
  switch (clamped) {
    case 1:
      // Single-agent mode: all roles in one agent, merge constraints intentionally bypassed.
      return [['pl', 'pm', 'fe-dev', 'be-dev', 'qa-engineer']];
    case 2:
      // pl mergeableWith includes pm, fe-dev, be-dev; fe-dev mergeableWith includes be-dev
      return [['pl', 'pm'], ['fe-dev', 'be-dev']];
    case 3:
      // pm standalone; pl mergeableWith fe-dev and be-dev; qa standalone
      return [['pm'], ['pl', 'fe-dev', 'be-dev'], ['qa-engineer']];
    case 4:
      // pm standalone; pl standalone; fe-dev mergeableWith be-dev; qa mergeableWith security-specialist
      return [['pm'], ['pl'], ['fe-dev', 'be-dev'], ['qa-engineer', 'security-specialist']];
    default:
      return [['pl']]; // unreachable after clamp
  }
}
