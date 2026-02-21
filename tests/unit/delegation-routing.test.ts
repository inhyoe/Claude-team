/**
 * Delegation Routing Resolver unit tests
 *
 * Tests: role→provider resolution, fallback logic, batch resolution, provider distribution.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveDelegation,
  resolveDelegationWithFallback,
  resolveTeamDelegations,
  getProviderDistribution,
  needsMcpTools,
} from '../../src/features/delegation-routing/resolver.js';
import type { ProviderType, RoleType } from '../../src/shared/types.js';

// ============================================================
// RESOLVE DELEGATION
// ============================================================

describe('resolveDelegation', () => {
  it('should resolve PM to claude/opus', () => {
    const result = resolveDelegation('pm');
    expect(result.provider).toBe('claude');
    expect(result.model).toBe('opus');
    expect(result.tool).toBe('Task');
    expect(result.isFallback).toBe(false);
  });

  it('should resolve QA to codex/sonnet', () => {
    const result = resolveDelegation('qa-engineer');
    expect(result.provider).toBe('codex');
    expect(result.tool).toBe('ask_codex');
    expect(result.isFallback).toBe(false);
  });

  it('should resolve FE Dev to claude/sonnet', () => {
    const result = resolveDelegation('fe-dev');
    expect(result.provider).toBe('claude');
    expect(result.model).toBe('sonnet');
    expect(result.tool).toBe('Task');
  });

  it('should allow provider override', () => {
    const result = resolveDelegation('pm', 'codex');
    expect(result.provider).toBe('codex');
    expect(result.tool).toBe('ask_codex');
  });

  it('should allow model override', () => {
    const result = resolveDelegation('fe-dev', undefined, 'opus');
    expect(result.model).toBe('opus');
  });

  it('should fallback for unknown roles', () => {
    const result = resolveDelegation('unknown-role' as RoleType);
    expect(result.isFallback).toBe(true);
    expect(result.provider).toBe('claude');
    expect(result.model).toBe('sonnet');
  });

  it('should include reason string with role info', () => {
    const result = resolveDelegation('pl');
    expect(result.reason).toContain('pl');
  });
});

// ============================================================
// RESOLVE WITH FALLBACK
// ============================================================

describe('resolveDelegationWithFallback', () => {
  it('should use primary when available', () => {
    const available = new Set<ProviderType>(['claude', 'codex']);
    const result = resolveDelegationWithFallback('pm', available);
    expect(result.provider).toBe('claude');
    expect(result.isFallback).toBe(false);
  });

  it('should use codex fallback when claude unavailable for PM', () => {
    const available = new Set<ProviderType>(['codex']);
    const result = resolveDelegationWithFallback('pm', available);
    // claude falls back to codex
    expect(result.isFallback).toBe(true);
  });

  it('should fallback codex→claude when codex unavailable for QA', () => {
    const available = new Set<ProviderType>(['claude']);
    const result = resolveDelegationWithFallback('qa-engineer', available);
    expect(result.provider).toBe('claude');
    expect(result.isFallback).toBe(true);
    expect(result.model).toBe('sonnet');
  });

  it('should last-resort to claude sonnet when no providers available', () => {
    const available = new Set<ProviderType>();
    const result = resolveDelegationWithFallback('qa-engineer', available);
    expect(result.provider).toBe('claude');
    expect(result.model).toBe('sonnet');
    expect(result.isFallback).toBe(true);
    expect(result.reason).toContain('last-resort');
  });
});

// ============================================================
// BATCH RESOLUTION
// ============================================================

describe('resolveTeamDelegations', () => {
  it('should resolve all roles', () => {
    const roles: RoleType[] = ['pm', 'pl', 'fe-dev', 'qa-engineer'];
    const result = resolveTeamDelegations(roles);
    expect(result.size).toBe(4);
    expect(result.get('pm')?.provider).toBe('claude');
    expect(result.get('qa-engineer')?.provider).toBe('codex');
  });

  it('should respect available providers when provided', () => {
    const roles: RoleType[] = ['pm', 'qa-engineer'];
    const available = new Set<ProviderType>(['claude']);
    const result = resolveTeamDelegations(roles, available);
    // QA should fallback to claude
    expect(result.get('qa-engineer')?.provider).toBe('claude');
    expect(result.get('qa-engineer')?.isFallback).toBe(true);
  });
});

// ============================================================
// PROVIDER DISTRIBUTION
// ============================================================

describe('getProviderDistribution', () => {
  it('should group roles by provider', () => {
    const delegations = resolveTeamDelegations(['pm', 'pl', 'fe-dev', 'qa-engineer', 'security-specialist']);
    const dist = getProviderDistribution(delegations);
    expect(dist.claude).toContain('pm');
    expect(dist.claude).toContain('pl');
    expect(dist.codex).toContain('qa-engineer');
  });
});

// ============================================================
// MCP TOOLS CHECK
// ============================================================

describe('needsMcpTools', () => {
  it('should detect codex needed', () => {
    const delegations = resolveTeamDelegations(['pm', 'qa-engineer']);
    const result = needsMcpTools(delegations);
    expect(result.needsCodex).toBe(true);
  });

  it('should not need codex for claude-only team', () => {
    const delegations = resolveTeamDelegations(['pm', 'pl', 'fe-dev']);
    const result = needsMcpTools(delegations);
    expect(result.needsCodex).toBe(false);
  });

  it('should detect gemini not needed for default roles', () => {
    const delegations = resolveTeamDelegations(['pm', 'pl', 'qa-engineer']);
    const result = needsMcpTools(delegations);
    expect(result.needsGemini).toBe(false);
  });
});
