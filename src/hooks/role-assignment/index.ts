/**
 * Claude Team - Role Assignment Hook
 *
 * Automatically handles role reassignment and provider failover
 * when nodes fail or layers complete.
 *
 * Pattern: Event-driven hook that listens for lifecycle events
 * and triggers role management actions.
 */

import type { HookRegistry, NodeEvent, LayerEvent } from '../lifecycle.js';
import type {
  RoleAssignmentHookConfig,
  RoleReassignmentEvent,
  RoleFailoverResult,
} from './types.js';
import { PROVIDER_FALLBACK, ROLE_DEFINITIONS } from '../../shared/constants.js';
import type { DAGLayerType, ProviderType, RoleType } from '../../shared/types.js';
import { nowIso } from '../../shared/utils.js';
import { getDb } from '../../persistence/db.js';

// Map from role type to its dagLayer, derived from ROLE_DEFINITIONS
const ROLE_DEFINITIONS_MAP: Record<string, DAGLayerType> = Object.fromEntries(
  Object.entries(ROLE_DEFINITIONS).map(([role, def]) => [role, def.dagLayer])
);

/**
 * Create a role assignment hook that handles failover and idle detection.
 */
export function createRoleAssignmentHook(
  config: RoleAssignmentHookConfig,
  hooks: HookRegistry
): { detach: () => void } {
  const enableFailover = config.enableProviderFailover ?? true;
  const enableIdle = config.enableIdleDetection ?? true;
  const unsubs: Array<() => void> = [];

  // Track active roles per layer
  const activeRolesPerLayer = new Map<number, Set<string>>();

  // Listen for node:failed events - trigger reassignment check
  if (enableFailover) {
    unsubs.push(hooks.on('node:failed', async (event) => {
      const nodeEvent = event as NodeEvent;
      const { nodeId, taskId, roleId, layerIndex } = nodeEvent.data;

      // Attempt provider failover
      const failoverResult = await attemptProviderFailover(
        config,
        roleId,
        nodeId,
        taskId,
        'node-failure'
      );

      if (failoverResult && config.onRoleReassignment) {
        // Use dagLayer from node event data if available, otherwise derive from role, fallback to 'worker'
        const eventDagLayer = nodeEvent.data.dagLayer as DAGLayerType | undefined;
        const derivedDagLayer = eventDagLayer ?? (extractRoleFromRoleId(roleId)
          ? (ROLE_DEFINITIONS_MAP[extractRoleFromRoleId(roleId)!] ?? 'worker')
          : 'worker');
        const reassignmentEvent: RoleReassignmentEvent = {
          roleId: failoverResult.roleId,
          role: failoverResult.role,
          dagLayer: derivedDagLayer,
          failedNodeId: nodeId,
          failedTaskId: taskId,
          previousProvider: failoverResult.previousProvider,
          reason: 'node-failure',
          timestamp: nowIso(),
        };

        await config.onRoleReassignment(reassignmentEvent);
      }

      // Track this role as active in this layer
      if (!activeRolesPerLayer.has(layerIndex)) {
        activeRolesPerLayer.set(layerIndex, new Set());
      }
      activeRolesPerLayer.get(layerIndex)!.delete(roleId);
    }));
  }

  // Listen for node:completed events - track active roles
  unsubs.push(hooks.on('node:completed', async (event) => {
    const nodeEvent = event as NodeEvent;
    const { roleId, layerIndex } = nodeEvent.data;

    // Mark role as active in this layer
    if (!activeRolesPerLayer.has(layerIndex)) {
      activeRolesPerLayer.set(layerIndex, new Set());
    }
    activeRolesPerLayer.get(layerIndex)!.add(roleId);
  }));

  // Listen for layer:completed events - detect idle roles
  if (enableIdle) {
    unsubs.push(hooks.on('layer:completed', async (event) => {
      const layerEvent = event as LayerEvent;
      const { layerIndex } = layerEvent.data;

      // All roles in this layer are now idle
      const rolesInLayer = activeRolesPerLayer.get(layerIndex);
      if (rolesInLayer && config.onRoleIdle) {
        for (const roleId of rolesInLayer) {
          // Extract role type from roleId (format: roleType-uuid)
          const role = extractRoleFromRoleId(roleId);
          if (role) {
            await config.onRoleIdle(roleId, role);
          }
        }
      }

      // Clear this layer's tracking
      activeRolesPerLayer.delete(layerIndex);
    }));
  }

  return {
    detach() {
      for (const unsub of unsubs) unsub();
      activeRolesPerLayer.clear();
    }
  };
}

