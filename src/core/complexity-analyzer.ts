/**
 * Claude Team - Complexity Analyzer
 *
 * Analyzes task complexity to determine optimal agent count and role merging strategy.
 */

import type { ComplexityScore, ComplexityLevel } from '../shared/types.js';
import { COMPLEXITY_THRESHOLDS } from '../shared/constants.js';

export interface TaskAnalysisInput {
  description: string;
  fileCount: number;
  crossModuleDeps: number;
  hasTests: boolean;
  hasApiChanges: boolean;
  hasDbChanges: boolean;
  hasSecurityImplications: boolean;
}

/**
 * Compute complexity score from task analysis factors.
 */
export function analyzeComplexity(input: TaskAnalysisInput): ComplexityScore {
  let score = 0;

  // File count contribution (0 - 0.3)
  if (input.fileCount <= 2) score += 0.05;
  else if (input.fileCount <= 5) score += 0.1;
  else if (input.fileCount <= 10) score += 0.2;
  else score += 0.3;

  // Cross-module dependencies (0 - 0.2)
  if (input.crossModuleDeps <= 1) score += 0.02;
  else if (input.crossModuleDeps <= 3) score += 0.1;
  else score += 0.2;

  // Feature flags (each adds 0.1)
  if (input.hasTests) score += 0.1;
  if (input.hasApiChanges) score += 0.15;
  if (input.hasDbChanges) score += 0.1;
  if (input.hasSecurityImplications) score += 0.15;

  // Clamp to [0, 1]
  score = Math.min(1.0, Math.max(0.0, score));

  // Determine level (explicit order to avoid Object.entries ordering issues)
  let level: ComplexityLevel = 'tiny';
  const orderedLevels: ComplexityLevel[] = ['large', 'medium', 'small', 'tiny'];
  for (const lvl of orderedLevels) {
    const threshold = COMPLEXITY_THRESHOLDS[lvl];
    if (score >= threshold.min) {
      level = lvl;
      break;
    }
  }

  const agentCount = COMPLEXITY_THRESHOLDS[level].agentCount;

  return {
    level,
    score,
    factors: {
      fileCount: input.fileCount,
      crossModuleDeps: input.crossModuleDeps,
      hasTests: input.hasTests,
      hasApiChanges: input.hasApiChanges,
      hasDbChanges: input.hasDbChanges,
      hasSecurityImplications: input.hasSecurityImplications,
    },
    recommendedAgentCount: agentCount,
  };
}

/**
 * Quick complexity estimate from description keywords.
 * Used when detailed analysis is not yet available.
 */
export function estimateFromDescription(description: string): ComplexityScore {
  const lower = description.toLowerCase();

  let fileCount = 1;
  let crossModuleDeps = 0;
  const hasTests = /test|spec|jest|vitest|mocha/.test(lower);
  const hasApiChanges = /api|endpoint|route|rest|graphql/.test(lower);
  const hasDbChanges = /database|schema|migration|sql|table|query/.test(lower);
  const hasSecurityImplications = /auth|security|token|password|encrypt|permission/.test(lower);

  // Estimate file count from keywords
  if (/refactor|redesign|overhaul/.test(lower)) fileCount = 15;
  else if (/feature|implement|build|create/.test(lower)) fileCount = 8;
  else if (/update|modify|change|add/.test(lower)) fileCount = 4;
  else if (/fix|bug|patch|typo/.test(lower)) fileCount = 2;

  // Estimate cross-module deps
  if (/full.?stack|end.?to.?end|across/.test(lower)) crossModuleDeps = 5;
  else if (/integration|connect|link/.test(lower)) crossModuleDeps = 3;
  else if (/module|component/.test(lower)) crossModuleDeps = 1;

  return analyzeComplexity({
    description,
    fileCount,
    crossModuleDeps,
    hasTests,
    hasApiChanges,
    hasDbChanges,
    hasSecurityImplications,
  });
}
