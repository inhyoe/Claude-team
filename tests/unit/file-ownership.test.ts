/**
 * Claude Team - File Ownership Tests
 *
 * Tests for glob-based file ownership resolution in the DAG engine.
 */

import { describe, it, expect } from 'vitest';
import {
  matchesOwnership,
  resolveFileOwner,
  detectOwnershipConflicts,
  patternsOverlap,
  getOwnedFiles,
} from '../../src/core/file-ownership.js';
import type { DAGNode } from '../../src/shared/types.js';

/**
 * Helper to create mock DAG nodes for testing.
 */
function createMockNode(
  id: string,
  layerIndex: number,
  fileOwnership: string[]
): DAGNode {
  return {
    id,
    roleId: `role-${id}`,
    layerIndex,
    nodeType: 'execution',
    status: 'pending',
    dependencies: [],
    taskId: null,
    fileOwnership,
    estimatedDuration: null,
    startedAt: null,
    completedAt: null,
  };
}

describe('matchesOwnership', () => {
  it('should match single glob pattern', () => {
    expect(matchesOwnership('src/auth/login.ts', ['src/auth/**/*.ts'])).toBe(true);
    expect(matchesOwnership('src/api/user.ts', ['src/auth/**/*.ts'])).toBe(false);
  });

  it('should match when one of multiple patterns matches', () => {
    const patterns = ['src/auth/**/*.ts', 'src/api/**/*.ts'];
    expect(matchesOwnership('src/auth/login.ts', patterns)).toBe(true);
    expect(matchesOwnership('src/api/user.ts', patterns)).toBe(true);
    expect(matchesOwnership('src/utils/helper.ts', patterns)).toBe(false);
  });

  it('should return false when no patterns match', () => {
    const patterns = ['src/auth/**/*.ts', 'src/api/**/*.ts'];
    expect(matchesOwnership('tests/unit/example.test.ts', patterns)).toBe(false);
    expect(matchesOwnership('README.md', patterns)).toBe(false);
  });

  it('should handle double star patterns correctly', () => {
    expect(matchesOwnership('src/auth/middleware/verify.ts', ['src/**/*.ts'])).toBe(true);
    expect(matchesOwnership('src/deep/nested/path/file.ts', ['src/**/*.ts'])).toBe(true);
    expect(matchesOwnership('lib/other.ts', ['src/**/*.ts'])).toBe(false);
  });

  it('should handle config file patterns', () => {
    expect(matchesOwnership('jest.config.js', ['*.config.js'])).toBe(true);
    expect(matchesOwnership('webpack.config.js', ['*.config.js'])).toBe(true);
    expect(matchesOwnership('src/config.js', ['*.config.js'])).toBe(false);
  });

  it('should return false for empty patterns array', () => {
    expect(matchesOwnership('any/file.ts', [])).toBe(false);
  });
});

describe('resolveFileOwner', () => {
  it('should find single owner for a file', () => {
    const nodes = [
      createMockNode('node-1', 0, ['src/auth/**/*.ts']),
      createMockNode('node-2', 0, ['src/api/**/*.ts']),
    ];

    const result = resolveFileOwner('src/auth/login.ts', nodes);

    expect(result.owner).toBe(nodes[0]);
    expect(result.conflicts).toHaveLength(0);
    expect(result.filePath).toBe('src/auth/login.ts');
  });

  it('should return null owner for unowned file', () => {
    const nodes = [
      createMockNode('node-1', 0, ['src/auth/**/*.ts']),
      createMockNode('node-2', 0, ['src/api/**/*.ts']),
    ];

    const result = resolveFileOwner('tests/unit/example.test.ts', nodes);

    expect(result.owner).toBeNull();
    expect(result.conflicts).toHaveLength(0);
  });

  it('should detect conflict when multiple nodes own the same file', () => {
    const nodes = [
      createMockNode('node-1', 0, ['src/**/*.ts']),
      createMockNode('node-2', 0, ['src/auth/**/*.ts']),
    ];

    const result = resolveFileOwner('src/auth/login.ts', nodes);

    expect(result.owner).toBe(nodes[0]); // First match wins
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toBe(nodes[1]);
  });

  it('should ignore nodes with empty fileOwnership', () => {
    const nodes = [
      createMockNode('node-1', 0, []),
      createMockNode('node-2', 0, ['src/auth/**/*.ts']),
    ];

    const result = resolveFileOwner('src/auth/login.ts', nodes);

    expect(result.owner).toBe(nodes[1]);
    expect(result.conflicts).toHaveLength(0);
  });
});

