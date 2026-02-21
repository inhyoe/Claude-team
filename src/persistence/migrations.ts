/**
 * Claude Team - Database Migrations
 *
 * Versioned migration system for schema evolution.
 * Each migration has up/down functions for forward/backward compatibility.
 */

import type BetterSqlite3 from 'better-sqlite3';

/**
 * Migration definition.
 */
export interface Migration {
  /** Migration version number (must be sequential) */
  version: number;
  /** Human-readable description */
  description: string;
  /** Apply migration (forward) */
  up(db: BetterSqlite3.Database): void;
  /** Rollback migration (backward) */
  down(db: BetterSqlite3.Database): void;
}

/**
 * Migration registry.
 * Migrations must be ordered by version number.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema (10 tables: projects, roles, tasks, kanban_history, communication_log, artifacts, sprints, dag_nodes, quality_gates, message_queue)',
    up(db: BetterSqlite3.Database): void {
      // Initial schema is created by createSchema() in schema.ts
      // This is a no-op marker migration
      console.log('[migrations] v1: Initial schema already applied by createSchema()');
    },
    down(db: BetterSqlite3.Database): void {
      // Cannot roll back initial schema
      throw new Error('Cannot rollback initial schema (v1)');
    },
  },
  {
    version: 2,
    description: 'Add estimated_hours to tasks, retries to dag_nodes',
    up(db: BetterSqlite3.Database): void {
      console.log('[migrations] v2: Adding estimated_hours to tasks, retries to dag_nodes');

      // Add estimated_hours column to tasks
      db.exec(`
        ALTER TABLE tasks ADD COLUMN estimated_hours REAL;
      `);

      // Add retries column to dag_nodes
      db.exec(`
        ALTER TABLE dag_nodes ADD COLUMN retries INTEGER NOT NULL DEFAULT 0;
      `);

      console.log('[migrations] v2: Migration completed');
    },
    down(db: BetterSqlite3.Database): void {
      console.log('[migrations] v2: Rolling back estimated_hours and retries columns');
      throw new Error('SQLite does not support DROP COLUMN. Manual rollback required.');
    },
  },
  {
    version: 3,
    description: 'Add cancelled status to kanban_status CHECK constraint (recreate tasks table)',
    up(db: BetterSqlite3.Database): void {
      console.log('[migrations] v3: Adding cancelled to kanban_status CHECK constraint');

      // Guard: skip if 'cancelled' is already in the tasks table CHECK constraint.
      // This happens on fresh databases where createSchema() already includes 'cancelled'.
      const tableInfo = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
      ).get() as { sql: string } | undefined;
      if (tableInfo?.sql?.includes("'cancelled'")) {
        console.log('[migrations] v3: cancelled status already present in schema, skipping');
        return;
      }

      // SQLite does not support ALTER TABLE ... MODIFY CONSTRAINT.
      // Use the recommended 12-step procedure: disable FKs, rename, recreate, copy, drop.
      // NOTE: better-sqlite3 transaction() cannot wrap DDL (ALTER TABLE) reliably,
      // so we execute each statement individually with FK enforcement off.
      db.pragma('foreign_keys = OFF');

      db.exec(`ALTER TABLE tasks RENAME TO tasks_v2_backup;`);

      db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          kanban_status TEXT NOT NULL DEFAULT 'backlog'
            CHECK (kanban_status IN ('backlog', 'todo', 'in-progress', 'review', 'done', 'blocked', 'failed', 'cancelled')),
          assigned_role TEXT,
          priority INTEGER NOT NULL DEFAULT 3
            CHECK (priority BETWEEN 1 AND 5),
          complexity_score REAL DEFAULT 0.0,
          file_ownership TEXT,
          review_score REAL,
          sprint_id TEXT,
          dag_node_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          moved_at TEXT NOT NULL,
          estimated_hours REAL,
          FOREIGN KEY (project_id) REFERENCES projects(id),
          FOREIGN KEY (sprint_id) REFERENCES sprints(id)
        );
      `);

      db.exec(`INSERT INTO tasks SELECT * FROM tasks_v2_backup;`);
      db.exec(`DROP TABLE tasks_v2_backup;`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(kanban_status);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_role ON tasks(assigned_role);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_sprint ON tasks(sprint_id);`);

      db.pragma('foreign_keys = ON');

      console.log('[migrations] v3: Migration completed');
    },
    down(db: BetterSqlite3.Database): void {
      console.log('[migrations] v3: Rolling back cancelled status constraint');
      throw new Error('Rollback of v3 not supported. Manual rollback required.');
    },
  },
];

/**
 * Get migration by version number.
 */
