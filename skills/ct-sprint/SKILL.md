# Claude Team - Sprint Management Skill

Manage development sprints within a Claude Team project.

## Usage

```
/ct-sprint start "Sprint goal description"
/ct-sprint status
/ct-sprint complete
```

### Commands

- **start** - Create a new sprint with a goal
- **status** - Show current sprint progress (kanban counts, velocity)
- **complete** - Mark current sprint as completed, calculate velocity

### Examples

```bash
/ct-sprint start "Implement user authentication module"
/ct-sprint status
/ct-sprint complete
```

## Sprint Flow

1. **Planning**: PM defines sprint goal, PL decomposes into tasks
2. **Active**: Tasks flow through kanban (Backlog -> Todo -> In-Progress -> Review -> Done)
3. **Review**: PL reviews sprint completion, calculates velocity
4. **Completed**: Sprint archived, velocity score recorded

## Velocity Tracking

Velocity = (completed tasks / total tasks) * (average quality score / 10)

Sprint data persists in SQLite for historical tracking.

## MCP Tool Integration

### Checking Sprint Progress

```
# Get sprint metrics (completed/total tasks, velocity, quality)
ct_sprint_status({ cwd: "/path/to/project", projectId: "proj-1" })
-> Sprint Progress: 3/4 tasks completed
   Velocity: 76.0%
   Quality: 3 passed, 0 failed
   Phase: team-verify
```

### Complementary Tools

Use alongside other MCP tools for full sprint visibility:

```
# Kanban distribution during sprint
ct_kanban_board({ cwd: "/path/to/project", projectId: "proj-1" })
-> | Backlog | Todo | In-Progress | Review | Done |
   |    0    |  0   |      1      |   0    |  3   |

# Role workload during sprint
ct_role_info({ cwd: "/path/to/project" })
-> Team Roles (4 active):
   pm(Alex) [claude/opus] - idle
   pl(Jordan) [claude/opus] - active
   be-dev(Morgan) [claude/sonnet] - active
   qa-engineer(Riley) [codex/sonnet] - active

# Overall pipeline status
ct_team_status({ cwd: "/path/to/project" })
-> Phase: team-verify, Workers: 2/3, Tasks: 3/4 completed
```