describe('detectOwnershipConflicts', () => {
  it('should detect no conflicts between disjoint patterns', () => {
    const nodes = [
      createMockNode('node-1', 0, ['src/auth/**/*.ts']),
      createMockNode('node-2', 0, ['src/api/**/*.ts']),
      createMockNode('node-3', 0, ['tests/**/*.test.ts']),
    ];

    const conflicts = detectOwnershipConflicts(nodes);

    expect(conflicts).toHaveLength(0);
  });

  it('should detect conflict between overlapping patterns in same layer', () => {
    const nodes = [
      createMockNode('node-1', 0, ['src/**/*.ts']),
      createMockNode('node-2', 0, ['src/auth/**/*.ts']),
    ];

    const conflicts = detectOwnershipConflicts(nodes);

    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0].nodeA).toBe('node-1');
    expect(conflicts[0].nodeB).toBe('node-2');
    expect(conflicts[0].patternA).toBe('src/**/*.ts');
    expect(conflicts[0].patternB).toBe('src/auth/**/*.ts');
  });

  it('should NOT detect conflict between overlapping patterns in different layers', () => {
    const nodes = [
      createMockNode('node-1', 0, ['src/**/*.ts']),
      createMockNode('node-2', 1, ['src/auth/**/*.ts']),
    ];

    const conflicts = detectOwnershipConflicts(nodes);

    expect(conflicts).toHaveLength(0);
  });

  it('should detect multiple conflicts for multiple pattern pairs', () => {
    const nodes = [
      createMockNode('node-1', 0, ['src/**/*.ts', 'lib/**/*.ts']),
      createMockNode('node-2', 0, ['src/auth/**/*.ts', 'lib/utils/**/*.ts']),
    ];

    const conflicts = detectOwnershipConflicts(nodes);

    // Should detect at least 2 conflicts (src overlap and lib overlap)
    expect(conflicts.length).toBeGreaterThanOrEqual(2);
  });
});

describe('patternsOverlap', () => {
  it('should detect overlap when one pattern is subset of another', () => {
    expect(patternsOverlap('src/**/*.ts', 'src/auth/**/*.ts')).toBe(true);
    expect(patternsOverlap('src/auth/**/*.ts', 'src/**/*.ts')).toBe(true);
  });

  it('should detect overlap for identical patterns', () => {
    expect(patternsOverlap('src/auth/**/*.ts', 'src/auth/**/*.ts')).toBe(true);
  });

  it('should detect no overlap for disjoint base directories', () => {
    expect(patternsOverlap('src/auth/**/*.ts', 'src/api/**/*.ts')).toBe(false);
    expect(patternsOverlap('tests/**/*.ts', 'src/**/*.ts')).toBe(false);
  });

  it('should detect overlap for nested base directories', () => {
    expect(patternsOverlap('src/auth/**/*.ts', 'src/auth/middleware/**/*.ts')).toBe(true);
  });

  it('should handle patterns without wildcards', () => {
    expect(patternsOverlap('src/config.ts', 'src/config.ts')).toBe(true);
    expect(patternsOverlap('src/config.ts', 'src/other.ts')).toBe(false);
  });
});

describe('getOwnedFiles', () => {
  it('should filter file list to only owned files', () => {
    const node = createMockNode('node-1', 0, ['src/auth/**/*.ts']);
    const files = [
      'src/auth/login.ts',
      'src/auth/middleware/verify.ts',
      'src/api/user.ts',
      'tests/unit/auth.test.ts',
    ];

    const owned = getOwnedFiles(node, files);

    expect(owned).toHaveLength(2);
    expect(owned).toContain('src/auth/login.ts');
    expect(owned).toContain('src/auth/middleware/verify.ts');
    expect(owned).not.toContain('src/api/user.ts');
  });

  it('should return empty array for node with no ownership patterns', () => {
    const node = createMockNode('node-1', 0, []);
    const files = ['src/auth/login.ts', 'src/api/user.ts'];

    const owned = getOwnedFiles(node, files);

    expect(owned).toHaveLength(0);
  });

  it('should handle multiple patterns correctly', () => {
    const node = createMockNode('node-1', 0, ['src/auth/**/*.ts', 'src/api/**/*.ts']);
    const files = [
      'src/auth/login.ts',
      'src/api/user.ts',
      'src/utils/helper.ts',
      'tests/unit/example.test.ts',
    ];

    const owned = getOwnedFiles(node, files);

    expect(owned).toHaveLength(2);
    expect(owned).toContain('src/auth/login.ts');
    expect(owned).toContain('src/api/user.ts');
  });

  it('should return empty array when no files match', () => {
    const node = createMockNode('node-1', 0, ['src/auth/**/*.ts']);
    const files = ['src/api/user.ts', 'tests/unit/example.test.ts'];

    const owned = getOwnedFiles(node, files);

    expect(owned).toHaveLength(0);
  });

  it('should handle test file patterns', () => {
    const node = createMockNode('node-1', 0, ['**/*.test.ts']);
    const files = [
      'tests/unit/auth.test.ts',
      'tests/integration/api.test.ts',
      'src/auth/login.ts',
    ];

    const owned = getOwnedFiles(node, files);

    expect(owned).toHaveLength(2);
    expect(owned).toContain('tests/unit/auth.test.ts');
    expect(owned).toContain('tests/integration/api.test.ts');
  });
});
