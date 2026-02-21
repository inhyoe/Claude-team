# Claude Team - Team Orchestration Skill

Orchestrate a role-based development team to complete a software task.
Spawns PM, PL, Dev, QA, and Design agents that collaborate through a Kanban pipeline.

## Usage

```
/ct-team "task description"
/ct-team 3 "task description"
```

### Parameters

- **N** - Optional agent count (1-4). Auto-determined by complexity analysis if omitted.
- **task** - High-level task to decompose and distribute among role-based agents.

### Examples

```bash
/ct-team "Build a REST API for user management with authentication"
/ct-team 4 "Implement real-time chat feature with WebSocket support"
/ct-team "Fix the authentication flow bug and add session management"
```

## Architecture

```
User: "/ct-team Build REST API"
              |
              v
      [COMPLEXITY ANALYZER]
              |
              +-- Analyze task -> Score 0.0-1.0
              |
              v
      [ROLE MERGER]
              |
              +-- Score -> Agent count (1-4)
              +-- Merge roles by DAG layer
              |
              v
      [DAG ENGINE]
              |
              +-- Build execution plan
              +-- Layer 0: Planning (PM, PL)
              +-- Layer 1: Design (PL, DBA)
              +-- Layer 2: Execution (FE Dev, BE Dev)
              +-- Layer 3: Verification (QA, Security)
              |
              v
      [TEAM ORCHESTRATOR]
              |
              +-- TeamCreate
              +-- TaskCreate per subtask
              +-- Spawn agents (Claude + Codex)
              +-- Monitor via Kanban board
              +-- Quality gates between layers
              +-- Shutdown on completion
```

## Pipeline Stages

### 1. team-plan
- PM analyzes requirements, creates PRD
- PL designs architecture, assigns file ownership
- Complexity analysis determines team size

### 2. team-prd
- PM refines acceptance criteria
- QA defines test criteria
- Only for medium+ complexity tasks

### 3. team-exec
- Workers execute assigned tasks in parallel
- File ownership prevents conflicts
- PL mediates shared file access

### 4. team-verify
- QA reviews code quality (Codex-powered)
- Security specialist audits (for security-relevant changes)
- PL gives final approval
- Quality gates: score >= 7.0, all dimensions >= 3

### 5. team-fix (loop)
- Workers address review feedback
- Re-submit for verification
- Max 3 attempts before PL escalation

## Provider Distribution

| Agent | Provider | When |
|-------|----------|------|
| PM, PL | Claude (opus) | Always - need reasoning + team messaging |
| FE Dev, BE Dev | Claude (sonnet) | Always - need iterative tool use |
| UI/UX Designer | Claude (sonnet) | When UI work needed |
| QA Engineer | Codex | Review tasks - one-shot analysis |
| Security | Codex | Security audits - specialized analysis |
| DevOps | Codex | Infrastructure tasks - autonomous |
| DBA | Codex | Schema/query work - autonomous |

## Quality Gates

Codex reviews score on 5 dimensions (1-10 each):
- **Correctness**: Logic and behavior correctness
- **Security**: Vulnerability assessment
- **Performance**: Efficiency and scalability
- **Maintainability**: Code quality and readability
- **Test Coverage**: Test completeness

| Score | Action |
|-------|--------|
| >= 7.0 (all dims >= 3) | PASS -> Done |
| 5.0-6.9 | CONDITIONAL -> opus re-review |
| 3.0-4.9 | REJECT -> rework with feedback |
| < 3.0 | AUTO-REJECT -> PL escalation |

## State Persistence

Pipeline state persists to `.omc/state/ct-pipeline-state.json` for resume capability.
Artifacts stored in `.omc/artifacts/{sprint}/{task}/`.

## MCP Tool Integration

The orchestrator calls Claude Team MCP tools at each pipeline stage. These tools provide the computational logic that drives team decisions.

### Orchestration Flow

```
1. ct_analyze_complexity  ->  Determine task scope and agent count
2. ct_select_roles        ->  Pick roles and merge configuration
3. ct_build_dag           ->  Create layered execution plan
4. ct_validate_transition ->  Guard every kanban state change
5. ct_score_review        ->  Parse each reviewer's response
6. ct_aggregate_reviews   ->  Combine weighted scores
7. ct_gate_verdict        ->  Decide pass/reject/escalate
```

