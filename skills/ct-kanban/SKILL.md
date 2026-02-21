# Claude Team - Kanban Board Skill

View and manage the kanban board for the current Claude Team project.

## Usage

```
/ct-kanban
/ct-kanban move <task-id> <status>
/ct-kanban assign <task-id> <role>
```

### Commands

- **(no args)** - Display the full kanban board
- **move** - Move a task to a new status (validates transitions)
- **assign** - Assign a task to a role

### Examples

```bash
/ct-kanban                          # Show board
/ct-kanban move task-1 review       # Move task to review
/ct-kanban assign task-2 fe-dev     # Assign to frontend developer
```

## Board Columns

```
| Backlog | Todo | In-Progress | Review | Done |
|---------|------|-------------|--------|------|
| task-5  | task-3 | task-1   | task-2 |      |
|         | task-4 |          |        |      |
```

## Transition Rules

- **Backlog** -> Todo, Blocked
- **Todo** -> In-Progress, Blocked, Backlog
- **In-Progress** -> Review, Blocked, Failed
- **Review** -> Done (requires gate pass), In-Progress (rejected)
- **Blocked** -> Todo, In-Progress, Backlog, Failed
- **Failed** -> Backlog, Todo (retry)
- **Done** -> (terminal)

## Role Authorization

- PM/PL: Can move any task
- Workers: Can move their own assigned tasks
- Judges (QA/Security): Can approve Review -> Done

## MCP Tool Integration

### Displaying the Board

```
# Read current kanban board state
ct_kanban_board({ cwd: "/path/to/project", projectId: "proj-1" })
-> Markdown table with task counts per column
```

### Moving Tasks

Before executing any task move, **always validate** the transition:

```
# 1. Validate transition is allowed
ct_validate_transition({
  fromStatus: "in-progress",
  toStatus: "review",
  role: "be-dev"
})
-> { valid: true, allowedTransitions: ["review", "blocked", "failed"] }

# 2. If valid=false, show the error to the user
ct_validate_transition({
  fromStatus: "review",
  toStatus: "done",
  role: "fe-dev"
})
-> { valid: false, reason: "Quality gate must pass to move to done." }
```

The `allowedTransitions` field shows all legal next states from the current status. Use this to suggest valid moves when a transition is rejected.

### Checking Overall Status

```
# Get pipeline status including kanban counts
ct_team_status({ cwd: "/path/to/project" })
-> Phase, worker counts, task progress, kanban distribution
```
