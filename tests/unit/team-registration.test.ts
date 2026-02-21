/**
 * Team Registration unit tests
 *
 * Tests: registerTeam function, spawn config generation,
 * agent type resolution, team slug generation.
 */
import { describe, it, expect } from 'vitest';
import {
  registerTeam,
  generateTeamSlug,
  buildTeamCreatePayload,
  buildTaskSpawnPayload,
  formatRegistration,
  type ClaudeSpawnConfig,
} from '../../src/team/team-registration.js';
import { buildTeam } from '../../src/team/unified-team.js';
import type { ComplexityScore } from '../../src/shared/types.js';

// ============================================================
// REGISTER TEAM
// ============================================================

describe('registerTeam', () => {
  it('should register team with all members', () => {
    const teamConfig = buildTeam({
      teamName: 'test-team',
      complexity: makeComplexity('small', 0.3),
    });

    const result = registerTeam(
      'test-team',
      'Test team description',
      teamConfig,
      '/working/dir'
    );

    expect(result.teamName).toBe('test-team');
    expect(result.description).toBe('Test team description');
    expect(result.members).toHaveLength(teamConfig.members.length);
    expect(result.createdAt).toBeDefined();
  });

  it('should map Claude members to OMC agent types', () => {
    const teamConfig = buildTeam({
      teamName: 'test-team',
      complexity: makeComplexity('large', 0.8),
    });

    const result = registerTeam(
      'test-team',
      'Test team',
      teamConfig,
      '/working/dir'
    );

    const claudeMembers = result.members.filter(m => m.provider === 'claude');
    for (const member of claudeMembers) {
      expect(member.agentType).toMatch(/^oh-my-claudecode:/);
    }
  });

  it('should map non-Claude members to mcp_ agent types', () => {
    const teamConfig = buildTeam({
      teamName: 'test-team',
      complexity: makeComplexity('large', 0.8),
    });

    const result = registerTeam(
      'test-team',
      'Test team',
      teamConfig,
      '/working/dir'
    );

    const mcpMembers = result.members.filter(m => m.provider !== 'claude');
    for (const member of mcpMembers) {
      expect(member.agentType).toMatch(/^mcp_(codex|gemini)$/);
    }
  });

  it('should create Claude spawn config for Claude members', () => {
    const teamConfig = buildTeam({
      teamName: 'test-team',
      complexity: makeComplexity('small', 0.3),
    });

    const result = registerTeam(
      'test-team',
      'Test team',
      teamConfig,
      '/working/dir'
    );

    const claudeMember = result.members.find(m => m.provider === 'claude');
    if (claudeMember) {
      expect(claudeMember.spawnConfig.type).toBe('claude');
      const config = claudeMember.spawnConfig as ClaudeSpawnConfig;
      expect(config.teamName).toBe('test-team');
      expect(config.name).toBe(claudeMember.name);
      expect(config.prompt).toBeDefined();
      expect(config.subagentType).toMatch(/^oh-my-claudecode:/);
    }
  });

  it('should create MCP spawn config for non-Claude members', () => {
    const teamConfig = buildTeam({
      teamName: 'test-team',
      complexity: makeComplexity('large', 0.8),
    });

    const result = registerTeam(
      'test-team',
      'Test team',
      teamConfig,
      '/working/dir'
    );

    const mcpMember = result.members.find(m => m.provider !== 'claude');
    if (mcpMember) {
      expect(mcpMember.spawnConfig.type).toBe('mcp');
      const config = mcpMember.spawnConfig as any;
      expect(config.tool).toMatch(/^ask_(codex|gemini)$/);
      expect(config.promptFile).toContain('.omc/state/test-team');
      expect(config.outputFile).toContain('.omc/state/test-team');
      expect(config.workingDirectory).toBe('/working/dir');
    }
  });

  it('should preserve role assignments', () => {
    const teamConfig = buildTeam({
      teamName: 'test-team',
      complexity: makeComplexity('medium', 0.5),
    });

    const result = registerTeam(
      'test-team',
      'Test team',
      teamConfig,
      '/working/dir'
    );

    expect(result.members.length).toBe(teamConfig.members.length);
    for (let i = 0; i < result.members.length; i++) {
      expect(result.members[i].role).toBe(teamConfig.members[i].role);
      expect(result.members[i].name).toBe(teamConfig.members[i].name);
    }
  });

  it('should set timestamp for createdAt', () => {
    const teamConfig = buildTeam({
      teamName: 'test-team',
      complexity: makeComplexity('tiny', 0.1),
    });

    const before = new Date().toISOString();
    const result = registerTeam(
      'test-team',
      'Test team',
      teamConfig,
      '/working/dir'
    );
    const after = new Date().toISOString();

    expect(result.createdAt).toBeDefined();
    expect(result.createdAt >= before).toBe(true);
    expect(result.createdAt <= after).toBe(true);
  });
});

