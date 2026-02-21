/**
 * Claude Team - File Ownership Resolution
 *
 * Resolves file ownership conflicts between DAG nodes using glob pattern matching.
 * Each DAG node has fileOwnership: string[] containing glob patterns.
 * This module determines which node owns a file and detects conflicts.
 */

import picomatchDefault from 'picomatch';
import type { DAGNode } from '../shared/types.js';

// Handle both ESM and CJS exports
const picomatch = (picomatchDefault as any).default || picomatchDefault;

export interface FileOwnershipResult {
  filePath: string;
  owner: DAGNode | null;
  conflicts: DAGNode[]; // nodes with overlapping patterns
}

/**
 * Check if a file matches any glob pattern in a list.
 */
export function matchesOwnership(filePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const matcher = picomatch(patterns);
  return matcher(filePath);
}

/**
 * Find the owner node for a given file path among a set of DAG nodes.
 * Returns the owning node and any conflicting nodes.
 */
export function resolveFileOwner(filePath: string, nodes: DAGNode[]): FileOwnershipResult {
  const matchingNodes = nodes.filter(node =>
    node.fileOwnership.length > 0 && matchesOwnership(filePath, node.fileOwnership)
  );

  if (matchingNodes.length === 0) {
    return { filePath, owner: null, conflicts: [] };
  }

  if (matchingNodes.length === 1) {
    return { filePath, owner: matchingNodes[0], conflicts: [] };
  }

  // Multiple owners = conflict. First match wins, rest are conflicts.
  return {
    filePath,
    owner: matchingNodes[0],
    conflicts: matchingNodes.slice(1),
  };
}

/**
 * Validate that no two nodes in the same layer have overlapping file ownership.
 * Returns a list of conflicts found.
 */
export interface OwnershipConflict {
  filePath: string; // representative pattern that overlaps
  nodeA: string; // node ID
  nodeB: string; // node ID
  patternA: string;
  patternB: string;
}

export function detectOwnershipConflicts(nodes: DAGNode[]): OwnershipConflict[] {
  const conflicts: OwnershipConflict[] = [];

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const nodeA = nodes[i];
      const nodeB = nodes[j];

      // Skip nodes in different layers (they execute sequentially)
      if (nodeA.layerIndex !== nodeB.layerIndex) continue;

      // Check each pattern of nodeA against each pattern of nodeB
      for (const patternA of nodeA.fileOwnership) {
        for (const patternB of nodeB.fileOwnership) {
          if (patternsOverlap(patternA, patternB)) {
            conflicts.push({
              filePath: patternA,
              nodeA: nodeA.id,
              nodeB: nodeB.id,
              patternA,
              patternB,
            });
          }
        }
      }
    }
  }

  return conflicts;
}

/**
 * Check if two glob patterns could match overlapping files.
 * Conservative: if pattern A matches pattern B or vice versa, they overlap.
 */
export function patternsOverlap(patternA: string, patternB: string): boolean {
  // If either is a substring of the other's base path, they likely overlap
  const matcherA = picomatch(patternA);
  const matcherB = picomatch(patternB);

  // Check if pattern A matches pattern B literally or vice versa
  if (matcherA(patternB) || matcherB(patternA)) return true;

  // Extract base directories and check for nesting
  const baseA = patternA.split('*')[0].replace(/\/$/, '');
  const baseB = patternB.split('*')[0].replace(/\/$/, '');

  if (baseA && baseB) {
    if (baseA.startsWith(baseB) || baseB.startsWith(baseA)) {
      return true;
    }
  }

  return false;
}

/**
 * Filter a list of files to only those owned by a specific node.
 */
export function getOwnedFiles(node: DAGNode, filePaths: string[]): string[] {
  if (node.fileOwnership.length === 0) return [];
  const matcher = picomatch(node.fileOwnership);
  return filePaths.filter(fp => matcher(fp));
}
