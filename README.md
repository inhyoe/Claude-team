# Claude Team

Role-based development team simulation plugin for [Claude Code](https://claude.ai/claude-code).

Instead of generic executor agents, Claude Team creates a **virtual development team** with specialized roles (PM, PL, Frontend, Backend, QA, Designer, DevOps, Security, DBA) that collaborate through structured communication, Kanban workflow, and quality gates.

## Key Features

- **9 Specialized Roles** with distinct personas, expertise areas, and AI provider assignments
- **DAG-based Task Orchestration** with topological sorting and parallel execution layers
- **Kanban Pipeline** (Backlog -> Todo -> In-Progress -> Review -> Done) with state machine validation
- **Quality Gates** with 5-dimension scoring (correctness, security, performance, maintainability, test coverage)
- **Role Merging** that scales 1-4 agents based on task complexity
- **SQLite Persistence** (WAL mode) with 10-table schema for full state tracking
- **Structured JSON Communication** with role-based send/receive permissions
- **MCP Bridge** exposing team tools to Claude Code

## Architecture

```
User: "/ct-team build REST API"
        |
        v
  [PM: Requirements]  [PL: Architecture]     <- Layer 0 (Planning)
        |                    |
        +--- QUALITY GATE ---+
        |
  [BE Dev: API]  [FE Dev: Client]            <- Layer 1 (Execution)
        |              |
        +--- QUALITY GATE ---+
        |
  [QA: Tests]  [Security: Audit]             <- Layer 2 (Verification)
        |
        v
      Done
```

### Planner-Worker-Judge Pattern

The system uses a three-tier hierarchy inspired by research on multi-agent coding systems:

| Tier | Roles | Responsibility |
|------|-------|---------------|
| **Planner** | PM, PL | Requirements, architecture, task decomposition |
| **Worker** | FE Dev, BE Dev, UI/UX, DevOps, DBA | Implementation |
| **Judge** | QA Engineer, Security Specialist | Review, quality gates |

## Roles

| Role | Persona | Model | Provider | Tier |
|------|---------|-------|----------|------|
| PM | Alex | opus | claude | Planner |
| PL | Jordan | opus | claude | Planner |
| FE Dev | Sam | sonnet | claude | Worker |
| BE Dev | Morgan | sonnet | claude | Worker |
| QA Engineer | Riley | sonnet | codex | Judge |
| UI/UX Designer | Taylor | sonnet | claude | Worker |
| DevOps | Casey | sonnet | codex | Worker |
| Security | Avery | opus | codex | Judge |
| DBA | Drew | sonnet | codex | Worker |

### AI Provider Strategy

The system uses a dual-provider architecture with Claude and Codex, assigning roles based on task characteristics:

| Provider | Roles | Rationale |
|----------|-------|-----------|
| **Claude** | PM, PL, FE Dev, BE Dev, UI/UX Designer | Iterative tool use, team messaging, multi-turn collaboration |
| **Codex** | QA Engineer, Security, DevOps, DBA | One-shot analysis/review, cost-efficient, strong at structured evaluation |

**Why Codex for Judges?** Codex excels at structured code review and security analysis tasks that benefit from independent, single-pass evaluation. This separation also provides an unbiased review perspective — the reviewer uses a different model than the implementer.

**Fallback:** When Codex is unavailable, roles fall back to Claude sonnet to maintain pipeline continuity.

### Role Merging

For smaller tasks, roles are merged to reduce overhead:

| Complexity | Agents | Configuration |
|-----------|--------|--------------|
| Tiny (< 0.2) | 1 | PL absorbs all roles |
| Small (0.2-0.4) | 2 | PM+PL merged, 1 Worker |
| Medium (0.4-0.7) | 3 | PM, PL+Worker, QA |
| Large (0.7-1.0) | 4 | PM, PL, Workers, QA+Security |

Merge rules: same DAG layer only, same AI provider only, bidirectional compatibility required.

## Kanban Pipeline

```
Backlog -> Todo -> In-Progress -> Review -> Done
  ^          ^          ^           |
  |          |          +-----------+  (review rejection)
  |          +--- Blocked ---+
  +--- Failed (retriable) --+
```

Each transition is validated by a state machine with role-based authorization:
- **PM/PL**: Full access to all transitions
- **Workers**: Can move their own tasks forward (todo -> in-progress -> review)
- **Judges**: Can approve (review -> done) or reject (review -> in-progress)

## Quality Gates

5-dimension scoring on a 1-10 scale:

| Dimension | Weight |
|-----------|--------|
| Correctness | Standard |
| Security | Standard |
| Performance | Standard |
| Maintainability | Standard |
| Test Coverage | Standard |

**Verdicts:**

| Score | Verdict | Action |
|-------|---------|--------|
| >= 7.0 (all dims >= 3) | Pass | Move to Done |
| 5.0 - 6.9 | Conditional | Re-review with higher-tier model |
| 3.0 - 4.9 | Reject | Return to In-Progress with feedback |
| < 3.0 | Auto-reject | Escalate to PL |

Maximum 3 review attempts per gate. After exhaustion, PL decides: retry, split task, redesign, or accept risk.

### Weighted Review Aggregation

When multiple reviewers score the same task:
- Security Specialist: 1.5x weight
- QA Engineer: 1.3x weight
- PL: 1.2x weight
- Other roles: 1.0x weight

## Installation

```bash
# Clone the repository
git clone https://github.com/ryu/claude-team.git
cd claude-team

# Install dependencies
npm install

# Build
npm run build
```

### Requirements

- Node.js >= 20.0.0
- Claude Code CLI
- `better-sqlite3` (installed automatically)

## Usage

### Skills

| Skill | Description |
|-------|-------------|
| `/ct-team` | Main team orchestration - decompose and execute with role-based agents |
| `/ct-sprint` | Sprint management - plan, track, and review sprints |
| `/ct-kanban` | Kanban board - view and manage task statuses |
| `/ct-review` | Quality gate review - trigger and view review results |
| `/ct-setup` | Plugin setup and configuration |

### Example

```bash
# Start a team session
/ct-team "Build a user authentication system with JWT tokens"

# View kanban board
/ct-kanban

# Trigger quality review
/ct-review task-1

# Manage sprint
/ct-sprint plan
```

## Workflow: End-to-End Example

Here's how Claude Team processes a real task from start to finish.

### Scenario: `"Build a REST API for user management with authentication"`

#### Step 0: Complexity Analysis

```
/ct-team "Build a REST API for user management with authentication"
```

The complexity analyzer evaluates:
- File count: ~12 (routes, controllers, middleware, models, tests)
- Cross-module dependencies: 4 (auth ↔ user ↔ DB ↔ middleware)
- API changes: Yes
- Security implications: Yes (authentication, password hashing)
- DB changes: Yes (user table)

→ **Score: 0.75 (Large)** → 4 agents activated

#### Step 1: team-plan — Planning (Layer 0)

**Active Agents:**

| Agent | Role | Provider | Action |
|-------|------|----------|--------|
| Alex (PM) | Planner | Claude opus | Writes PRD with user stories, acceptance criteria |
| Jordan (PL) | Planner | Claude opus | Designs architecture, assigns file ownership per task |

**PM (Alex) produces:**
```
.omc/artifacts/sprint-1/prd.md
├── User Stories: Registration, Login, Token Refresh, Logout
├── Acceptance Criteria per story
└── Priority: Login > Registration > Token > Logout
```

**PL (Jordan) produces:**
```
.omc/artifacts/sprint-1/architecture.md
├── File Ownership Map:
│   ├── BE Dev: src/routes/, src/controllers/, src/models/
│   ├── FE Dev: (not needed for this task)
│   ├── DBA: src/db/migrations/, src/db/schema.ts
│   └── Security: src/middleware/auth.ts (review only)
├── DAG Execution Plan (4 layers)
└── Shared file mediation plan
```

**Kanban Board:**
```
| Backlog   | Todo       | In-Progress | Review | Done |
|-----------|------------|-------------|--------|------|
| task-1    |            |             |        |      |
| task-2    |            |             |        |      |
| task-3    |            |             |        |      |
| task-4    |            |             |        |      |
```

→ **Quality Gate**: PL approves planning artifacts before execution begins

#### Step 2: team-exec — Execution (Layer 1-2)

**Active Agents:**

| Agent | Role | Provider | Assigned Tasks |
|-------|------|----------|----------------|
| Morgan (BE Dev) | Worker | Claude sonnet | task-1: User model + CRUD API |
| Drew (DBA) | Worker | Codex | task-2: DB migration + schema |

Workers execute in parallel with file ownership isolation:

```
Morgan (Claude sonnet):               Drew (Codex):
├── src/models/user.ts                ├── src/db/migrations/001_users.ts
├── src/routes/auth.ts                ├── src/db/schema.ts
├── src/controllers/auth.ts           └── src/db/seed.ts
└── src/middleware/jwt.ts
```

**Kanban Board progression:**
```
| Backlog | Todo   | In-Progress | Review | Done |
|---------|--------|-------------|--------|------|
| task-3  |        | task-1 (Morgan) |    |      |
| task-4  |        | task-2 (Drew)   |    |      |
```

As each worker finishes, they move their task to Review:
```
| Backlog | Todo   | In-Progress | Review         | Done |
|---------|--------|-------------|----------------|------|
| task-3  |        |             | task-1 (Morgan)|      |
| task-4  |        |             | task-2 (Drew)  |      |
```

#### Step 3: team-verify — Quality Review (Layer 3)

**Active Agents:**

| Agent | Role | Provider | Review Type |
|-------|------|----------|-------------|
| Riley (QA) | Judge | Codex | Code review + test coverage |
| Avery (Security) | Judge | Codex | Security audit |

Codex receives the diff and changed files list, produces structured JSON scores:

**Riley (QA via Codex) reviews task-1:**
```json
{
  "correctness": 8,
  "security": 6,
  "performance": 7,
  "maintainability": 8,
  "testCoverage": 4,
  "feedback": "Missing unit tests for auth controller. JWT expiry edge case not handled."
}
```
→ Average: 6.6 → **CONDITIONAL** (test coverage too low)

**Avery (Security via Codex) reviews task-1:**
```json
{
  "correctness": 7,
  "security": 5,
  "performance": 7,
  "maintainability": 7,
  "testCoverage": 5,
  "feedback": "Password not hashed with bcrypt. JWT secret hardcoded in source."
}
```

**Weighted Aggregation** (Security 1.5x, QA 1.3x):
```
Security dimension: (6×1.3 + 5×1.5) / 2.8 = 5.5
Test Coverage:      (4×1.3 + 5×1.5) / 2.8 = 4.5
Overall:            5.5 → CONDITIONAL
```

→ Task-1 sent back to **team-fix** with combined feedback

#### Step 4: team-fix — Rework (Loop)

Morgan (BE Dev) receives aggregated feedback:
1. Add bcrypt password hashing
2. Move JWT secret to environment variable
3. Write unit tests for auth controller
4. Handle JWT expiry edge case

```
| Backlog | Todo   | In-Progress     | Review | Done         |
|---------|--------|-----------------|--------|--------------|
| task-3  |        | task-1 (Morgan) |        | task-2       |
| task-4  |        |                 |        |              |
```

After fixing, task-1 goes back to Review → **Re-review (attempt 2/3)**:

**Riley (QA via Codex) re-reviews:**
```json
{
  "correctness": 9,
  "security": 8,
  "performance": 7,
  "maintainability": 8,
  "testCoverage": 7,
  "feedback": "Good test coverage. All edge cases handled."
}
```
→ Average: 7.8 → **PASS**

```
| Backlog | Todo   | In-Progress | Review | Done              |
|---------|--------|-------------|--------|-------------------|
|         | task-3 |             |        | task-1, task-2    |
|         | task-4 |             |        |                   |
```

#### Step 5: Remaining Tasks + Completion

Tasks 3-4 follow the same cycle (exec → verify → fix if needed → done).

**Final board:**
```
| Backlog | Todo | In-Progress | Review | Done                          |
|---------|------|-------------|--------|-------------------------------|
|         |      |             |        | task-1, task-2, task-3, task-4|
```

**Sprint velocity**: 4/4 tasks × (avg score 7.6/10) = **76%**

---

### Workflow by Complexity

| Complexity | Agents | Typical Scenario | Flow |
|-----------|--------|-----------------|------|
| **Tiny** (1 agent) | PL absorbs all | "Fix typo in README" | PL plans+executes+self-reviews → Done |
| **Small** (2 agents) | Lead + Worker | "Add pagination to user list" | Lead plans → Worker implements → Lead reviews → Done |
| **Medium** (3 agents) | PM + Lead+Worker + QA | "Add search feature with filters" | PM defines scope → Lead+Worker builds → QA(Codex) reviews → Done |
| **Large** (4 agents) | PM + PL + Dev + QA+Security | "Build auth system" | Full DAG pipeline as shown above |

### Skill Commands During Execution

While the pipeline runs, you can interact with it:

```bash
# Monitor progress
/ct-kanban                        # View current board state

# Manual intervention
/ct-kanban move task-2 blocked    # Block a task (e.g., waiting for external dependency)
/ct-kanban assign task-3 fe-dev   # Reassign a task to a different role

# Trigger specific reviews
/ct-review task-1                 # Run full quality gate review
/ct-review task-1 --type security # Security-focused review only

# Sprint management
/ct-sprint status                 # Check sprint progress and velocity
/ct-sprint complete               # Mark sprint as done
```

### Escalation Scenarios

| Scenario | What Happens |
|----------|-------------|
| Review fails 3 times | PL (Jordan) decides: retry, split task, redesign, or accept risk |
| Worker unresponsive for 10min | PL reassigns task to another available worker |
| Shared file conflict | PL serializes access — no distributed locking |
| Codex unavailable | Automatic fallback to Claude sonnet for review tasks |
| Fix loop exceeds limit | Pipeline transitions to `failed` state, PL can restart from `team-plan` |

## Project Structure

```
claude-team/
├── agents/               # 9 role agent prompts + shared preamble
├── bridge/               # MCP bridge server (ct-bridge.cjs)
├── hooks/                # Pipeline and quality gate hooks
├── skills/               # User-invocable skill definitions
├── src/
│   ├── agents/           # Role definitions, merger, personas
│   ├── communication/    # Protocol, message bus, artifact exchange
│   ├── core/             # DAG engine, complexity analyzer, PWJ
│   ├── features/         # State manager, task decomposer, delegation
│   ├── kanban/           # State machine, board operations
│   ├── persistence/      # SQLite DB, 7 repository modules
│   ├── quality/          # Gates, review scorer, escalation
│   ├── shared/           # Types, constants
│   └── team/             # Team registration, task router
└── tests/
    ├── unit/             # 9 test suites, 220 tests
    └── integration/      # SQLite persistence pipeline, 36 tests
```

## Database Schema

SQLite with WAL mode. 10 tables stored at `{project}/.omc/state/claude-team.db`:

| Table | Purpose |
|-------|---------|
| `schema_info` | Version tracking |
| `projects` | Project configuration |
| `roles` | Role assignments and merging state |
| `tasks` | Kanban items with file ownership |
| `kanban_history` | State transition audit trail |
| `communication_log` | Inter-role message log |
| `artifacts` | Produced deliverables (PRD, specs, reports) |
| `sprints` | Sprint planning and velocity |
| `dag_nodes` | Execution plan nodes |
| `quality_gates` | Review scores and verdicts |

## Testing

```bash
# Run all tests
npm run test:run

# Run with watch mode
npm test

# Run specific suite
npx vitest run tests/unit/dag-engine.test.ts

# Run integration tests only
npx vitest run tests/integration/
```

**Test Coverage:**
- 9 unit test suites: DAG engine, Kanban state machine, role merger, quality scoring, communication protocol, escalation, review scorer, complexity analyzer, state manager
- 1 integration suite: Full SQLite persistence pipeline (DB lifecycle, CRUD, kanban flow, quality gates, transactions, E2E sprint cycle)
- **256 tests total**

## Communication Protocol

7 message types with typed JSON payloads:

| Type | From | To | Channel |
|------|------|-----|---------|
| `task_assignment` | PM/PL | Workers | DM |
| `status_report` | Workers | PM/PL | DM |
| `review_request` | Workers | QA/Security | DM + Artifact |
| `review_result` | QA/Security | PL | DM |
| `escalation` | Any | PM/PL | DM |
| `artifact_handoff` | Producer | Consumer | Artifact |
| `gate_result` | QA/Security | PL | DM |

## Design References

- Planner-Worker-Judge hierarchy (avoiding Cursor's flat agent failure mode)
- Maximum 3-4 concurrent agents (5+ increases coordination overhead)
- DAG-based dynamic layer composition (Google ADK, AWS Strands patterns)
- Structured JSON schema communication (2026 agentic coding trend)
- Quality gates with Codex reviewer (addressing 67.3% AI PR rejection rate)

## License

MIT
