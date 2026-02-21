# Claude Team - Quality Gate Review Skill

Trigger quality gate reviews for tasks ready for verification.

## Usage

```
/ct-review <task-id>
/ct-review <task-id> --type security
/ct-review status
```

### Commands

- **<task-id>** - Run quality gate review on a task
- **--type** - Specify review type: code, qa, security, design, pl-approval
- **status** - Show quality gate status for all tasks

### Examples

```bash
/ct-review task-1                    # Full code review
/ct-review task-1 --type security    # Security-focused review
/ct-review status                    # Show all gate results
```

## Review Process

1. Collect changed files and diff for the task
2. Route to appropriate reviewer role (QA, Security, PL)
3. Build review prompt with role-specific focus areas
4. Execute review via Codex (one-shot analysis)
5. Parse scored response (5 dimensions, 1-10 each)
6. Record result and determine verdict

## Scoring Dimensions

| Dimension | Description |
|-----------|-------------|
| Correctness | Logic, behavior, edge cases |
| Security | Vulnerabilities, auth, injection |
| Performance | Efficiency, scalability, memory |
| Maintainability | Readability, patterns, complexity |
| Test Coverage | Test completeness, quality |

## Verdicts

- **PASS** (>= 7.0, all dims >= 3): Task moves to Done
- **CONDITIONAL** (5.0-6.9): Re-review with opus model
- **REJECT** (3.0-4.9): Return to worker with feedback
- **AUTO-REJECT** (< 3.0): Escalate to PL

## Escalation

After 3 failed attempts, PL decides:
- **Retry**: Allow one more attempt
- **Split**: Break task into smaller pieces
- **Redesign**: Escalate to PM for scope change
- **Accept**: Accept with documented risk

## MCP Tool Integration

The review skill uses three MCP tools in sequence to process each review:

### Review Scoring Pipeline

```
ct_score_review  ->  ct_aggregate_reviews  ->  ct_gate_verdict
```

### Step 1: Parse Reviewer Response

After Codex returns a raw review, parse it into structured scores:

```
ct_score_review({
  response: '{"correctness":8,"security":6,"performance":7,"maintainability":8,"testCoverage":4,"feedback":"Missing unit tests for auth controller."}'
})
-> {
  dimensions: { correctness: 8, security: 6, performance: 7, maintainability: 8, testCoverage: 4 },
  feedback: "Missing unit tests for auth controller.",
  score: 6.6,
  verdict: "conditional"
}
```

The parser handles raw JSON, markdown-wrapped JSON (```json ... ```), and malformed responses gracefully.

### Step 2: Aggregate Multiple Reviewers

When multiple reviewers score the same task, aggregate with role-based weighting:

```
ct_aggregate_reviews({
  reviews: [
    {
      reviewerRole: "qa-engineer",
      dimensions: { correctness: 8, security: 6, performance: 7, maintainability: 8, testCoverage: 4 }
    },
    {
      reviewerRole: "security-specialist",
      dimensions: { correctness: 7, security: 5, performance: 7, maintainability: 7, testCoverage: 5 }
    }
  ]
})
-> {
  dimensions: { correctness: 7.5, security: 5.5, performance: 7, maintainability: 7.5, testCoverage: 4.5 },
  score: 6.4,
  verdict: "conditional"
}
```

Weighting: Security Specialist 1.5x, QA Engineer 1.3x, PL 1.2x, others 1.0x.

### Step 3: Determine Verdict

Get the final verdict with attempt tracking:

```
ct_gate_verdict({ score: 6.4, dimensions: { ... }, attempt: 1 })
-> {
  verdict: "conditional",
  action: "Re-review with higher-tier model (opus)",
  attempt: 1,
  maxAttempts: 3,
  exhausted: false,
  escalationNeeded: false
}
```

On subsequent attempts:

```
ct_gate_verdict({ score: 7.8, dimensions: { ... }, attempt: 2 })
-> { verdict: "pass", action: "Move task to Done", exhausted: false }
```

If max attempts reached without passing:

```
ct_gate_verdict({ score: 4.2, dimensions: { ... }, attempt: 3 })
-> {
  verdict: "reject",
  action: "Return to In-Progress with feedback",
  exhausted: true,
  escalationNeeded: true
}
```

### Checking Quality Summary

```
# All tasks
ct_quality_summary({ cwd: "/path/to/project" })
-> Passed: 2, Failed: 1, Pending: 1, Last Score: 7.8/10

# Specific task
ct_quality_summary({ cwd: "/path/to/project", taskId: "task-1" })
```