// ============================================================
// ROLE TO AGENT TYPE MAPPING
// ============================================================

describe('agent type resolution', () => {
  it('should map pm to planner', () => {
    const teamConfig = buildTeam({
      teamName: 'test-team',
      complexity: makeComplexity('large', 0.8),
    });

    const result = registerTeam('test-team', 'desc', teamConfig, '/dir');
    const pmMember = result.members.find(m => m.role === 'pm');

    if (pmMember && pmMember.provider === 'claude') {
      expect(pmMember.agentType).toBe('oh-my-claudecode:planner');
    }
  });

  it('should map pl to architect', () => {
    const teamConfig = buildTeam({
      teamName: 'test-team',
      complexity: makeComplexity('small', 0.3),
    });

    const result = registerTeam('test-team', 'desc', teamConfig, '/dir');
    const plMember = result.members.find(m => m.role === 'pl');

    if (plMember && plMember.provider === 'claude') {
      expect(plMember.agentType).toBe('oh-my-claudecode:architect');
    }
  });

  it('should map fe-dev to executor', () => {
    const teamConfig = buildTeam({
      teamName: 'test-team',
      complexity: makeComplexity('medium', 0.5),
    });

    const result = registerTeam('test-team', 'desc', teamConfig, '/dir');
    const feMember = result.members.find(m => m.role === 'fe-dev');

    if (feMember && feMember.provider === 'claude') {
      expect(feMember.agentType).toBe('oh-my-claudecode:executor');
    }
  });

  it('should map qa-engineer to test-engineer', () => {
    const teamConfig = buildTeam({
      teamName: 'test-team',
      complexity: makeComplexity('large', 0.8),
    });

    const result = registerTeam('test-team', 'desc', teamConfig, '/dir');
    const qaMember = result.members.find(m => m.role === 'qa-engineer');

    if (qaMember && qaMember.provider === 'claude') {
      expect(qaMember.agentType).toBe('oh-my-claudecode:test-engineer');
    }
  });
});

// ============================================================
// GENERATE TEAM SLUG
// ============================================================

describe('generateTeamSlug', () => {
  it('should convert spaces to hyphens', () => {
    const result = generateTeamSlug('Build New Feature');
    expect(result).toBe('build-new-feature');
  });

  it('should convert to lowercase', () => {
    const result = generateTeamSlug('Build API');
    expect(result).toBe('build-api');
  });

  it('should remove special characters', () => {
    const result = generateTeamSlug('Build API (v2.0)!');
    expect(result).toBe('build-api-v20');
  });

  it('should collapse multiple hyphens', () => {
    const result = generateTeamSlug('Build   New---Feature');
    expect(result).toBe('build-new-feature');
  });

  it('should limit length to 40 characters', () => {
    const longDesc = 'This is a very long description that should be truncated to forty characters';
    const result = generateTeamSlug(longDesc);
    expect(result.length).toBeLessThanOrEqual(40);
  });

  it('should remove trailing hyphen', () => {
    const result = generateTeamSlug('Build Feature-');
    expect(result).not.toMatch(/-$/);
  });

  it('should handle empty string', () => {
    const result = generateTeamSlug('');
    expect(result).toBe('');
  });

  it('should handle only special characters', () => {
    const result = generateTeamSlug('!@#$%^&*()');
    expect(result).toBe('');
  });
});

