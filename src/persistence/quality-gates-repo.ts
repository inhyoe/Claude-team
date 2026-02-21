/**
 * Claude Team - Quality Gates Repository
 */

import { getDb } from './db.js';
import type { QualityGateResult, GateType, GateVerdict, RoleType, ReviewDimensions } from '../shared/types.js';
import { nowIso, safeParseJson } from '../shared/utils.js';

function rowToGateResult(row: Record<string, unknown>): QualityGateResult {
  return {
    id: row.id as string,
    gateType: row.gate_type as GateType,
    reviewerRole: row.reviewer_role as RoleType,
    taskId: row.task_id as string,
    score: row.score as number,
    dimensions: safeParseJson(row.dimensions as string, { correctness: 0, security: 0, performance: 0, maintainability: 0, testCoverage: 0 }) as ReviewDimensions,
    verdict: row.verdict as GateVerdict,
    feedback: (row.feedback as string) ?? '',
    attempt: row.attempt as number,
    maxAttempts: row.max_attempts as number,
    createdAt: row.created_at as string,
  };
}

export function createGateResult(
  cwd: string,
  projectId: string,
  result: {
    id: string;
    gateType: GateType;
    reviewerRole: RoleType;
    taskId: string;
    score: number;
    dimensions: ReviewDimensions;
    verdict: GateVerdict;
    feedback: string;
    attempt: number;
    maxAttempts?: number;
  }
): QualityGateResult | null {
  const db = getDb(cwd);
  if (!db) return null;

  try {
    db.prepare(`
      INSERT INTO quality_gates (id, project_id, gate_type, reviewer_role, task_id, score, dimensions, verdict, feedback, attempt, max_attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.id, projectId, result.gateType, result.reviewerRole,
      result.taskId, result.score, JSON.stringify(result.dimensions),
      result.verdict, result.feedback, result.attempt,
      result.maxAttempts ?? 3, nowIso()
    );
    return getGateResult(cwd, result.id);
  } catch (error) {
    console.error('[quality-gates-repo] Failed to create gate result:', error);
    return null;
  }
}

export function getGateResult(cwd: string, gateId: string): QualityGateResult | null {
  const db = getDb(cwd);
  if (!db) return null;

  try {
    const row = db.prepare('SELECT * FROM quality_gates WHERE id = ?').get(gateId) as Record<string, unknown> | undefined;
    return row ? rowToGateResult(row) : null;
  } catch {
    return null;
  }
}

export function getGateResultsByTask(cwd: string, taskId: string): QualityGateResult[] {
  const db = getDb(cwd);
  if (!db) return [];

  try {
    const rows = db.prepare('SELECT * FROM quality_gates WHERE task_id = ? ORDER BY attempt ASC')
      .all(taskId) as Record<string, unknown>[];
    return rows.map(rowToGateResult);
  } catch {
    return [];
  }
}

export function getLatestGateForTask(cwd: string, taskId: string, gateType: GateType): QualityGateResult | null {
  const db = getDb(cwd);
  if (!db) return null;

  try {
    const row = db.prepare('SELECT * FROM quality_gates WHERE task_id = ? AND gate_type = ? ORDER BY attempt DESC LIMIT 1')
      .get(taskId, gateType) as Record<string, unknown> | undefined;
    return row ? rowToGateResult(row) : null;
  } catch {
    return null;
  }
}

export function getGateStats(cwd: string, projectId: string): { passed: number; failed: number; pending: number; lastScore: number | null } {
  const db = getDb(cwd);
  if (!db) return { passed: 0, failed: 0, pending: 0, lastScore: null };

  try {
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN verdict = 'pass' THEN 1 ELSE 0 END) as passed,
        SUM(CASE WHEN verdict IN ('reject', 'auto-reject') THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN verdict = 'conditional' THEN 1 ELSE 0 END) as pending
      FROM quality_gates WHERE project_id = ?
    `).get(projectId) as { passed: number; failed: number; pending: number };

    const latest = db.prepare('SELECT score FROM quality_gates WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(projectId) as { score: number } | undefined;

    return {
      passed: row.passed ?? 0,
      failed: row.failed ?? 0,
      pending: row.pending ?? 0,
      lastScore: latest?.score ?? null,
    };
  } catch {
    return { passed: 0, failed: 0, pending: 0, lastScore: null };
  }
}
