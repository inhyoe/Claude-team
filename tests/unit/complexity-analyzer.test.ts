/**
 * Complexity Analyzer unit tests
 *
 * Tests: analyzeComplexity factor scoring, level determination,
 * description-based estimation.
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeComplexity,
  estimateFromDescription,
} from '../../src/core/complexity-analyzer.js';

// ============================================================
// ANALYZE COMPLEXITY
// ============================================================

describe('analyzeComplexity', () => {
  it('should return tiny for minimal task', () => {
    const result = analyzeComplexity({
      description: 'Fix typo',
      fileCount: 1,
      crossModuleDeps: 0,
      hasTests: false,
      hasApiChanges: false,
      hasDbChanges: false,
      hasSecurityImplications: false,
    });
    expect(result.level).toBe('tiny');
    expect(result.score).toBeLessThan(0.2);
    expect(result.recommendedAgentCount).toBe(1);
  });

  it('should return small for moderate task', () => {
    const result = analyzeComplexity({
      description: 'Add feature',
      fileCount: 4,
      crossModuleDeps: 2,
      hasTests: true,
      hasApiChanges: false,
      hasDbChanges: false,
      hasSecurityImplications: false,
    });
    expect(result.level).toBe('small');
    expect(result.score).toBeGreaterThanOrEqual(0.2);
    expect(result.score).toBeLessThan(0.4);
    expect(result.recommendedAgentCount).toBe(2);
  });

  it('should return medium for substantial task', () => {
    const result = analyzeComplexity({
      description: 'Build API',
      fileCount: 8,
      crossModuleDeps: 3,
      hasTests: true,
      hasApiChanges: true,
      hasDbChanges: false,
      hasSecurityImplications: false,
    });
    expect(result.level).toBe('medium');
    expect(result.score).toBeGreaterThanOrEqual(0.4);
    expect(result.score).toBeLessThan(0.7);
    expect(result.recommendedAgentCount).toBe(3);
  });

  it('should return large for complex task', () => {
    const result = analyzeComplexity({
      description: 'Full stack feature',
      fileCount: 15,
      crossModuleDeps: 5,
      hasTests: true,
      hasApiChanges: true,
      hasDbChanges: true,
      hasSecurityImplications: true,
    });
    expect(result.level).toBe('large');
    expect(result.score).toBeGreaterThanOrEqual(0.7);
    expect(result.recommendedAgentCount).toBe(4);
  });

  it('should clamp score to max 1.0', () => {
    const result = analyzeComplexity({
      description: 'Everything',
      fileCount: 100,
      crossModuleDeps: 20,
      hasTests: true,
      hasApiChanges: true,
      hasDbChanges: true,
      hasSecurityImplications: true,
    });
    expect(result.score).toBeLessThanOrEqual(1.0);
  });

  it('should preserve factors in result', () => {
    const result = analyzeComplexity({
      description: 'Test',
      fileCount: 5,
      crossModuleDeps: 2,
      hasTests: true,
      hasApiChanges: false,
      hasDbChanges: true,
      hasSecurityImplications: false,
    });
    expect(result.factors.fileCount).toBe(5);
    expect(result.factors.crossModuleDeps).toBe(2);
    expect(result.factors.hasTests).toBe(true);
    expect(result.factors.hasApiChanges).toBe(false);
    expect(result.factors.hasDbChanges).toBe(true);
  });

  it('should increase score with file count', () => {
    const low = analyzeComplexity({
      description: 'A', fileCount: 1, crossModuleDeps: 0,
      hasTests: false, hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false,
    });
    const high = analyzeComplexity({
      description: 'A', fileCount: 20, crossModuleDeps: 0,
      hasTests: false, hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false,
    });
    expect(high.score).toBeGreaterThan(low.score);
  });

  it('should increase score with cross-module deps', () => {
    const low = analyzeComplexity({
      description: 'A', fileCount: 1, crossModuleDeps: 0,
      hasTests: false, hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false,
    });
    const high = analyzeComplexity({
      description: 'A', fileCount: 1, crossModuleDeps: 10,
      hasTests: false, hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false,
    });
    expect(high.score).toBeGreaterThan(low.score);
  });

  it('should handle fileCount of 0 (description-only task)', () => {
    const result = analyzeComplexity({
      description: 'Description only', fileCount: 0, crossModuleDeps: 0,
      hasTests: false, hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.level).toBe('tiny');
  });

  it('should clamp negative fileCount to score >= 0', () => {
    const result = analyzeComplexity({
      description: 'Invalid', fileCount: -1, crossModuleDeps: 0,
      hasTests: false, hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('should clamp negative crossModuleDeps to score >= 0', () => {
    const result = analyzeComplexity({
      description: 'Invalid', fileCount: 1, crossModuleDeps: -5,
      hasTests: false, hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});

// ============================================================
// ESTIMATE FROM DESCRIPTION
// ============================================================

describe('estimateFromDescription', () => {
  it('should estimate tiny for bug fix', () => {
    const result = estimateFromDescription('Fix a typo in the readme');
    expect(result.level).toBe('tiny');
  });

  it('should detect API changes from keywords', () => {
    const result = estimateFromDescription('Build a REST API endpoint for user registration');
    expect(result.factors.hasApiChanges).toBe(true);
  });

  it('should detect security implications', () => {
    const result = estimateFromDescription('Implement authentication with password hashing');
    expect(result.factors.hasSecurityImplications).toBe(true);
  });

  it('should detect database changes', () => {
    const result = estimateFromDescription('Add new database migration for user table schema');
    expect(result.factors.hasDbChanges).toBe(true);
  });

  it('should detect test requirements', () => {
    const result = estimateFromDescription('Write vitest unit tests for the auth module');
    expect(result.factors.hasTests).toBe(true);
  });

  it('should estimate higher complexity for refactoring', () => {
    const result = estimateFromDescription('Refactor the entire authentication system');
    expect(result.factors.fileCount).toBeGreaterThan(10);
  });

  it('should estimate full-stack as high cross-module deps', () => {
    const result = estimateFromDescription('Build full-stack user management feature');
    expect(result.factors.crossModuleDeps).toBeGreaterThanOrEqual(5);
  });

  it('should handle case insensitivity', () => {
    const result = estimateFromDescription('BUILD A REST API WITH SECURITY');
    expect(result.factors.hasApiChanges).toBe(true);
    expect(result.factors.hasSecurityImplications).toBe(true);
  });

  it('should return valid tiny result for empty string', () => {
    const result = estimateFromDescription('');
    expect(result.level).toBe('tiny');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.factors.hasTests).toBe(false);
    expect(result.factors.hasApiChanges).toBe(false);
    expect(result.factors.hasDbChanges).toBe(false);
    expect(result.factors.hasSecurityImplications).toBe(false);
  });
});