// ============================================================
// BUILD TEAM CREATE PAYLOAD
// ============================================================

describe('buildTeamCreatePayload', () => {
  it('should create payload with team_name and description', () => {
    const result = buildTeamCreatePayload('my-team', 'My team description');

    expect(result.team_name).toBe('my-team');
    expect(result.description).toBe('My team description');
  });

  it('should preserve exact input values', () => {
    const teamName = 'special-team-123';
    const description = 'A very specific description!';
    const result = buildTeamCreatePayload(teamName, description);

    expect(result.team_name).toBe(teamName);
    expect(result.description).toBe(description);
  });
});

// ============================================================
// BUILD TASK SPAWN PAYLOAD
// ============================================================

describe('buildTaskSpawnPayload', () => {
  it('should create payload with all required fields', () => {
    const config: ClaudeSpawnConfig = {
      type: 'claude',
      subagentType: 'oh-my-claudecode:executor',
      teamName: 'test-team',
      name: 'worker-1',
      prompt: 'Test prompt',
    };

    const result = buildTaskSpawnPayload(config);

    expect(result.subagent_type).toBe('oh-my-claudecode:executor');
    expect(result.team_name).toBe('test-team');
    expect(result.name).toBe('worker-1');
    expect(result.prompt).toBe('Test prompt');
    expect(result.description).toBe('Spawn worker-1');
  });

  it('should generate description from worker name', () => {
    const config: ClaudeSpawnConfig = {
      type: 'claude',
      subagentType: 'oh-my-claudecode:planner',
      teamName: 'team-x',
      name: 'planner-alex',
      prompt: 'Plan the work',
    };

    const result = buildTaskSpawnPayload(config);

    expect(result.description).toBe('Spawn planner-alex');
  });
});

// ============================================================
// FORMAT REGISTRATION
// ============================================================

describe('formatRegistration', () => {
  it('should format registration as string', () => {
    const teamConfig = buildTeam({
      teamName: 'test-team',
      complexity: makeComplexity('small', 0.3),
    });

    const registration = registerTeam(
      'test-team',
      'Test description',
      teamConfig,
      '/dir'
    );

    const result = formatRegistration(registration);

    expect(result).toContain('Team: test-team');
    expect(result).toContain('Description: Test description');
    expect(result).toContain('Members:');
  });

  it('should include member details', () => {
    const teamConfig = buildTeam({
      teamName: 'test-team',
      complexity: makeComplexity('medium', 0.5),
    });

    const registration = registerTeam(
      'test-team',
      'Test',
      teamConfig,
      '/dir'
    );

    const result = formatRegistration(registration);

    for (const member of registration.members) {
      expect(result).toContain(member.name);
      expect(result).toContain(member.role);
    }
  });

  it('should show provider tags', () => {
    const teamConfig = buildTeam({
      teamName: 'test-team',
      complexity: makeComplexity('large', 0.8),
    });

    const registration = registerTeam(
      'test-team',
      'Test',
      teamConfig,
      '/dir'
    );

    const result = formatRegistration(registration);

    // Should contain at least one provider tag
    const hasProviderTag = result.includes('[Claude/') ||
                          result.includes('[Codex/') ||
                          result.includes('[Gemini/');
    expect(hasProviderTag).toBe(true);
  });

  it('should show agent type mapping', () => {
    const teamConfig = buildTeam({
      teamName: 'test-team',
      complexity: makeComplexity('small', 0.3),
    });

    const registration = registerTeam(
      'test-team',
      'Test',
      teamConfig,
      '/dir'
    );

    const result = formatRegistration(registration);

    // Should show -> agentType
    expect(result).toContain('->');
    expect(result).toMatch(/oh-my-claudecode:|mcp_/);
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
