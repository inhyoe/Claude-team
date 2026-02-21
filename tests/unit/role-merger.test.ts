/**
 * Role Merger unit tests
 *
 * Tests: complexity-based merging, validation rules,
 * merged capabilities, suggested configurations.
 */
import { describe, it, expect } from 'vitest';
import {
  mergeRoles,
  validateMerge,
  getMergedCapabilities,
  suggestRoleConfig,
} from '../../src/agents/role-merger.js';
import type { ComplexityScore, RoleType } from '../../src/shared/types.js';

// ============================================================
// MERGE ROLES
// ============================================================

describe('mergeRoles', () => {
  it('should produce 1 agent for tiny complexity', () => {
    const result = mergeRoles(makeComplexity('tiny', 0.1));
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].role).toBe('pl');
    expect(result.assignments[0].mergedRoles.length).toBeGreaterThan(0);
  });

  it('should produce 2 agents for small complexity', () => {
    const result = mergeRoles(makeComplexity('small', 0.3));
    expect(result.assignments).toHaveLength(2);

    const roles = result.assignments.map(a => a.role);
    expect(roles).toContain('pl');
  });

  it('should produce 3 agents for medium complexity', () => {
    const result = mergeRoles(makeComplexity('medium', 0.5));
    expect(result.assignments).toHaveLength(3);
  });

  it('should produce 4 agents for large complexity', () => {
    const result = mergeRoles(makeComplexity('large', 0.8));
    expect(result.assignments).toHaveLength(4);
  });

  it('should include merge log with complexity info', () => {
    const result = mergeRoles(makeComplexity('medium', 0.55));
    expect(result.mergeLog.length).toBeGreaterThan(0);
    expect(result.mergeLog[0]).toContain('Complexity: medium');
    expect(result.mergeLog[0]).toContain('3 agents');
  });

  it('should set persona names from role definitions', () => {
    const result = mergeRoles(makeComplexity('large', 0.8));
    const pmAssignment = result.assignments.find(a => a.role === 'pm');
    expect(pmAssignment?.personaName).toBe('Alex');
  });

  it('should set all assignments to active status', () => {
    const result = mergeRoles(makeComplexity('medium', 0.5));
    for (const assignment of result.assignments) {
      expect(assignment.status).toBe('active');
    }
  });

  it('should generate unique role IDs', () => {
    const result = mergeRoles(makeComplexity('large', 0.8));
    const ids = result.assignments.map(a => a.roleId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// ============================================================
// VALIDATE MERGE
// ============================================================

describe('validateMerge', () => {
  it('should reject empty role list', () => {
    const result = validateMerge([]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('No roles');
  });

  it('should accept single role', () => {
    const result = validateMerge(['pm']);
    expect(result.valid).toBe(true);
  });

  it('should accept valid same-layer, same-provider merge', () => {
    // qa-engineer and security-specialist: both judge layer, both codex
    const result = validateMerge(['qa-engineer', 'security-specialist']);
    expect(result.valid).toBe(true);
  });

  it('should accept fe-dev + ui-ux-designer merge', () => {
    // Both worker layer, both claude
    const result = validateMerge(['fe-dev', 'ui-ux-designer']);
    expect(result.valid).toBe(true);
  });

  it('should accept be-dev + dba merge', () => {
    const result = validateMerge(['be-dev', 'dba']);
    // be-dev is claude, dba is codex → different providers
    // This should fail due to provider mismatch
    expect(result.valid).toBe(false);
    expect(result.error).toContain('providers');
  });

  it('should allow cross-layer merges if mergeableWith permits', () => {
    // pl (planner) can merge with fe-dev (worker) per updated mergeableWith
    const result = validateMerge(['pl', 'fe-dev']);
    expect(result.valid).toBe(true);
  });

  it('should reject cross-provider merges', () => {
    // fe-dev is claude, qa-engineer is codex (different providers)
    const result = validateMerge(['fe-dev', 'qa-engineer']);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('providers');
  });

  it('should accept pm + pl merge (bidirectional mergeability)', () => {
    // pm.mergeableWith includes 'pl' and pl.mergeableWith includes 'pm'
    const result = validateMerge(['pm', 'pl']);
    expect(result.valid).toBe(true);
  });

  it('should reject unknown roles', () => {
    const result = validateMerge(['pm', 'unknown-role' as RoleType]);
    expect(result.valid).toBe(false);
  });
});

// ============================================================
// MERGED CAPABILITIES
// ============================================================

describe('getMergedCapabilities', () => {
  it('should return primary role capabilities', () => {
    const caps = getMergedCapabilities('pm', []);
    expect(caps).toContain('requirements-analysis');
    expect(caps).toContain('prd-creation');
  });

  it('should combine capabilities from merged roles', () => {
    const caps = getMergedCapabilities('fe-dev', ['ui-ux-designer']);
    expect(caps).toContain('frontend-implementation');   // fe-dev
    expect(caps).toContain('component-development');      // fe-dev
    expect(caps).toContain('ui-design');                  // ui-ux-designer
    expect(caps).toContain('accessibility');               // ui-ux-designer
  });

  it('should deduplicate capabilities', () => {
    const caps = getMergedCapabilities('qa-engineer', ['security-specialist']);
    const uniqueCaps = new Set(caps);
    expect(uniqueCaps.size).toBe(caps.length);
  });

  it('should handle empty merged roles', () => {
    const caps = getMergedCapabilities('be-dev', []);
    expect(caps.length).toBeGreaterThan(0);
    expect(caps).toContain('api-implementation');
  });
});

// ============================================================
// SUGGESTED ROLE CONFIG
// ============================================================

describe('suggestRoleConfig', () => {
  it('should suggest 1-group config for 1 agent', () => {
    const config = suggestRoleConfig(1);
    expect(config).toHaveLength(1);
    expect(config[0]).toContain('pl');
  });

  it('should suggest 2-group config for 2 agents', () => {
    const config = suggestRoleConfig(2);
    expect(config).toHaveLength(2);
  });

  it('should suggest 3-group config for 3 agents', () => {
    const config = suggestRoleConfig(3);
    expect(config).toHaveLength(3);
    // Should have a judge group
    const flatRoles = config.flat();
    expect(flatRoles).toContain('qa-engineer');
  });

  it('should suggest 4-group config for 4 agents', () => {
    const config = suggestRoleConfig(4);
    expect(config).toHaveLength(4);
    const flatRoles = config.flat();
    expect(flatRoles).toContain('pm');
    expect(flatRoles).toContain('pl');
    expect(flatRoles).toContain('qa-engineer');
    expect(flatRoles).toContain('security-specialist');
  });

  it('should clamp to max 4 agents for counts above supported range', () => {
    const config = suggestRoleConfig(10);
    // Clamped to 4-agent config
    expect(config).toHaveLength(4);
    expect(config.flat()).toContain('pl');
    expect(config.flat()).toContain('pm');
  });
});

// ============================================================
// HELPERS
// ============================================================

function makeComplexity(level: ComplexityScore['level'], score: number): ComplexityScore {
  return {
    level,
    score,
    factors: {
      fileCount: 10,
      crossModuleDeps: 3,
      hasTests: true,
      hasApiChanges: true,
      hasDbChanges: false,
      hasSecurityImplications: false,
    },
    recommendedAgentCount: level === 'tiny' ? 1 : level === 'small' ? 2 : level === 'medium' ? 3 : 4,
  };
}
