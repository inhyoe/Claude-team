/**
 * Claude Team - Database Schema
 *
 * 10 tables for the role-based team simulation.
 */

import type BetterSqlite3 from 'better-sqlite3';

/**
 * Create all tables if they don't exist.
 */
export function createSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    -- Schema version tracking
    CREATE TABLE IF NOT EXISTS schema_info (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Projects
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'completed', 'failed')),
      current_sprint_id TEXT,
      execution_plan_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Roles (agent assignments)
    CREATE TABLE IF NOT EXISTS roles (
      role_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL
        CHECK (role IN ('pm', 'pl', 'fe-dev', 'be-dev', 'qa-engineer', 'ui-ux-designer', 'devops-engineer', 'security-specialist', 'dba')),
      dag_layer TEXT NOT NULL DEFAULT 'worker'
        CHECK (dag_layer IN ('planner', 'worker', 'judge')),
      persona_name TEXT NOT NULL,
      agent_name TEXT,
      provider TEXT NOT NULL DEFAULT 'claude'
        CHECK (provider IN ('claude', 'codex', 'gemini')),
      model TEXT NOT NULL DEFAULT 'sonnet'
        CHECK (model IN ('opus', 'sonnet', 'haiku', 'inherit')),
      is_merged_into TEXT,
      merged_roles TEXT, -- JSON array of merged role names
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'idle', 'completed', 'failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE INDEX IF NOT EXISTS idx_roles_project ON roles(project_id);
    CREATE INDEX IF NOT EXISTS idx_roles_role ON roles(role);

    -- Tasks (Kanban items)
    CREATE TABLE IF NOT EXISTS tasks (
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
      file_ownership TEXT, -- JSON array of glob patterns
      review_score REAL,
      sprint_id TEXT,
      dag_node_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      moved_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (sprint_id) REFERENCES sprints(id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(kanban_status);
    CREATE INDEX IF NOT EXISTS idx_tasks_role ON tasks(assigned_role);
    CREATE INDEX IF NOT EXISTS idx_tasks_sprint ON tasks(sprint_id);

    -- Kanban history (state transitions)
    CREATE TABLE IF NOT EXISTS kanban_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      moved_by TEXT NOT NULL,
      reason TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_kanban_history_task ON kanban_history(task_id);

    -- Communication log
    CREATE TABLE IF NOT EXISTS communication_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      from_role TEXT NOT NULL,
      to_role TEXT NOT NULL,
      message_type TEXT NOT NULL
        CHECK (message_type IN ('task_assignment', 'status_report', 'review_request', 'review_result', 'escalation', 'artifact_handoff', 'gate_result')),
      channel TEXT NOT NULL DEFAULT 'dm'
        CHECK (channel IN ('dm', 'broadcast', 'artifact')),
      content TEXT NOT NULL,
      metadata TEXT, -- JSON
      timestamp TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE INDEX IF NOT EXISTS idx_comm_project ON communication_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_comm_from ON communication_log(from_role);
    CREATE INDEX IF NOT EXISTS idx_comm_type ON communication_log(message_type);

    -- Artifacts
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      produced_by_role TEXT NOT NULL,
      artifact_type TEXT NOT NULL
        CHECK (artifact_type IN ('prd', 'api-spec', 'schema', 'review-report', 'test-plan', 'deploy-config', 'security-audit')),
      file_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'review', 'approved', 'rejected')),
      approved_by TEXT,
      task_id TEXT,
      sprint_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(artifact_type);

    -- Sprints
    CREATE TABLE IF NOT EXISTS sprints (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      sprint_number INTEGER NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planning'
        CHECK (status IN ('planning', 'active', 'review', 'completed')),
      velocity_score REAL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE INDEX IF NOT EXISTS idx_sprints_project ON sprints(project_id);

    -- DAG nodes (execution plan)
    CREATE TABLE IF NOT EXISTS dag_nodes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      execution_plan_id TEXT NOT NULL,
      role_id TEXT,
      layer_index INTEGER NOT NULL,
      node_type TEXT NOT NULL
        CHECK (node_type IN ('planning', 'design', 'execution', 'verification', 'deployment')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
      dependencies TEXT, -- JSON array of node IDs
      task_id TEXT,
      file_ownership TEXT, -- JSON array of glob patterns
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_dag_project ON dag_nodes(project_id);
    CREATE INDEX IF NOT EXISTS idx_dag_plan ON dag_nodes(execution_plan_id);
    CREATE INDEX IF NOT EXISTS idx_dag_layer ON dag_nodes(layer_index);

    -- Quality gates
    CREATE TABLE IF NOT EXISTS quality_gates (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      gate_type TEXT NOT NULL
        CHECK (gate_type IN ('design-review', 'code-review', 'qa-review', 'security-review', 'pl-approval')),
      reviewer_role TEXT NOT NULL,
      task_id TEXT NOT NULL,
      score REAL NOT NULL,
      dimensions TEXT NOT NULL, -- JSON: {correctness, security, performance, maintainability, test_coverage}
      verdict TEXT NOT NULL
        CHECK (verdict IN ('pass', 'conditional', 'reject', 'auto-reject')),
      feedback TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id),
      FOREIGN KEY (task_id) REFERENCES tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_gates_project ON quality_gates(project_id);
    CREATE INDEX IF NOT EXISTS idx_gates_task ON quality_gates(task_id);
    CREATE INDEX IF NOT EXISTS idx_gates_verdict ON quality_gates(verdict);

    -- Message queue (cross-process communication)
    CREATE TABLE IF NOT EXISTS message_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      from_role TEXT NOT NULL,
      to_role TEXT NOT NULL,
      message_type TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'dm',
      content TEXT NOT NULL,
      metadata TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'delivered', 'acknowledged', 'expired')),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      expires_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE INDEX IF NOT EXISTS idx_mq_to_role ON message_queue(to_role, status);
    CREATE INDEX IF NOT EXISTS idx_mq_project ON message_queue(project_id);
    CREATE INDEX IF NOT EXISTS idx_mq_status ON message_queue(status);
  `);
}

// Export migration system
export { runMigrations } from './migrations.js';
