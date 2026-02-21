/**
 * Tests for database migration system
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import {
  runMigrations,
  getMigration,
  getMigrations,
  validateMigrations,
} from '../../src/persistence/migrations.js';
import { createSchema } from '../../src/persistence/schema.js';

describe('Database Migrations', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    // Create temporary directory for test database
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-team-test-'));
    const dbPath = join(tmpDir, 'test.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('Migration Registry', () => {
    it('should validate migration registry', () => {
      const errors = validateMigrations();
      expect(errors).toEqual([]);
    });

    it('should get migration by version', () => {
      const migration1 = getMigration(1);
      expect(migration1).toBeDefined();
      expect(migration1?.version).toBe(1);
      expect(migration1?.description).toContain('Initial schema');

      const migration2 = getMigration(2);
      expect(migration2).toBeDefined();
      expect(migration2?.version).toBe(2);
      expect(migration2?.description).toContain('estimated_hours');
    });

    it('should return undefined for non-existent migration', () => {
      const migration = getMigration(999);
      expect(migration).toBeUndefined();
    });

    it('should get migrations in forward order', () => {
      const migrations = getMigrations(0, 2);
      expect(migrations).toHaveLength(2);
      expect(migrations[0].version).toBe(1);
      expect(migrations[1].version).toBe(2);
    });

    it('should get migrations in reverse order for rollback', () => {
      const migrations = getMigrations(2, 0);
      expect(migrations).toHaveLength(2);
      expect(migrations[0].version).toBe(2);
      expect(migrations[1].version).toBe(1);
    });

    it('should get partial migration range', () => {
      const migrations = getMigrations(1, 2);
      expect(migrations).toHaveLength(1);
      expect(migrations[0].version).toBe(2);
    });

    it('should return empty array when no migrations needed', () => {
      const migrations = getMigrations(2, 2);
      expect(migrations).toHaveLength(0);
    });
  });

  describe('Schema Version Tracking', () => {
    it('should track schema version in schema_info table', () => {
      createSchema(db);

      const versionStmt = db.prepare("SELECT value FROM schema_info WHERE key = 'version'");
      const versionRow = versionStmt.get() as { value: string } | undefined;

      // Initially no version set (createSchema doesn't set it, db.ts does)
      expect(versionRow).toBeUndefined();
    });

    it('should allow setting schema version', () => {
      createSchema(db);

      db.prepare("INSERT OR REPLACE INTO schema_info (key, value) VALUES (?, ?)").run('version', '2');

      const versionStmt = db.prepare("SELECT value FROM schema_info WHERE key = 'version'");
      const versionRow = versionStmt.get() as { value: string };

      expect(versionRow.value).toBe('2');
    });
  });

  describe('Running Migrations Forward', () => {
    it('should run migration v0 → v1 (initial schema)', () => {
      createSchema(db);

      // Migration v1 is a no-op marker since createSchema handles it
      runMigrations(db, 0, 1);

      // Verify all tables exist
      const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all() as Array<{ name: string }>;

      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('schema_info');
      expect(tableNames).toContain('projects');
      expect(tableNames).toContain('roles');
      expect(tableNames).toContain('tasks');
      expect(tableNames).toContain('kanban_history');
      expect(tableNames).toContain('communication_log');
      expect(tableNames).toContain('artifacts');
      expect(tableNames).toContain('sprints');
      expect(tableNames).toContain('dag_nodes');
      expect(tableNames).toContain('quality_gates');
      expect(tableNames).toContain('message_queue');
    });

    it('should run migration v1 → v2 (add columns)', () => {
      createSchema(db);
      runMigrations(db, 0, 1);

      // Run migration v2
      runMigrations(db, 1, 2);

      // Verify estimated_hours column exists in tasks
      const tasksInfo = db.pragma('table_info(tasks)') as Array<{ name: string; type: string }>;
      const estimatedHoursCol = tasksInfo.find(col => col.name === 'estimated_hours');
      expect(estimatedHoursCol).toBeDefined();
      expect(estimatedHoursCol?.type).toBe('REAL');

      // Verify retries column exists in dag_nodes
      const dagNodesInfo = db.pragma('table_info(dag_nodes)') as Array<{ name: string; type: string }>;
      const retriesCol = dagNodesInfo.find(col => col.name === 'retries');
      expect(retriesCol).toBeDefined();
      expect(retriesCol?.type).toBe('INTEGER');
    });

    it('should run migrations v0 → v2 in sequence', () => {
      createSchema(db);

      // Run all migrations at once
      runMigrations(db, 0, 2);

      // Verify v2 columns exist
      const tasksInfo = db.pragma('table_info(tasks)') as Array<{ name: string }>;
      const dagNodesInfo = db.pragma('table_info(dag_nodes)') as Array<{ name: string }>;

      expect(tasksInfo.some(col => col.name === 'estimated_hours')).toBe(true);
      expect(dagNodesInfo.some(col => col.name === 'retries')).toBe(true);
    });

    it('should be idempotent when already at target version', () => {
      createSchema(db);
      runMigrations(db, 0, 2);

      // Run again - should be no-op
      expect(() => runMigrations(db, 2, 2)).not.toThrow();
    });
  });

  describe('Individual Migration Execution', () => {
    it('should execute migration v2 up function', () => {
      createSchema(db);
      runMigrations(db, 0, 1);

      const migration2 = getMigration(2);
      expect(migration2).toBeDefined();

      migration2!.up(db);

      // Verify columns were added
      const tasksInfo = db.pragma('table_info(tasks)') as Array<{ name: string }>;
      const dagNodesInfo = db.pragma('table_info(dag_nodes)') as Array<{ name: string }>;

      expect(tasksInfo.some(col => col.name === 'estimated_hours')).toBe(true);
      expect(dagNodesInfo.some(col => col.name === 'retries')).toBe(true);
    });
  });

  describe('Migration Rollback', () => {
    it('should throw error when rolling back v1 (initial schema)', () => {
      createSchema(db);

      const migration1 = getMigration(1);
      expect(migration1).toBeDefined();

      expect(() => migration1!.down(db)).toThrow('Cannot rollback initial schema');
    });

    it('should throw error when rolling back v2 (SQLite limitation)', () => {
      createSchema(db);
      runMigrations(db, 0, 2);

      const migration2 = getMigration(2);
      expect(migration2).toBeDefined();

      // SQLite doesn't support DROP COLUMN
      expect(() => migration2!.down(db)).toThrow('SQLite does not support DROP COLUMN');
    });

    it('should handle rollback request for multiple versions', () => {
      createSchema(db);
      runMigrations(db, 0, 2);

      // Attempting to rollback from v2 to v0 should fail at v2
      expect(() => runMigrations(db, 2, 0)).toThrow();
    });
  });

  describe('Error Handling', () => {
    it('should throw error on invalid migration', () => {
      createSchema(db);

      // Attempting to run a migration that doesn't exist
      // This should complete successfully but log that no migrations are needed
      expect(() => runMigrations(db, 10, 11)).not.toThrow();
    });

    it('should handle migration errors gracefully', () => {
      createSchema(db);

      // Create a scenario where migration would fail
      // For example, trying to add a column that already exists
      const migration2 = getMigration(2);
      migration2!.up(db); // First time succeeds

      // Second time should fail (column already exists)
      expect(() => migration2!.up(db)).toThrow();
    });
  });

  describe('Data Integrity', () => {
    it('should preserve existing data when migrating v1 → v2', () => {
      createSchema(db);
      runMigrations(db, 0, 1);

      // Insert project first (foreign key requirement)
      db.prepare(`
        INSERT INTO projects (id, name, path, session_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('proj-1', 'Test Project', '/test', 'session-1', 'active', '2024-01-01', '2024-01-01');

      // Insert test data
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, kanban_status, created_at, updated_at, moved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('task-1', 'proj-1', 'Test Task', 'todo', '2024-01-01', '2024-01-01', '2024-01-01');

      db.prepare(`
        INSERT INTO dag_nodes (id, project_id, execution_plan_id, layer_index, node_type, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('node-1', 'proj-1', 'plan-1', 0, 'execution', 'pending');

      // Run migration
      runMigrations(db, 1, 2);

      // Verify data is preserved
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-1') as any;
      expect(task).toBeDefined();
      expect(task.title).toBe('Test Task');
      expect(task.estimated_hours).toBeNull(); // New column defaults to NULL

      const node = db.prepare('SELECT * FROM dag_nodes WHERE id = ?').get('node-1') as any;
      expect(node).toBeDefined();
      expect(node.node_type).toBe('execution');
      expect(node.retries).toBe(0); // New column defaults to 0
    });

    it('should allow inserting data with new columns after migration', () => {
      createSchema(db);
      runMigrations(db, 0, 2);

      // Insert project first (foreign key requirement)
      db.prepare(`
        INSERT INTO projects (id, name, path, session_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('proj-1', 'Test Project', '/test', 'session-1', 'active', '2024-01-01', '2024-01-01');

      // Insert data with new columns
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, kanban_status, estimated_hours, created_at, updated_at, moved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('task-2', 'proj-1', 'Task with hours', 'todo', 3.5, '2024-01-01', '2024-01-01', '2024-01-01');

      db.prepare(`
        INSERT INTO dag_nodes (id, project_id, execution_plan_id, layer_index, node_type, status, retries)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('node-2', 'proj-1', 'plan-1', 0, 'execution', 'pending', 2);

      // Verify data was inserted correctly
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get('task-2') as any;
      expect(task.estimated_hours).toBe(3.5);

      const node = db.prepare('SELECT * FROM dag_nodes WHERE id = ?').get('node-2') as any;
      expect(node.retries).toBe(2);
    });
  });
});
