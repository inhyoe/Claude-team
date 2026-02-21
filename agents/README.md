# Claude Team Agent Definitions

This directory contains persona definitions for the 9 specialized agents in the Claude Team plugin, plus a shared protocol document.

## File Structure

- **_shared-preamble.md** - Common team protocol (communication, kanban workflow, quality gates, escalation)
- **pm.md** - Project Manager "Alex" (Opus/Planner) - Requirements, PRDs, sprint planning
- **pl.md** - Project Lead "Jordan" (Opus/Planner) - Architecture, API specs, file ownership
- **fe-dev.md** - Frontend Developer "Sam" (Sonnet/Worker) - UI components, client state
- **be-dev.md** - Backend Developer "Morgan" (Sonnet/Worker) - API endpoints, business logic
- **qa-engineer.md** - QA Engineer "Riley" (Sonnet/Judge) - Testing, code review with scoring
- **ui-ux-designer.md** - UI/UX Designer "Taylor" (Sonnet/Worker) - Design, accessibility
- **devops-engineer.md** - DevOps Engineer "Casey" (Sonnet/Worker) - CI/CD, containers, infrastructure
- **security-specialist.md** - Security Specialist "Avery" (Opus/Judge) - Security audits, OWASP
- **dba.md** - Database Administrator "Drew" (Sonnet/Worker) - Schema, migrations, optimization

## Agent Tiers

### Planner (Opus/Claude)
- PM: Requirements and product strategy
- PL: Architecture and technical leadership

### Worker (Sonnet/Claude)
- FE Dev: Frontend implementation
- BE Dev: Backend implementation
- UI/UX Designer: Design artifacts
- DevOps: Infrastructure and deployment
- DBA: Database design and optimization

### Judge (Sonnet+/Mixed)
- QA Engineer: Code review with 5-dimension scoring (Sonnet/Claude, optionally Codex)
- Security Specialist: Security gate enforcement (Opus/Claude, optionally Codex)

## Quality Gates

All workers must pass review before marking tasks `done`:

### QA Review (5 dimensions, weighted)
- Correctness (2x weight)
- Security (2x weight)
- Performance (1x weight)
- Maintainability (1x weight)
- Test Coverage (1x weight)

**Pass criteria**: Overall >= 7.0, all dimensions >= 3.0

### Security Review (severity-based)
- Critical/High: Must fix before production
- Medium: Fix or document risk acceptance
- Low: Fix in next sprint

## Communication Protocol

All agents use `SendMessage` tool for team communication:
- Direct messages to specific teammates
- Broadcast (use sparingly, expensive)
- Shutdown requests/responses
- Plan approval (for plan_mode agents)

## Artifact Storage

All outputs saved to: `.omc/artifacts/{sprint-id}/{task-id}/`

Common artifact types:
- Plans, designs, mockups
- Code patches (git diff)
- Review reports (JSON)
- Test results
- Build/deployment logs

## Usage

These markdown files serve as persona prompts for the Claude Team agent system. Each agent receives:
1. Shared preamble (team protocol)
2. Role-specific definition (responsibilities, tools, constraints)
3. Task assignment from PM/PL

Agents coordinate autonomously via SendMessage to complete sprint work.
