/**
 * Claude Team - Database Lifecycle
 *
 * SQLite database with WAL mode for concurrent access.
 * Follows OMC job-state-db.ts patterns: dynamic import, WAL, schema versioning, per-worktree instances.
 *
 * ARCHITECTURE DECISION: SQLite vs JSON State
 * ─────────────────────────────────────────────
 * The persistence layer uses SQLite (via better-sqlite3) for structured data
 * (tasks, roles, sprints, quality gates, communication logs, artifacts, DAG nodes).
 * At runtime, the MCP bridge (ct-bridge.cjs) operates on JSON state files directly
 * for compatibility with Claude Code's native team tools.
 *
 * Current status: SQLite is available for future use (batch analytics, audit trails,
 * cross-session queries) but the primary runtime path uses JSON state files via the
 * bridge. This is intentional — the bridge must remain dependency-free (no native
 * modules) while SQLite provides richer querying for offline analysis.
 *
 * Trade-offs considered:
 * - JSON: Zero dependencies, bridge-compatible, simple, but no ACID guarantees
 * - SQLite: ACID via WAL, rich queries, but requires better-sqlite3 native module
 * - Hybrid (chosen): JSON for runtime, SQLite for persistence/analytics
 */

import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import type BetterSqlite3 from 'better-sqlite3';
import { DB_NAME, DB_STATE_DIR, DB_SCHEMA_VERSION } from '../shared/constants.js';
import { createSchema, runMigrations } from './schema.js';

type DatabaseConstructor = typeof BetterSqlite3;

let Database: DatabaseConstructor | null = null;
const dbMap = new Map<string, BetterSqlite3.Database>();

function getDbPath(cwd: string): string {
  return join(cwd, DB_STATE_DIR, DB_NAME);
}

function ensureStateDir(cwd: string): void {
  const stateDir = join(cwd, DB_STATE_DIR);
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}

/**
 * Get database instance for a given working directory.
 */
export function getDb(cwd?: string): BetterSqlite3.Database | null {
  if (cwd) {
    const resolved = resolve(cwd);
    return dbMap.get(resolved) ?? null;
  }
  if (dbMap.size === 1) {
    return dbMap.values().next().value ?? null;
  }
  return null;
}

/**
 * Initialize the Claude Team SQLite database.
 * Creates tables, enables WAL mode, runs migrations.
 */
export async function initDb(cwd: string): Promise<boolean> {
  try {
    if (!Database) {
      try {
        const betterSqlite3 = await import('better-sqlite3');
        Database = betterSqlite3.default;
      } catch {
        console.error('[claude-team-db] Failed to load better-sqlite3. Install with: npm install better-sqlite3');
        return false;
      }
    }

    if (!Database) return false;

    const resolvedCwd = resolve(cwd);
    if (dbMap.has(resolvedCwd)) return true;

    ensureStateDir(cwd);
    const dbPath = getDbPath(cwd);
    const db = new Database(dbPath);

    // Enable WAL mode for concurrent access
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Create schema
    createSchema(db);

    // Check and run migrations
    const versionStmt = db.prepare("SELECT value FROM schema_info WHERE key = 'version'");
    const versionRow = versionStmt.get() as { value: string } | undefined;
    const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;

    if (currentVersion < DB_SCHEMA_VERSION) {
      runMigrations(db, currentVersion, DB_SCHEMA_VERSION);
    }

    // Set schema version
    db.prepare("INSERT OR REPLACE INTO schema_info (key, value) VALUES (?, ?)").run('version', String(DB_SCHEMA_VERSION));

    dbMap.set(resolvedCwd, db);
    return true;
  } catch (error) {
    console.error('[claude-team-db] Failed to initialize database:', error);
    return false;
  }
}

/**
 * Close database connection for a specific cwd.
 */
export function closeDb(cwd: string): void {
  const resolved = resolve(cwd);
  const db = dbMap.get(resolved);
  if (db) {
    try { db.close(); } catch (err) {
      console.warn(`[claude-team-db] Error closing db for ${resolved}:`, err);
    }
    dbMap.delete(resolved);
  }
}

/**
 * Close all database connections.
 */
export function closeAllDbs(): void {
  for (const [key, db] of dbMap.entries()) {
    try { db.close(); } catch (err) {
      console.warn(`[claude-team-db] Error closing db for ${key}:`, err);
    }
    dbMap.delete(key);
  }
}

/**
 * Check if database is initialized for a given cwd.
 */
export function isDbInitialized(cwd?: string): boolean {
  if (cwd) return dbMap.has(resolve(cwd));
  return dbMap.size > 0;
}

/**
 * Run a function within a transaction.
 */
export function withTransaction<T>(cwd: string, fn: (db: BetterSqlite3.Database) => T): T | null {
  const db = getDb(cwd);
  if (!db) return null;

  const transaction = db.transaction(() => fn(db));
  return transaction();
}