### Step-by-Step MCP Calls

**team-plan stage:**

```
# 1. Analyze complexity from user task description
ct_analyze_complexity({ description: "Build REST API with JWT auth" })
-> { level: "large", score: 0.75, recommendedAgentCount: 4 }

# 2. Select and merge roles based on complexity
ct_select_roles({ level: "large", score: 0.75 })
-> { agentCount: 4, roles: [...], providerDistribution: { claude: [...], codex: [...] } }

# 3. Build DAG execution plan from decomposed tasks
ct_build_dag({
  projectId: "proj-1",
  tasks: [
    { id: "t1", title: "Requirements", assignedRole: "pm", nodeType: "planning", dependencies: [] },
    { id: "t2", title: "Architecture", assignedRole: "pl", nodeType: "planning", dependencies: [] },
    { id: "t3", title: "API impl", assignedRole: "be-dev", nodeType: "execution", dependencies: ["t1","t2"] },
    { id: "t4", title: "Code review", assignedRole: "qa-engineer", nodeType: "verification", dependencies: ["t3"] }
  ]
})
-> { planId: "...", totalLayers: 3, layers: [...] }
```

**team-exec stage (kanban moves):**

```
# Validate before each task state transition
ct_validate_transition({ taskId: "task-1", fromStatus: "todo", toStatus: "in-progress", movedBy: "be-dev", reason: "Starting implementation" })
-> { valid: true, allowedTransitions: ["in-progress", "blocked", "backlog"] }
```

**team-verify stage:**

```
# 1. Parse raw Codex review into structured scores
ct_score_review({ response: '{"correctness":8,"security":6,...,"feedback":"Missing tests"}' })
-> { dimensions: {...}, score: 6.6, verdict: "conditional" }

# 2. Aggregate multiple reviewers (QA 1.3x + Security 1.5x weighting)
ct_aggregate_reviews({
  reviews: [
    { reviewerRole: "qa-engineer", dimensions: { correctness: 8, security: 6, ... } },
    { reviewerRole: "security-specialist", dimensions: { correctness: 7, security: 5, ... } }
  ]
})
-> { dimensions: {...}, score: 6.4, verdict: "conditional" }

# 3. Get final verdict with attempt tracking
ct_gate_verdict({ score: 6.4, dimensions: {...}, attempt: 1 })
-> { verdict: "conditional", action: "Re-review with higher-tier model (opus)", exhausted: false }
```

**team-fix stage:**

```
# After fix, re-validate transition back to review
ct_validate_transition({ taskId: "task-1", fromStatus: "in-progress", toStatus: "review", movedBy: "be-dev", reason: "Implementation complete, requesting review" })
-> { valid: true }

# Re-run review cycle (attempt 2/3)
ct_gate_verdict({ score: 7.8, dimensions: {...}, attempt: 2 })
-> { verdict: "pass", action: "Move task to Done", exhausted: false }
```

## PWJ Cycle Execution

`ct_run_pwj_cycle` returns structured phase instructions for each cycle:

### Parameters
- `cwd` - Project working directory
- `projectId` - Project ID
- `complexity` - `{ level: 'tiny'|'small'|'medium'|'large', score: number }`
- `taskSpecs` - Array of task specifications
- `maxReworkCycles` - Max rework iterations (default: 3)
- `reworkCount` - Current rework iteration (for retries, default: 0)
- `previousFeedback` - Judge feedback from previous cycle (for retries)

### Response
Returns `{ status: 'ready', phases: { planning, execution, judgment }, instructions }` with role-specific prompts for each phase.

### Usage Pattern
1. Call `ct_run_pwj_cycle` to get phase instructions
2. Execute planning phase by calling planning role agents with `phases.planning.prompt`
3. Execute workers with `phases.execution.prompt`
4. Execute judges with `phases.judgment.prompt`
5. Parse scores with `ct_score_review`, get verdict with `ct_gate_verdict`
6. If verdict is 'reject', call `ct_run_pwj_cycle` again with `reworkCount+1`
