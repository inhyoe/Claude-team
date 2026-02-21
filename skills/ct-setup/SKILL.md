# Claude Team - Setup Skill

Initialize and configure Claude Team for a project.

## Usage

```
/ct-setup
/ct-setup --reset
```

### Commands

- **(no args)** - Initialize Claude Team for the current project
- **--reset** - Reset configuration and database

### Examples

```bash
/ct-setup                    # First-time setup
/ct-setup --reset            # Reset and reconfigure
```

## Setup Steps

1. **Check dependencies**: Verify `better-sqlite3` is installed
2. **Initialize database**: Create SQLite DB with 10-table schema
3. **Create directories**: `.omc/artifacts/`, `.omc/state/`
4. **Verify MCP tools**: Check Claude Team bridge + Codex/Gemini availability
5. **Create project record**: Register project in database
6. **Display configuration**: Show available roles and providers

## Configuration

Claude Team reads configuration from `.omc/ct-config.json`:

```json
{
  "maxAgents": 4,
  "defaultComplexity": "medium",
  "providers": {
    "codex": true,
    "gemini": false
  },
  "qualityGates": {
    "enabled": true,
    "minScore": 7.0,
    "maxRetries": 3
  },
  "kanban": {
    "requireGateForDone": true
  }
}
```

## Provider Detection

Setup automatically detects available MCP providers:
- **Claude Team Bridge**: Required. Provides 23 tools for state management, complexity analysis, role selection, DAG planning, kanban validation, quality scoring, team orchestration, and pipeline control.
- **Codex**: Required for QA, Security, DevOps, DBA roles
- **Gemini**: Optional, for UI/UX and large-context tasks
- **Fallback**: If Codex unavailable, Claude sonnet handles all roles

## MCP Tool Verification

During setup, verify the Claude Team bridge is operational:

```
# Check role configuration
ct_role_info({ cwd: "/path/to/project" })
-> Available roles: PM, PL, FE Dev, BE Dev, QA, UI/UX Designer, DevOps, Security, DBA

# Test complexity analysis
ct_analyze_complexity({ description: "test task" })
-> { level: "tiny", score: 0.1, recommendedAgentCount: 1 }

# Check pipeline state
ct_team_status({ cwd: "/path/to/project" })
-> No active Claude Team pipeline.
```

### Available MCP Tools (23 total)

**State readers** (read pipeline JSON state):

| Tool | Purpose |
|------|---------|
| `ct_team_status` | Pipeline phase, worker counts, task progress |
| `ct_kanban_board` | Kanban column distribution |
| `ct_quality_summary` | Quality gate pass/fail summary |
| `ct_role_info` | Active role assignments and providers |
| `ct_sprint_status` | Sprint progress and velocity |

**State writers** (mutate pipeline state):

| Tool | Purpose |
|------|---------|
| `ct_init_pipeline` | Initialize a new pipeline with project config |
| `ct_update_state` | Update pipeline state (phase, tasks, artifacts) |
| `ct_transition_phase` | Transition pipeline to next phase with validation |

**Logic tools** (call compiled TypeScript modules):

| Tool | Purpose |
|------|---------|
| `ct_analyze_complexity` | Score task complexity (0-1), recommend agent count |
| `ct_select_roles` | Pick and merge roles based on complexity level |
| `ct_build_dag` | Build layered DAG execution plan |
| `ct_validate_transition` | Validate kanban state transitions (params: taskId, fromStatus, toStatus, movedBy, reason) |
| `ct_score_review` | Parse raw Codex/LLM review into structured scores |
| `ct_aggregate_reviews` | Combine reviewer scores with role-based weighting |
| `ct_gate_verdict` | Determine pass/reject/escalate verdict |
| `ct_get_agent_prompt` | Get composed agent prompt for a role with persona |
| `ct_decompose_task` | Decompose task into subtasks with DAG dependencies |
| `ct_escalation_decision` | Determine escalation action for gate failures |
| `ct_list_roles` | List all available roles with definitions |

**Orchestration tools** (team management and execution):

| Tool | Purpose |
|------|---------|
| `ct_build_team` | Build team with role assignments for a complexity level |
| `ct_register_team` | Register team members and generate agent payloads |
| `ct_get_plan_status` | Get DAG execution plan status from persistence |
| `ct_run_pwj_cycle` | Run a Planner-Worker-Judge orchestration cycle |
