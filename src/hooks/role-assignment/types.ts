/**
 * Claude Team - Role Assignment Hook Types
 *
 * Type definitions for role reassignment and failover.
 */

import type { RoleType, ProviderType, DAGLayerType } from '../../shared/types.js';

export interface RoleAssignmentHookConfig {
  cwd: string;
  projectId: string;

  // Enable automatic failover to fallback providers
  enableProviderFailover?: boolean; // default: true

  // Enable automatic role idle detection
  enableIdleDetection?: boolean; // default: true

  // Callback when a role needs reassignment
  onRoleReassignment?: (event: RoleReassignmentEvent) => Promise<void>;

  // Callback when a role becomes idle
  onRoleIdle?: (roleId: string, role: RoleType) => Promise<void>;
}

export interface RoleReassignmentEvent {
  roleId: string;
  role: RoleType;
  dagLayer: DAGLayerType;
  failedNodeId: string;
  failedTaskId: string | null;
  previousProvider: ProviderType;
  reason: 'node-failure' | 'provider-unavailable' | 'manual';
  timestamp: string;
}

export interface RoleFailoverResult {
  success: boolean;
  roleId: string;
  role: RoleType;
  previousProvider: ProviderType;
  newProvider: ProviderType;
  reason: string;
}