export function getMigration(version: number): Migration | undefined {
  return MIGRATIONS.find(m => m.version === version);
}

/**
 * Get all migrations between two versions (inclusive).
 */
export function getMigrations(fromVersion: number, toVersion: number): Migration[] {
  if (fromVersion > toVersion) {
    // Rollback: return migrations in reverse order
    return MIGRATIONS
      .filter(m => m.version > toVersion && m.version <= fromVersion)
      .sort((a, b) => b.version - a.version);
  } else {
    // Forward: return migrations in order
    return MIGRATIONS
      .filter(m => m.version > fromVersion && m.version <= toVersion)
      .sort((a, b) => a.version - b.version);
  }
}

/**
 * Run migrations from currentVersion to targetVersion.
 *
 * @param db - Database instance
 * @param currentVersion - Current schema version (0 if fresh database)
 * @param targetVersion - Target schema version
 */
export function runMigrations(
  db: BetterSqlite3.Database,
  currentVersion: number,
  targetVersion: number
): void {
  if (currentVersion === targetVersion) {
    console.log(`[migrations] Already at version ${targetVersion}, no migrations needed`);
    return;
  }

  const migrations = getMigrations(currentVersion, targetVersion);

  if (migrations.length === 0) {
    console.log(`[migrations] No migrations to run (current: ${currentVersion}, target: ${targetVersion})`);
    return;
  }

  const direction = currentVersion < targetVersion ? 'forward' : 'backward';
  console.log(`[migrations] Running ${migrations.length} migration(s) ${direction} from v${currentVersion} to v${targetVersion}`);

  for (const migration of migrations) {
    try {
      // v3 uses DDL (ALTER TABLE, RENAME TABLE) which cannot be wrapped in a transaction
      const isDDLMigration = migration.version === 3;
      if (isDDLMigration) {
        console.log(`[migrations] v${migration.version}: DDL migration, no transaction wrapping`);
        if (direction === 'forward') {
          console.log(`[migrations] Applying v${migration.version}: ${migration.description}`);
          migration.up(db);
        } else {
          console.log(`[migrations] Rolling back v${migration.version}: ${migration.description}`);
          migration.down(db);
        }
      } else {
        const applyMigration = db.transaction(() => {
          if (direction === 'forward') {
            console.log(`[migrations] Applying v${migration.version}: ${migration.description}`);
            migration.up(db);
          } else {
            console.log(`[migrations] Rolling back v${migration.version}: ${migration.description}`);
            migration.down(db);
          }
        });
        applyMigration();
      }
      console.log(`[migrations] v${migration.version}: Applied successfully`);
    } catch (error) {
      throw new Error(`Migration v${migration.version} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`[migrations] Successfully migrated from v${currentVersion} to v${targetVersion}`);
}

/**
 * Validate migration registry for common issues.
 *
 * @returns Validation errors (empty array if valid)
 */
export function validateMigrations(): string[] {
  const errors: string[] = [];

  // Check sequential version numbers
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const expected = i + 1;
    const actual = MIGRATIONS[i].version;
    if (actual !== expected) {
      errors.push(`Migration ${i} has version ${actual}, expected ${expected}`);
    }
  }

  // Check for duplicate versions
  const versions = new Set<number>();
  for (const migration of MIGRATIONS) {
    if (versions.has(migration.version)) {
      errors.push(`Duplicate migration version: ${migration.version}`);
    }
    versions.add(migration.version);
  }

  // Check for missing descriptions
  for (const migration of MIGRATIONS) {
    if (!migration.description || migration.description.trim() === '') {
      errors.push(`Migration v${migration.version} missing description`);
    }
  }

  return errors;
}