/**
 * Attempt to failover a role to a fallback provider.
 */
async function attemptProviderFailover(
  config: RoleAssignmentHookConfig,
  roleId: string,
  nodeId: string,
  taskId: string | null,
  reason: RoleReassignmentEvent['reason']
): Promise<RoleFailoverResult | null> {
  // Extract role type from roleId
  const role = extractRoleFromRoleId(roleId);
  if (!role) return null;

  // Get current provider from role assignment (DB lookup with fallback to defaults)
  const currentProvider = getCurrentProvider(roleId, config.cwd, config.projectId);
  if (!currentProvider) return null;

  // Check if there's a fallback available
  const fallbackProvider = PROVIDER_FALLBACK[currentProvider];
  if (fallbackProvider === currentProvider) {
    // No fallback available
    return {
      success: false,
      roleId,
      role,
      previousProvider: currentProvider,
      newProvider: currentProvider,
      reason: 'No fallback provider available',
    };
  }

  // Perform failover
  return {
    success: true,
    roleId,
    role,
    previousProvider: currentProvider,
    newProvider: fallbackProvider,
    reason: `Failover from ${currentProvider} to ${fallbackProvider} due to ${reason}`,
  };
}

// Known role prefixes sorted longest-first to avoid prefix collisions
// (e.g. 'ui-ux-designer' must be checked before shorter prefixes)
const KNOWN_ROLES: RoleType[] = [
  'ui-ux-designer',
  'security-specialist',
  'devops-engineer',
  'qa-engineer',
  'fe-dev',
  'be-dev',
  'pm',
  'pl',
  'dba',
];

/**
 * Extract role type from roleId.
 * Handles UUID suffixes (e.g. qa-engineer-550e8400-e29b-41d4-a716-446655440000)
 * by matching known role prefixes longest-first.
 */
function extractRoleFromRoleId(roleId: string): RoleType | null {
  for (const role of KNOWN_ROLES) {
    if (
      roleId === role ||
      roleId.startsWith(role + '-') ||
      roleId.startsWith(role + '_') ||
      roleId.startsWith(role + '::')
    ) {
      return role;
    }
  }
  return null;
}

/**
 * Get current provider for a role.
 * Looks up from the roles DB table when cwd/projectId are available,
 * falls back to role-based defaults otherwise.
 */
function getCurrentProvider(roleId: string, cwd?: string, projectId?: string): ProviderType | null {
  // Try to look up from DB if context is available
  if (cwd && projectId) {
    try {
      const db = getDb(cwd);
      if (db) {
        const role = extractRoleFromRoleId(roleId);
        const row = db.prepare(
          'SELECT provider FROM roles WHERE project_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1'
        ).get(projectId, role) as { provider: string } | undefined;
        if (row?.provider) return row.provider as ProviderType;
      }
    } catch {
      // Fall through to default
    }
  }

  // Fallback to role-based defaults
  const role = extractRoleFromRoleId(roleId);
  if (!role) return null;

  const ROLE_PROVIDER_DEFAULTS: Record<string, ProviderType> = {
    'pm': 'claude',
    'pl': 'claude',
    'fe-dev': 'claude',
    'be-dev': 'claude',
    'qa-engineer': 'codex',
    'ui-ux-designer': 'claude',
    'devops-engineer': 'codex',
    'security-specialist': 'codex',
    'dba': 'codex',
  };

  return ROLE_PROVIDER_DEFAULTS[role] ?? 'claude';
}
