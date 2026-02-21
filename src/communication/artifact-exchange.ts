/**
 * Claude Team - Artifact Exchange
 *
 * File-based artifact exchange between role agents.
 * Artifacts are stored in .omc/artifacts/{sprint-id}/{task-id}/
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import type {
  RoleType,
  ArtifactType,
  ArtifactStatus,
  Artifact,
} from '../shared/types.js';
import { ARTIFACT_BASE_DIR } from '../shared/constants.js';
import { createArtifact, getArtifactsByProject, updateArtifactStatus } from '../persistence/artifacts-repo.js';

// ============================================================
// ARTIFACT PATH HELPERS
// ============================================================

/**
 * Get the base artifacts directory for a project.
 */
export function getArtifactsDir(cwd: string): string {
  return join(cwd, ARTIFACT_BASE_DIR);
}

/**
 * Sanitize a path component to prevent path traversal.
 */
function sanitizePathComponent(component: string): string {
  const cleaned = component.replace(/\.\./g, '').replace(/[/\\]/g, '');
  if (!/^[a-zA-Z0-9_.-]+$/.test(cleaned) || cleaned.length === 0) {
    throw new Error(`Invalid path component: ${component}`);
  }
  return cleaned;
}

/**
 * Get the artifact directory for a specific sprint and task.
 */
export function getTaskArtifactDir(cwd: string, sprintId: string, taskId: string): string {
  return join(getArtifactsDir(cwd), sanitizePathComponent(sprintId), sanitizePathComponent(taskId));
}

/**
 * Get the default filename for an artifact type.
 */
function getDefaultFilename(artifactType: ArtifactType): string {
  switch (artifactType) {
    case 'prd': return 'prd.md';
    case 'api-spec': return 'api-spec.yaml';
    case 'schema': return 'schema.sql';
    case 'review-report': return 'review.json';
    case 'test-plan': return 'test-plan.md';
    case 'deploy-config': return 'deploy-config.yaml';
    case 'security-audit': return 'security-audit.json';
    default: return `${artifactType}.md`;
  }
}

// ============================================================
// ARTIFACT OPERATIONS
// ============================================================

export interface ProduceArtifactInput {
  cwd: string;
  projectId: string;
  taskId: string;
  sprintId: string;
  producedBy: RoleType;
  artifactType: ArtifactType;
  content: string;
  filename?: string;
}

/**
 * Produce an artifact: write to filesystem and register in DB.
 */
export function produceArtifact(input: ProduceArtifactInput): Artifact {
  const {
    cwd, projectId, taskId, sprintId,
    producedBy, artifactType, content, filename,
  } = input;

  // Ensure directory exists
  const dir = getTaskArtifactDir(cwd, sprintId, taskId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Write file
  const fname = filename ?? getDefaultFilename(artifactType);
  const filePath = join(dir, fname);
  writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 });

  // Relative path for DB storage
  const relativePath = join(ARTIFACT_BASE_DIR, sprintId, taskId, fname);

  // Register in DB
  const artifactId = `art-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const artifact = createArtifact(cwd, projectId, {
    id: artifactId,
    producedByRole: producedBy,
    artifactType,
    filePath: relativePath,
    taskId,
    sprintId,
  });

  if (!artifact) {
    // Return a minimal artifact if DB persistence fails
    return {
      id: artifactId,
      producedByRole: producedBy,
      artifactType,
      filePath: relativePath,
      status: 'draft' as const,
      approvedBy: null,
      taskId,
      sprintId: sprintId ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  return artifact;
}

/**
 * Read an artifact's content from the filesystem.
 */
export function readArtifactContent(cwd: string, artifact: Artifact): string | null {
  const fullPath = join(cwd, artifact.filePath);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, 'utf-8');
}

/**
 * List all artifact files in a task directory.
 */
export function listTaskArtifactFiles(cwd: string, sprintId: string, taskId: string): string[] {
  const dir = getTaskArtifactDir(cwd, sprintId, taskId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map(f => join(dir, f));
}

/**
 * Approve an artifact (used by reviewers).
 */
export function approveArtifact(
  cwd: string,
  artifactId: string,
  approvedBy: RoleType
): void {
  updateArtifactStatus(cwd, artifactId, 'approved', approvedBy);
}

/**
 * Reject an artifact (used by reviewers).
 */
export function rejectArtifact(
  cwd: string,
  artifactId: string
): void {
  updateArtifactStatus(cwd, artifactId, 'rejected', undefined);
}

/**
 * Submit an artifact for review.
 */
export function submitForReview(
  cwd: string,
  artifactId: string
): void {
  updateArtifactStatus(cwd, artifactId, 'review', undefined);
}

// ============================================================
// REVIEW ARTIFACT HELPERS
// ============================================================

export interface ReviewArtifactContent {
  reviewType: 'qa-review' | 'security-review' | 'code-review' | 'design-review';
  reviewerRole: RoleType;
  taskId: string;
  verdict: string;
  score: number;
  dimensions: {
    correctness: number;
    security: number;
    performance: number;
    maintainability: number;
    testCoverage: number;
  };
  feedback: string;
  timestamp: string;
}

/**
 * Produce a review artifact (JSON format).
 */
export function produceReviewArtifact(
  cwd: string,
  projectId: string,
  taskId: string,
  sprintId: string,
  review: ReviewArtifactContent
): Artifact {
  const filename = `review-${review.reviewType}-${Date.now()}.json`;
  return produceArtifact({
    cwd,
    projectId,
    taskId,
    sprintId,
    producedBy: review.reviewerRole,
    artifactType: 'review-report',
    content: JSON.stringify(review, null, 2),
    filename,
  });
}

/**
 * Get all artifacts for a project, optionally filtered.
 */
export function getProjectArtifacts(
  cwd: string,
  projectId: string,
  filters?: { artifactType?: ArtifactType; status?: ArtifactStatus; producedBy?: RoleType }
): Artifact[] {
  let artifacts = getArtifactsByProject(cwd, projectId);

  if (filters?.artifactType) {
    artifacts = artifacts.filter(a => a.artifactType === filters.artifactType);
  }
  if (filters?.status) {
    artifacts = artifacts.filter(a => a.status === filters.status);
  }
  if (filters?.producedBy) {
    artifacts = artifacts.filter(a => a.producedByRole === filters.producedBy);
  }

  return artifacts;
}
