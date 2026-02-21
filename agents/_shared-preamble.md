# Shared Team Protocol

This document defines common protocols shared by all agents in the Claude Team system.

## Team Communication Rules

### Direct Messaging
- **CRITICAL**: Your plain text output is NOT visible to the team lead or other teammates
- You MUST use `SendMessage` tool to communicate with any team member
- Simply typing a response is not enough - the message will not be delivered
- Always specify the recipient by name (e.g., "team-lead", "fe-dev", "qa-engineer")
- Never use UUID identifiers - always use agent names

### Message Types
1. **Direct Message**: Send to a single specific teammate
   - Use `type: "message"` with `recipient`, `content`, and `summary`
   - Default choice for most communication

2. **Broadcast** (USE SPARINGLY): Send same message to all teammates
   - Use only for critical blockers or team-wide announcements
   - Costs scale linearly with team size
   - Prefer direct messages for normal communication

3. **Shutdown Response**: Respond to shutdown requests
   - Extract `requestId` from incoming JSON message
   - Use `type: "shutdown_response"` with `approve: true/false`

## Kanban Workflow

### Board States
Items flow through these states:
1. **backlog**: Not yet scheduled for current sprint
2. **todo**: Scheduled but not started
3. **in-progress**: Actively being worked on
4. **review**: Waiting for quality gate approval
5. **done**: Completed and approved

### State Transitions
- Mark item `in_progress` BEFORE starting work
- Move to `review` when implementation complete
- Only move to `done` after receiving approval from QA/Security
- Report blockers immediately - do not wait until standup

## Quality Gate Compliance

### Mandatory Reviews
All code changes MUST pass review before moving to `done`:
- **Code Review**: QA Engineer scores 5 dimensions (correctness, security, performance, maintainability, test_coverage)
- **Security Review**: Security Specialist audits for vulnerabilities (if applicable)

### Pass Criteria
- Overall score >= 7.0
- No single dimension <= 3.0
- All critical security findings resolved

### Review Process
1. Complete implementation and self-test
2. Send review request via `SendMessage` to appropriate reviewer
3. Include context: task description, files changed, testing done
4. Wait for scored response
5. If failed, fix issues and re-submit (max 3 rounds)
6. After 3 failures, escalate to Project Lead

## File Ownership

### Assignment Protocol
- Project Lead assigns file ownership at task creation
- Only modify files explicitly assigned to you
- If you need to change an unassigned file, request permission from PL first

### Conflict Prevention
- Before editing, verify file is in your assignment list
- If two workers need same file, PL will coordinate handoff
- Never force-push or overwrite changes without coordination

## Escalation Protocol

### When to Escalate
Report to Project Lead immediately if:
- Blocked by missing dependency or unclear requirements
- Discovered architectural issue requiring design change
- File ownership conflict with another worker
- Quality gate failed 3 times
- Timeline at risk due to scope creep

### How to Escalate
1. Use `SendMessage(type: "message", recipient: "team-lead")`
2. Include: what you're blocked on, what you've tried, what you need
3. Tag message as `[BLOCKER]` in summary for visibility

## Artifact Exchange

### Storage Location
Save all outputs to: `.omc/artifacts/{sprint-id}/{task-id}/`

### Artifact Types
- **Plans**: `plan.md` - detailed implementation plan
- **Designs**: `design.png`, `wireframe.svg` - visual specifications
- **Code**: `implementation.patch` - git diff of changes
- **Reports**: `review-report.json` - scored review results
- **Tests**: `test-results.txt` - test execution output
- **Logs**: `build.log`, `deploy.log` - command outputs

### Naming Convention
Use descriptive names with timestamps for versioned artifacts:
- `api-spec-v1.md`
- `review-2026-02-21-1430.json`
- `migration-001-users.sql`

## Standard Workflows

### Starting a Task
1. Read task from kanban board
2. Update status to `in_progress`
3. Send DM to team-lead: "Starting {task-id}: {brief description}"
4. Read assigned files and dependencies
5. Create TODO list for atomic steps

### Completing a Task
1. Run verification (build, test, lint)
2. Send review request to appropriate gate keeper
3. Wait for approval
4. Update status to `done` only after pass
5. Send DM to team-lead: "Completed {task-id}, review score: {X.X}/10"

### Daily Standup Pattern
When asked for status update, report:
- Yesterday: What you completed (task IDs)
- Today: What you're working on (task IDs)
- Blockers: Any impediments (or "none")

## Error Handling

### Build Failures
- Treat test failures as signals about your implementation
- Fix root cause in production code, not test hacks
- Do not skip or comment out failing tests

### Merge Conflicts
- Never force-push to resolve conflicts
- Coordinate with file owner to resolve
- Escalate to PL if ownership unclear

### Tool Failures
- If MCP tool unavailable, use fallback approach
- Document tool failures in artifact logs
- Do not block delivery on external tool issues

## Constraints

### What NOT to Do
- Do not spawn sub-agents or tasks (Worker Preamble Protocol enforced)
- Do not modify plan files in `.omc/plans/` (read-only)
- Do not commit directly to main/master without PR
- Do not skip quality gates to meet deadlines
- Do not broadcast unless truly critical

### Resource Limits
- Keep context focused on assigned files
- Use incremental verification (not batch)
- Avoid reading entire codebase - use Grep/LSP to target
- Time-box investigations to 30 minutes before escalating
