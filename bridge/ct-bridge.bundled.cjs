#!/usr/bin/env node
"use strict";

// bridge/ct-bridge.cjs
var { Server } = require("@modelcontextprotocol/sdk/server/index.js");
var { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
var {
  CallToolRequestSchema,
  ListToolsRequestSchema
} = require("@modelcontextprotocol/sdk/types.js");
var { readFileSync, existsSync } = require("fs");
var { join, resolve } = require("path");
var SERVER_NAME = "claude-team";
var SERVER_VERSION = "0.1.0";
function validateCwd(cwd) {
  if (!cwd || typeof cwd !== "string") {
    throw new Error("cwd is required and must be a non-empty string");
  }
  if (cwd.includes("\0")) {
    throw new Error("cwd contains null bytes");
  }
  if (cwd.length > 4096) {
    throw new Error("cwd path exceeds maximum length (4096)");
  }
  const resolved = resolve(cwd);
  if (resolved.includes("..")) {
    throw new Error("cwd must not contain path traversal sequences");
  }
  const processCwd = resolve(process.cwd());
  if (resolved !== processCwd && !resolved.startsWith(processCwd + "/")) {
    throw new Error(`cwd must be under the current working directory: ${processCwd}`);
  }
  const sensitive = ["/etc", "/usr", "/bin", "/sbin", "/root", "/proc", "/sys", "/dev"];
  const sensitivePrefixes = ["/var/log", "/var/run", "/var/lib"];
  for (const s of sensitive) {
    if (resolved === s || resolved.startsWith(s + "/")) {
      throw new Error(`cwd must not point to system directory: ${s}`);
    }
  }
  for (const s of sensitivePrefixes) {
    if (resolved === s || resolved.startsWith(s + "/")) {
      throw new Error(`cwd must not point to system directory: ${s}`);
    }
  }
  return resolved;
}
function validateString(value, name, maxLen = 1e4) {
  if (value !== void 0 && value !== null) {
    if (typeof value !== "string") throw new Error(`${name} must be a string`);
    if (value.length > maxLen) throw new Error(`${name} exceeds maximum length (${maxLen})`);
  }
}
function validateNumber(value, name, min = -Infinity, max = Infinity) {
  if (value !== void 0 && value !== null) {
    if (typeof value !== "number" || !isFinite(value)) throw new Error(`${name} must be a finite number`);
    if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  }
}
var _ct = null;
async function loadModules() {
  if (_ct) return _ct;
  const distPath = resolve(__dirname, "..", "dist", "index.js");
  try {
    _ct = await import(distPath);
  } catch (e) {
    throw new Error(`Compiled modules not found at ${distPath}. Run \`npm run build\` first. (${e.message})`);
  }
  return _ct;
}
function ok(text) {
  return { content: [{ type: "text", text }] };
}
function err(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}
var TOOLS = [
  // --- State readers ---
  {
    name: "ct_team_status",
    description: "Get current Claude Team pipeline status (phase, roles, execution progress).",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string", description: "Project working directory" } },
      required: ["cwd"]
    }
  },
  {
    name: "ct_kanban_board",
    description: "Get kanban board view showing task counts by status column.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project working directory" },
        projectId: { type: "string", description: "Project ID" }
      },
      required: ["cwd", "projectId"]
    }
  },
  {
    name: "ct_quality_summary",
    description: "Get quality gate summary for a task or all tasks.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project working directory" },
        taskId: { type: "string", description: "Optional task ID. Omit for all tasks." }
      },
      required: ["cwd"]
    }
  },
  {
    name: "ct_role_info",
    description: "Get role assignments and team configuration.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string", description: "Project working directory" } },
      required: ["cwd"]
    }
  },
  {
    name: "ct_sprint_status",
    description: "Get current sprint status and velocity metrics.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project working directory" },
        projectId: { type: "string", description: "Project ID" }
      },
      required: ["cwd", "projectId"]
    }
  },
  // --- Logic tools ---
  {
    name: "ct_analyze_complexity",
    description: "Analyze task complexity from description or explicit factors. Returns complexity level (tiny/small/medium/large), score (0-1), and recommended agent count.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Task description to estimate from" },
        factors: {
          type: "object",
          description: "Explicit factors (overrides description-based estimation)",
          properties: {
            fileCount: { type: "number" },
            crossModuleDeps: { type: "number" },
            hasTests: { type: "boolean" },
            hasApiChanges: { type: "boolean" },
            hasDbChanges: { type: "boolean" },
            hasSecurityImplications: { type: "boolean" }
          }
        }
      },
      required: ["description"]
    }
  },
  {
    name: "ct_select_roles",
    description: "Select and merge roles based on complexity. Returns role assignments with personas, providers, and merge configuration.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["tiny", "small", "medium", "large"], description: "Complexity level" },
        score: { type: "number", description: "Complexity score (0-1)" }
      },
      required: ["level", "score"]
    }
  },
  {
    name: "ct_build_dag",
    description: "Build a DAG execution plan from task specifications. Returns layers with topologically sorted nodes.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID" },
        tasks: {
          type: "array",
          description: "Task specs: [{id, title, description, assignedRole, nodeType, priority, dependencies[], filePatterns[]}]",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              description: { type: "string", description: "Task description" },
              assignedRole: { type: "string" },
              nodeType: { type: "string", enum: ["planning", "design", "execution", "verification", "deployment"] },
              priority: { type: "number", description: "Task priority (1=highest, 5=lowest)", default: 1 },
              dependencies: { type: "array", items: { type: "string" } },
              filePatterns: { type: "array", items: { type: "string" } }
            },
            required: ["id", "title", "assignedRole", "nodeType"]
          }
        }
      },
      required: ["projectId", "tasks"]
    }
  },
  {
    name: "ct_validate_transition",
    description: "Validate a kanban state transition. Returns whether the transition is allowed and the reason if not.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID for the transition" },
        fromStatus: { type: "string", enum: ["backlog", "todo", "in-progress", "review", "done", "blocked", "failed"] },
        toStatus: { type: "string", enum: ["backlog", "todo", "in-progress", "review", "done", "blocked", "failed"] },
        movedBy: { type: "string", description: "Role attempting the transition (e.g. pm, pl, fe-dev, qa-engineer)" },
        reason: { type: "string", description: "Reason for the transition" },
        gateVerdict: { type: "string", enum: ["pass", "conditional", "reject", "auto-reject"], description: "Quality gate verdict (required for review \u2192 done)" }
      },
      required: ["taskId", "fromStatus", "toStatus", "movedBy", "reason"]
    }
  },
  {
    name: "ct_score_review",
    description: "Parse a Codex/LLM review response into structured scores. Handles raw JSON, markdown-wrapped JSON, and malformed responses.",
    inputSchema: {
      type: "object",
      properties: {
        response: { type: "string", description: "Raw review response text from Codex/LLM" }
      },
      required: ["response"]
    }
  },
  {
    name: "ct_aggregate_reviews",
    description: "Aggregate multiple reviewer scores with role-based weighting (Security 1.5x, QA 1.3x, PL 1.2x).",
    inputSchema: {
      type: "object",
      properties: {
        reviews: {
          type: "array",
          description: "Array of reviews: [{reviewerRole, dimensions: {correctness, security, performance, maintainability, testCoverage}}]",
          items: {
            type: "object",
            properties: {
              reviewerRole: { type: "string" },
              dimensions: {
                type: "object",
                properties: {
                  correctness: { type: "number" },
                  security: { type: "number" },
                  performance: { type: "number" },
                  maintainability: { type: "number" },
                  testCoverage: { type: "number" }
                }
              }
            },
            required: ["reviewerRole", "dimensions"]
          }
        }
      },
      required: ["reviews"]
    }
  },
  {
    name: "ct_gate_verdict",
    description: "Determine quality gate verdict from a score. Returns pass/conditional/reject/auto-reject with action.",
    inputSchema: {
      type: "object",
      properties: {
        score: { type: "number", description: "Overall score (1-10)" },
        dimensions: {
          type: "object",
          description: "Individual dimension scores",
          properties: {
            correctness: { type: "number" },
            security: { type: "number" },
            performance: { type: "number" },
            maintainability: { type: "number" },
            testCoverage: { type: "number" }
          }
        },
        attempt: { type: "number", description: "Current review attempt (1-3)" }
      },
      required: ["score", "dimensions"]
    }
  },
  // --- State writers ---
  {
    name: "ct_init_pipeline",
    description: "Initialize a new pipeline state. Creates the ct-pipeline-state.json file that all state readers depend on.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project working directory" },
        sessionId: { type: "string", description: "Unique session identifier" }
      },
      required: ["cwd", "sessionId"]
    }
  },
  {
    name: "ct_update_state",
    description: "Update pipeline state fields (kanban counts, execution progress, quality gates, roles, complexity).",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project working directory" },
        kanban: { type: "object", description: "Kanban count updates: {backlog, todo, inProgress, review, done, blocked, failed}" },
        execution: { type: "object", description: "Execution updates: {workersTotal, workersActive, tasksTotal, tasksCompleted, tasksFailed}" },
        qualityGates: { type: "object", description: "Quality gate updates: {passed, failed, pending, lastScore}" },
        roles: { type: "array", description: "Role assignment array" },
        complexity: { type: "object", description: "Complexity score object" }
      },
      required: ["cwd"]
    }
  },
  {
    name: "ct_transition_phase",
    description: "Transition the pipeline to a new phase. Validates the transition is allowed.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project working directory" },
        toPhase: { type: "string", enum: ["team-plan", "team-prd", "team-exec", "team-verify", "team-fix", "complete", "failed", "cancelled"], description: "Target phase" },
        reason: { type: "string", description: "Reason for transition" }
      },
      required: ["cwd", "toPhase"]
    }
  },
  {
    name: "ct_get_agent_prompt",
    description: "Get the full agent prompt for a role (shared preamble + role-specific content). Use to surface role personas at runtime.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["pm", "pl", "fe-dev", "be-dev", "qa-engineer", "ui-ux-designer", "devops-engineer", "security-specialist", "dba"], description: "Role name" },
        includeSharedPreamble: { type: "boolean", description: "Whether to include the shared team preamble (default: true)" }
      },
      required: ["role"]
    }
  },
  {
    name: "ct_decompose_task",
    description: "Decompose a high-level task into role-assigned subtasks with DAG dependencies. Returns subtasks with role assignments, file ownership, and dependency graph.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "High-level task description to decompose" },
        complexityLevel: { type: "string", enum: ["tiny", "small", "medium", "large"], description: "Complexity level (or use ct_analyze_complexity first)" },
        complexityScore: { type: "number", description: "Complexity score 0-1" },
        availableRoles: { type: "array", items: { type: "string" }, description: "Available roles (defaults to all 9)" },
        fileContext: { type: "array", items: { type: "string" }, description: "File paths involved in the task" }
      },
      required: ["description", "complexityLevel", "complexityScore"]
    }
  },
  {
    name: "ct_escalation_decision",
    description: "Determine escalation action for a quality gate failure. Returns retry/upgrade/escalate decision with guidance.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project working directory" },
        taskId: { type: "string", description: "Task ID that failed the gate" },
        gateType: { type: "string", enum: ["design-review", "code-review", "qa-review", "security-review", "pl-approval"], description: "Type of quality gate" },
        reviewerRole: { type: "string", description: "Role that performed the review" },
        score: { type: "number", description: "Review score (0-10)" },
        verdict: { type: "string", enum: ["pass", "conditional", "reject", "auto-reject"], description: "Gate verdict" },
        feedback: { type: "string", description: "Review feedback text" },
        dimensions: { type: "object", description: "Score dimensions {correctness, security, performance, maintainability, testCoverage}" }
      },
      required: ["cwd", "taskId", "gateType", "reviewerRole", "score", "verdict", "feedback", "dimensions"]
    }
  },
  {
    name: "ct_list_roles",
    description: "List all 9 role definitions with capabilities, merge targets, provider/model, and DAG layer. Useful for planning before pipeline initialization.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  // --- Orchestration tools ---
  {
    name: "ct_build_team",
    description: "Build team configuration from complexity analysis. Returns optimized team with merged roles (1-4 agents), role assignments, and spawn configurations.",
    inputSchema: {
      type: "object",
      properties: {
        teamName: { type: "string", description: "Team name/identifier" },
        complexity: {
          type: "object",
          description: "Complexity score object from ct_analyze_complexity",
          properties: {
            level: { type: "string", enum: ["tiny", "small", "medium", "large"] },
            score: { type: "number" },
            factors: { type: "object" },
            recommendedAgentCount: { type: "number" }
          },
          required: ["level", "score"]
        },
        fileAssignments: {
          type: "object",
          description: "Optional file ownership map: { role: [file patterns] }"
        },
        sprintId: { type: "string", description: "Optional sprint ID" }
      },
      required: ["teamName", "complexity"]
    }
  },
  {
    name: "ct_register_team",
    description: "Register team configuration for spawning. Converts TeamConfiguration into spawn configs (Claude Task tool or MCP). Returns registration with spawn configurations.",
    inputSchema: {
      type: "object",
      properties: {
        teamName: { type: "string", description: "Team name/identifier" },
        description: { type: "string", description: "Team description" },
        teamConfig: {
          type: "object",
          description: "Team configuration from ct_build_team (pass as JSON string in members field)",
          properties: {
            members: { type: "string", description: "JSON stringified team members array" },
            totalAgents: { type: "number" }
          },
          required: ["members"]
        },
        workingDirectory: { type: "string", description: "Working directory for the team" }
      },
      required: ["teamName", "description", "teamConfig", "workingDirectory"]
    }
  },
  {
    name: "ct_get_plan_status",
    description: "Get DAG execution plan status. Returns node statuses, layer progress, and completion state from persisted plan.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project working directory" },
        planId: { type: "string", description: "Execution plan ID" }
      },
      required: ["cwd", "planId"]
    }
  },
  {
    name: "ct_run_pwj_cycle",
    description: "Create PWJ (Planner-Worker-Judge) controller for plan-execute-judge-rework lifecycle. Returns initial controller state. NOTE: Actual execution requires phase callbacks - this initializes the controller.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Project working directory" },
        projectId: { type: "string", description: "Project ID" },
        complexity: {
          type: "object",
          description: "Complexity score object",
          properties: {
            level: { type: "string", enum: ["tiny", "small", "medium", "large"] },
            score: { type: "number" },
            factors: { type: "object" },
            recommendedAgentCount: { type: "number" }
          },
          required: ["level", "score"]
        },
        taskSpecs: {
          type: "array",
          description: "Task specifications array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              assignedRole: { type: "string" },
              nodeType: { type: "string" },
              dependencies: { type: "array", items: { type: "string" } }
            },
            required: ["id", "title", "assignedRole", "nodeType"]
          }
        },
        maxReworkCycles: { type: "number", description: "Maximum rework cycles (default: 3)" }
      },
      required: ["cwd", "projectId", "complexity", "taskSpecs"]
    }
  }
];
async function readState(cwd) {
  const safeCwd = validateCwd(cwd);
  let ct;
  try {
    ct = await loadModules();
  } catch {
    const statePath = join(safeCwd, ".omc", "state", "ct-pipeline-state.json");
    if (!existsSync(statePath)) return null;
    try {
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      if (!state || typeof state !== "object") return null;
      if (typeof state.phase !== "string" || typeof state.active !== "boolean") return null;
      return state;
    } catch {
      return null;
    }
  }
  return ct.loadPipelineState(safeCwd);
}
async function handleTeamStatus(args) {
  const state = await readState(args.cwd);
  if (!state) return ok("No active Claude Team pipeline.");
  const summary = [
    `Phase: ${state.phase} (${state.active ? "active" : "inactive"})`,
    `Iteration: ${state.iteration}/${state.maxIterations}`,
    `Workers: ${state.execution?.workersActive ?? 0}/${state.execution?.workersTotal ?? 0}`,
    `Tasks: ${state.execution?.tasksCompleted ?? 0}/${state.execution?.tasksTotal ?? 0} completed`,
    `Kanban: ${state.kanban?.inProgress ?? 0} in-progress, ${state.kanban?.review ?? 0} review, ${state.kanban?.done ?? 0} done`,
    `Quality Gates: ${state.qualityGates?.passed ?? 0} passed, ${state.qualityGates?.failed ?? 0} failed`,
    state.fixLoop?.attempt > 0 ? `Fix Loop: ${state.fixLoop.attempt}/${state.fixLoop.maxAttempts}` : "",
    `Roles: ${(state.roles || []).map((r) => `${r.role}(${r.personaName})`).join(", ")}`
  ].filter(Boolean).join("\n");
  return ok(summary);
}
async function handleKanbanBoard(args) {
  const state = await readState(args.cwd);
  if (!state) return ok("No active pipeline. Run /ct-setup first.");
  const k = state.kanban || {};
  const board = [
    "| Backlog | Todo | In-Progress | Review | Done | Blocked | Failed |",
    "|---------|------|-------------|--------|------|---------|--------|",
    `| ${k.backlog || 0} | ${k.todo || 0} | ${k.inProgress || 0} | ${k.review || 0} | ${k.done || 0} | ${k.blocked || 0} | ${k.failed || 0} |`
  ].join("\n");
  return ok(board);
}
async function handleQualitySummary(args) {
  const state = await readState(args.cwd);
  if (!state) return ok("No active pipeline.");
  const qg = state.qualityGates || {};
  const summary = [
    "Quality Gates Summary:",
    `  Passed: ${qg.passed || 0}`,
    `  Failed: ${qg.failed || 0}`,
    `  Pending: ${qg.pending || 0}`,
    qg.lastScore ? `  Last Score: ${qg.lastScore.toFixed(1)}/10` : ""
  ].filter(Boolean).join("\n");
  return ok(summary);
}
async function handleRoleInfo(args) {
  const state = await readState(args.cwd);
  if (!state) return ok("No active pipeline. Available roles: PM, PL, FE Dev, BE Dev, QA, UI/UX Designer, DevOps, Security, DBA");
  const roles = (state.roles || []).map((r) => {
    const merged = r.mergedRoles?.length > 0 ? ` (+${r.mergedRoles.join(", ")})` : "";
    return `  ${r.role}${merged}: ${r.personaName} [${r.provider}/${r.model}] - ${r.status}`;
  });
  const summary = [
    `Team Roles (${roles.length} active):`,
    ...roles,
    "",
    `Complexity: ${state.complexityScore?.level || "unknown"} (${state.complexityScore?.score?.toFixed(2) || "?"})`
  ].join("\n");
  return ok(summary);
}
async function handleSprintStatus(args) {
  const state = await readState(args.cwd);
  if (!state) return ok("No active pipeline.");
  const exec = state.execution || {};
  const qg = state.qualityGates || {};
  const totalTasks = exec.tasksTotal || 0;
  const completedTasks = exec.tasksCompleted || 0;
  const avgScore = qg.lastScore || 0;
  const velocity = totalTasks > 0 ? (completedTasks / totalTasks * (avgScore / 10) * 100).toFixed(1) : "0.0";
  return ok([
    `Sprint Progress: ${completedTasks}/${totalTasks} tasks completed`,
    `Velocity: ${velocity}%`,
    `Quality: ${qg.passed || 0} passed, ${qg.failed || 0} failed`,
    `Phase: ${state.phase}`
  ].join("\n"));
}
async function handleInitPipeline(args) {
  validateString(args.sessionId, "sessionId", 200);
  if (!args.sessionId) return err("sessionId is required");
  const safeCwd = validateCwd(args.cwd);
  const ct = await loadModules();
  const existing = ct.loadPipelineState(safeCwd);
  if (existing && existing.active) {
    return ok(JSON.stringify({ status: "already_active", phase: existing.phase, sessionId: existing.sessionId }));
  }
  const state = ct.createPipelineState(safeCwd, args.sessionId, safeCwd);
  return ok(JSON.stringify({ status: "initialized", phase: state.phase, sessionId: args.sessionId }));
}
async function handleUpdateState(args) {
  const safeCwd = validateCwd(args.cwd);
  const ct = await loadModules();
  return ct.withStateLock(safeCwd, () => {
    const state = ct.loadPipelineState(safeCwd);
    if (!state) return err("No active pipeline. Run ct_init_pipeline first.");
    const updated = [];
    if (args.kanban && typeof args.kanban === "object") {
      const validKeys = ["backlog", "todo", "inProgress", "review", "done", "blocked", "failed"];
      for (const [k, v] of Object.entries(args.kanban)) {
        if (validKeys.includes(k) && typeof v === "number" && isFinite(v)) {
          state.kanban[k] = v;
          updated.push(`kanban.${k}`);
        }
      }
    }
    if (args.execution && typeof args.execution === "object") {
      const validKeys = ["workersTotal", "workersActive", "tasksTotal", "tasksCompleted", "tasksFailed"];
      for (const [k, v] of Object.entries(args.execution)) {
        if (validKeys.includes(k) && typeof v === "number" && isFinite(v)) {
          state.execution[k] = v;
          updated.push(`execution.${k}`);
        }
      }
    }
    if (args.qualityGates && typeof args.qualityGates === "object") {
      const numericKeys = ["passed", "failed", "pending"];
      for (const [k, v] of Object.entries(args.qualityGates)) {
        if (numericKeys.includes(k) && typeof v === "number" && isFinite(v)) {
          state.qualityGates[k] = v;
          updated.push(`qualityGates.${k}`);
        } else if (k === "lastScore" && (typeof v === "number" && isFinite(v) || v === null)) {
          state.qualityGates[k] = v;
          updated.push(`qualityGates.${k}`);
        }
      }
    }
    if (Array.isArray(args.roles)) {
      const roleAllowedKeys = ["role", "personaName", "provider", "model", "mergedRoles", "status", "roleId", "agentName", "isMergedInto"];
      const validRoles = args.roles.filter((r) => r && typeof r === "object" && typeof r.role === "string").map((r) => {
        const clean = {};
        for (const [k, v] of Object.entries(r)) {
          if (roleAllowedKeys.includes(k)) clean[k] = v;
        }
        return clean;
      });
      state.roles = validRoles;
      updated.push("roles");
    }
    if (args.complexity && typeof args.complexity === "object") {
      const complexityAllowedKeys = ["level", "score", "factors", "recommendedAgentCount"];
      const filtered = {};
      for (const [k, v] of Object.entries(args.complexity)) {
        if (complexityAllowedKeys.includes(k)) filtered[k] = v;
      }
      if (Object.keys(filtered).length > 0) {
        state.complexityScore = filtered;
      }
      updated.push("complexityScore");
    }
    if (updated.length > 0) {
      try {
        ct.saveState(safeCwd, state);
      } catch (saveErr) {
        return err(`State save failed after updating [${updated.join(", ")}]: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`);
      }
    }
    return ok(JSON.stringify({ status: "updated", fields: updated }));
  });
}
async function handleTransitionPhase(args) {
  const validPhases = ["team-plan", "team-prd", "team-exec", "team-verify", "team-fix", "complete", "failed", "cancelled"];
  if (!validPhases.includes(args.toPhase)) return err(`toPhase must be one of: ${validPhases.join(", ")}`);
  const safeCwd = validateCwd(args.cwd);
  const ct = await loadModules();
  const result = ct.transitionPhase(safeCwd, args.toPhase, args.reason);
  if (!result.ok) {
    return ok(JSON.stringify({
      status: result.state ? "rejected" : "error",
      reason: result.reason,
      currentPhase: result.state?.phase || null
    }));
  }
  const history = result.state.phaseHistory;
  const fromPhase = history.length >= 2 ? history[history.length - 2]?.phase : null;
  return ok(JSON.stringify({ status: "transitioned", fromPhase, toPhase: args.toPhase }));
}
async function handleAnalyzeComplexity(args) {
  validateString(args.description, "description");
  if (!args.description) return err("description is required");
  const ct = await loadModules();
  if (args.factors) {
    const result2 = ct.analyzeComplexity({
      description: args.description,
      ...args.factors
    });
    return ok(JSON.stringify(result2, null, 2));
  }
  const result = ct.estimateFromDescription(args.description);
  return ok(JSON.stringify(result, null, 2));
}
async function handleSelectRoles(args) {
  const validLevels = ["tiny", "small", "medium", "large"];
  if (!validLevels.includes(args.level)) return err(`level must be one of: ${validLevels.join(", ")}`);
  validateNumber(args.score, "score", 0, 1);
  const ct = await loadModules();
  const complexity = {
    level: args.level,
    score: args.score,
    factors: { fileCount: 0, crossModuleDeps: 0, hasTests: false, hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false },
    recommendedAgentCount: ct.COMPLEXITY_THRESHOLDS[args.level]?.agentCount ?? 3
  };
  const roles = ct.selectRoles(complexity);
  const mergeConfig = ct.MERGE_CONFIGURATIONS[args.level];
  const output = {
    agentCount: mergeConfig.agentCount,
    roles: roles.map((r) => ({
      role: r.role,
      personaName: r.personaName,
      provider: r.provider,
      model: r.model,
      mergedRoles: r.mergedRoles,
      status: r.status
    })),
    providerDistribution: {
      claude: roles.filter((r) => r.provider === "claude").map((r) => r.role),
      codex: roles.filter((r) => r.provider === "codex").map((r) => r.role)
    }
  };
  return ok(JSON.stringify(output, null, 2));
}
async function handleBuildDag(args) {
  validateString(args.projectId, "projectId", 200);
  if (!args.projectId) return err("projectId is required");
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) return err("tasks must be a non-empty array");
  const ct = await loadModules();
  const taskSpecs = args.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description || "",
    assignedRole: t.assignedRole,
    nodeType: t.nodeType,
    priority: t.priority || 1,
    dependencies: t.dependencies || [],
    filePatterns: t.filePatterns || []
  }));
  const plan = ct.buildExecutionPlan(args.projectId, taskSpecs);
  const layers = plan.layers.map((layer) => ({
    layer: layer.index,
    nodeType: layer.nodeType,
    gateType: layer.gateType || null,
    nodes: layer.nodes.map((node) => ({
      id: node.id,
      title: node.taskId,
      role: node.roleId,
      type: node.nodeType,
      status: node.status
    }))
  }));
  return ok(JSON.stringify({ planId: plan.id, totalLayers: layers.length, layers }, null, 2));
}
async function handleValidateTransition(args) {
  const validStatuses = ["backlog", "todo", "in-progress", "review", "done", "blocked", "failed"];
  if (!validStatuses.includes(args.fromStatus)) return err(`fromStatus must be one of: ${validStatuses.join(", ")}`);
  if (!validStatuses.includes(args.toStatus)) return err(`toStatus must be one of: ${validStatuses.join(", ")}`);
  validateString(args.taskId, "taskId", 200);
  validateString(args.movedBy, "movedBy", 50);
  validateString(args.reason, "reason", 2e3);
  const ct = await loadModules();
  const validStates = ct.getValidNextStates(args.fromStatus);
  const fullValidation = ct.validateTransition({
    taskId: args.taskId,
    fromStatus: args.fromStatus,
    toStatus: args.toStatus,
    movedBy: args.movedBy,
    reason: args.reason,
    gateVerdict: args.gateVerdict || void 0
  });
  return ok(JSON.stringify({
    valid: fullValidation.allowed,
    reason: fullValidation.error || null,
    fromStatus: args.fromStatus,
    toStatus: args.toStatus,
    movedBy: args.movedBy,
    allowedTransitions: validStates
  }, null, 2));
}
async function handleScoreReview(args) {
  validateString(args.response, "response", 1e5);
  if (!args.response) return err("response is required");
  const ct = await loadModules();
  const result = ct.parseCodexResponse(args.response);
  return ok(JSON.stringify(result, null, 2));
}
async function handleAggregateReviews(args) {
  if (!Array.isArray(args.reviews) || args.reviews.length === 0) return err("reviews must be a non-empty array");
  const ct = await loadModules();
  const result = ct.aggregateScores(args.reviews);
  return ok(JSON.stringify(result, null, 2));
}
async function handleGateVerdict(args) {
  validateNumber(args.score, "score", 0, 10);
  if (args.score === void 0 || args.score === null) return err("score is required");
  if (!args.dimensions || typeof args.dimensions !== "object") return err("dimensions object is required");
  if (args.attempt !== void 0) validateNumber(args.attempt, "attempt", 1, 10);
  const ct = await loadModules();
  const verdict = ct.determineVerdict(args.score, args.dimensions);
  const attempt = args.attempt || 1;
  const exhausted = attempt >= ct.MAX_REVIEW_ATTEMPTS;
  const actions = {
    "pass": "Move task to Done",
    "conditional": "Re-review with higher-tier model (opus)",
    "reject": "Return to In-Progress with feedback",
    "auto-reject": "Escalate to PL for decision"
  };
  return ok(JSON.stringify({
    verdict,
    action: actions[verdict],
    score: args.score,
    attempt,
    maxAttempts: ct.MAX_REVIEW_ATTEMPTS,
    exhausted,
    escalationNeeded: exhausted && verdict !== "pass"
  }, null, 2));
}
async function handleGetAgentPrompt(args) {
  const validRoles = ["pm", "pl", "fe-dev", "be-dev", "qa-engineer", "ui-ux-designer", "devops-engineer", "security-specialist", "dba"];
  if (!validRoles.includes(args.role)) return err(`role must be one of: ${validRoles.join(", ")}`);
  const ct = await loadModules();
  const includePreamble = args.includeSharedPreamble !== false;
  const agent = ct.getAgent(args.role);
  if (!agent) return err(`Agent not found for role: ${args.role}`);
  if (includePreamble) {
    return ok(agent.prompt);
  }
  const rolePrompt = ct.loadAgentPrompt(args.role);
  return ok(rolePrompt);
}
async function handleDecomposeTask(args) {
  validateString(args.description, "description");
  if (!args.description) return err("description is required");
  const validLevels = ["tiny", "small", "medium", "large"];
  if (!validLevels.includes(args.complexityLevel)) return err(`complexityLevel must be one of: ${validLevels.join(", ")}`);
  validateNumber(args.complexityScore, "complexityScore", 0, 1);
  const ct = await loadModules();
  const allRoles = ["pm", "pl", "fe-dev", "be-dev", "qa-engineer", "ui-ux-designer", "devops-engineer", "security-specialist", "dba"];
  const availableRoles = Array.isArray(args.availableRoles) ? args.availableRoles.filter((r) => allRoles.includes(r)) : allRoles;
  const complexity = {
    level: args.complexityLevel,
    score: args.complexityScore,
    factors: { fileCount: 0, crossModuleDeps: 0, hasTests: false, hasApiChanges: false, hasDbChanges: false, hasSecurityImplications: false },
    recommendedAgentCount: ct.COMPLEXITY_THRESHOLDS[args.complexityLevel]?.agentCount ?? 3
  };
  const result = ct.decomposeTask({
    taskDescription: args.description,
    complexity,
    availableRoles,
    fileContext: args.fileContext || []
  });
  return ok(JSON.stringify({
    summary: result.summary,
    dagLayers: result.dagLayers,
    taskCount: result.tasks.length,
    tasks: result.tasks.map((t, i) => ({
      index: i,
      subject: t.subject,
      role: t.role,
      nodeType: t.nodeType,
      provider: t.provider,
      fileOwnership: t.fileOwnership,
      dependsOn: t.dependsOn,
      estimatedComplexity: t.estimatedComplexity
    })),
    taskSpecs: result.taskSpecs
  }, null, 2));
}
async function handleEscalationDecision(args) {
  const safeCwd = validateCwd(args.cwd);
  validateString(args.taskId, "taskId", 200);
  validateString(args.feedback, "feedback", 1e5);
  validateNumber(args.score, "score", 0, 10);
  const ct = await loadModules();
  const dbReady = await ct.initDb(safeCwd);
  if (!dbReady) {
    return err("Database initialization failed (better-sqlite3 not available). Escalation decisions require DB for gate history.");
  }
  const latestResult = {
    id: `gate-${Date.now()}`,
    gateType: args.gateType,
    reviewerRole: args.reviewerRole,
    taskId: args.taskId,
    score: args.score,
    dimensions: args.dimensions,
    verdict: args.verdict,
    feedback: args.feedback,
    attempt: 1,
    maxAttempts: ct.MAX_REVIEW_ATTEMPTS,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const decision = ct.determineEscalation(safeCwd, args.taskId, args.gateType, latestResult);
  return ok(JSON.stringify({
    action: decision.action,
    reason: decision.reason,
    targetRole: decision.targetRole,
    suggestedGuidance: decision.suggestedGuidance || null,
    context: {
      taskId: decision.context.taskId,
      gateType: decision.context.gateType,
      attempt: decision.context.attempt,
      lastVerdict: decision.context.lastVerdict,
      lastScore: decision.context.lastScore
    }
  }, null, 2));
}
async function handleListRoles() {
  const ct = await loadModules();
  const roles = Object.entries(ct.ROLE_DEFINITIONS).map(([key, def]) => ({
    role: key,
    persona: def.persona,
    model: def.model,
    provider: def.provider,
    dagLayer: def.dagLayer,
    mergeableWith: def.mergeableWith,
    description: def.description,
    capabilities: def.capabilities
  }));
  return ok(JSON.stringify({ totalRoles: roles.length, roles }, null, 2));
}
async function handleBuildTeam(args) {
  validateString(args.teamName, "teamName", 200);
  if (!args.teamName) return err("teamName is required");
  if (!args.complexity || typeof args.complexity !== "object") return err("complexity object is required");
  const validLevels = ["tiny", "small", "medium", "large"];
  if (!validLevels.includes(args.complexity.level)) return err(`complexity.level must be one of: ${validLevels.join(", ")}`);
  validateNumber(args.complexity.score, "complexity.score", 0, 1);
  const ct = await loadModules();
  const buildInput = {
    teamName: args.teamName,
    complexity: args.complexity,
    fileAssignments: args.fileAssignments || {},
    sprintId: args.sprintId
  };
  const teamConfig = ct.buildTeam(buildInput);
  return ok(JSON.stringify({
    totalAgents: teamConfig.totalAgents,
    mergeLog: teamConfig.mergeLog,
    members: teamConfig.members.map((m) => ({
      name: m.name,
      role: m.role,
      mergedRoles: m.mergedRoles,
      provider: m.provider,
      model: m.model,
      dagLayer: m.dagLayer,
      status: m.status,
      fileOwnership: m.fileOwnership
    })),
    layers: {
      planners: teamConfig.layers.planners.map((m) => m.name),
      workers: teamConfig.layers.workers.map((m) => m.name),
      judges: teamConfig.layers.judges.map((m) => m.name)
    }
  }, null, 2));
}
async function handleRegisterTeam(args) {
  validateString(args.teamName, "teamName", 200);
  validateString(args.description, "description", 1e3);
  validateString(args.workingDirectory, "workingDirectory", 4096);
  if (!args.teamName) return err("teamName is required");
  if (!args.description) return err("description is required");
  if (!args.workingDirectory) return err("workingDirectory is required");
  if (!args.teamConfig || typeof args.teamConfig !== "object") return err("teamConfig object is required");
  const ct = await loadModules();
  let members;
  if (typeof args.teamConfig.members === "string") {
    try {
      members = JSON.parse(args.teamConfig.members);
    } catch (e) {
      return err("teamConfig.members must be valid JSON string");
    }
  } else if (Array.isArray(args.teamConfig.members)) {
    members = args.teamConfig.members;
  } else {
    return err("teamConfig.members is required");
  }
  function deriveLayersFromMembers(mems) {
    const planners = mems.filter((m) => m.dagLayer === "planner");
    const judges = mems.filter((m) => m.dagLayer === "judge");
    const workers = mems.filter((m) => m.dagLayer === "worker" || !m.dagLayer && !planners.includes(m) && !judges.includes(m));
    return { planners, workers, judges };
  }
  const teamConfig = {
    members,
    mergeLog: [],
    totalAgents: members.length,
    layers: args.teamConfig?.layers ?? deriveLayersFromMembers(members)
  };
  const registration = ct.registerTeam(
    args.teamName,
    args.description,
    teamConfig,
    args.workingDirectory
  );
  return ok(JSON.stringify({
    teamName: registration.teamName,
    description: registration.description,
    createdAt: registration.createdAt,
    members: registration.members.map((m) => ({
      name: m.name,
      role: m.role,
      agentType: m.agentType,
      provider: m.provider,
      model: m.model,
      spawnConfig: m.spawnConfig
    }))
  }, null, 2));
}
async function handleGetPlanStatus(args) {
  const safeCwd = validateCwd(args.cwd);
  validateString(args.planId, "planId", 200);
  if (!args.planId) return err("planId is required");
  const ct = await loadModules();
  const nodesMap = ct.loadPlanNodes(safeCwd, args.planId);
  if (!nodesMap) {
    return ok(JSON.stringify({ status: "not_found", message: "Plan not found or database unavailable" }));
  }
  const nodes = Array.from(nodesMap.values());
  const statusCounts = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    skipped: 0
  };
  const layerProgress = {};
  for (const node of nodes) {
    statusCounts[node.status] = (statusCounts[node.status] || 0) + 1;
    const layerKey = `layer-${node.layerIndex}`;
    if (!layerProgress[layerKey]) {
      layerProgress[layerKey] = { pending: 0, running: 0, completed: 0, failed: 0, skipped: 0 };
    }
    layerProgress[layerKey][node.status] = (layerProgress[layerKey][node.status] || 0) + 1;
  }
  const totalNodes = nodes.length;
  const completedNodes = statusCounts.completed || 0;
  const failedNodes = statusCounts.failed || 0;
  const isComplete = completedNodes + failedNodes + (statusCounts.skipped || 0) === totalNodes;
  return ok(JSON.stringify({
    planId: args.planId,
    totalNodes,
    statusCounts,
    layerProgress,
    isComplete,
    nodes: nodes.map((n) => ({
      id: n.id,
      roleId: n.roleId,
      layerIndex: n.layerIndex,
      nodeType: n.nodeType,
      status: n.status,
      taskId: n.taskId,
      startedAt: n.startedAt,
      completedAt: n.completedAt
    }))
  }, null, 2));
}
async function handleRunPwjCycle(args) {
  const safeCwd = validateCwd(args.cwd);
  validateString(args.projectId, "projectId", 200);
  if (!args.projectId) return err("projectId is required");
  if (!args.complexity || typeof args.complexity !== "object") return err("complexity object is required");
  if (!Array.isArray(args.taskSpecs) || args.taskSpecs.length === 0) return err("taskSpecs must be a non-empty array");
  const validLevels = ["tiny", "small", "medium", "large"];
  if (!validLevels.includes(args.complexity.level)) return err(`complexity.level must be one of: ${validLevels.join(", ")}`);
  const ct = await loadModules();
  const maxReworkCycles = args.maxReworkCycles || 3;
  const reworkCount = typeof args.reworkCount === "number" ? args.reworkCount : 0;
  const previousFeedback = args.previousFeedback || null;
  const roles = ct.selectRoles(args.complexity);
  const taskDescription = args.taskSpecs.map(
    (t, i) => `Task ${i + 1}: ${t.title || t.id}${t.description ? " - " + t.description : ""}`
  ).join("\n");
  const reworkPrefix = reworkCount > 0 && previousFeedback ? `This is rework cycle #${reworkCount}. Previous judgment feedback:
${previousFeedback}

Address all issues raised before proceeding.

` : "";
  function getPromptForRole(roleId) {
    const agent = ct.getAgent(roleId);
    return agent ? agent.prompt : `You are the ${roleId} agent. Follow team protocol and complete assigned tasks.`;
  }
  const plannerRoles = roles.filter((r) => r.dagLayer === "planner");
  const workerRoles = roles.filter((r) => r.dagLayer === "worker");
  const judgeRoles = roles.filter((r) => r.dagLayer === "judge");
  function providerMap(roleAssignments) {
    const map = {};
    for (const r of roleAssignments) {
      map[r.role] = r.provider;
    }
    return map;
  }
  function roleLabel(roleAssignments) {
    return roleAssignments.map((r) => r.role).join(", ");
  }
  const plannerRole = plannerRoles.length > 0 ? plannerRoles[0].role : "pm";
  const planningPrompt = `${reworkPrefix}${getPromptForRole(plannerRole)}

---

## Current Task

You are acting as the planning layer (${roleLabel(plannerRoles)}) for project: ${args.projectId}

### Tasks to plan:
${taskDescription}

### Your deliverable:
Create a structured execution plan with:
1. Task breakdown and dependencies
2. Priority ordering
3. Assignment of tasks to worker roles (${roleLabel(workerRoles)})
4. Definition of done for each task
5. Key risks and mitigations

Provide output as structured JSON or markdown that worker agents can directly act on.`;
  const workerRole = workerRoles.length > 0 ? workerRoles[0].role : "be-dev";
  const executionPrompt = `${reworkPrefix}${getPromptForRole(workerRole)}

---

## Current Task

You are acting as the execution layer (${roleLabel(workerRoles)}) for project: ${args.projectId}

### Tasks to implement:
${taskDescription}

### Instructions:
- Follow the plan produced by the planning phase
- Implement each task completely and correctly
- Document changes made (file paths, functions added/modified)
- Report completed task IDs and any blockers

Provide implementation artifacts and a summary of what was done.`;
  const judgeRole = judgeRoles.length > 0 ? judgeRoles[0].role : "qa-engineer";
  const judgmentPrompt = `${reworkPrefix}${getPromptForRole(judgeRole)}

---

## Current Task

You are acting as the judgment layer (${roleLabel(judgeRoles)}) for project: ${args.projectId}

### Implementation to review:
${taskDescription}

### Review criteria \u2014 score each 0-10:
- correctness: Does it meet all requirements?
- security: Are there vulnerabilities or unsafe patterns?
- performance: Is it efficient and scalable?
- maintainability: Is the code clean and well-documented?
- testCoverage: Are there sufficient tests?

### Output format (JSON):
{
  "scores": { "correctness": N, "security": N, "performance": N, "maintainability": N, "testCoverage": N },
  "overallScore": N,
  "feedback": ["issue 1", "issue 2"],
  "failedTaskIds": ["task-id-if-failed"],
  "verdict": "pass|conditional|reject|auto-reject"
}`;
  const planId = `plan-${args.projectId}-${Date.now()}`;
  return ok(JSON.stringify({
    status: "ready",
    planId,
    phases: {
      planning: {
        description: `${roleLabel(plannerRoles)} analyze requirements and create execution plan`,
        roles: plannerRoles.map((r) => r.role),
        providers: providerMap(plannerRoles),
        prompt: planningPrompt,
        expectedOutput: "Structured plan with task breakdown, priorities, and dependencies"
      },
      execution: {
        description: `${roleLabel(workerRoles)} implement the plan`,
        roles: workerRoles.map((r) => r.role),
        providers: providerMap(workerRoles),
        prompt: executionPrompt,
        expectedOutput: "Implementation artifacts with file changes and completion report"
      },
      judgment: {
        description: `${roleLabel(judgeRoles)} review the implementation`,
        roles: judgeRoles.map((r) => r.role),
        providers: providerMap(judgeRoles),
        prompt: judgmentPrompt,
        expectedOutput: "Structured review scores and feedback JSON"
      }
    },
    instructions: {
      step1: "Call the planning agents using phases.planning.prompt with each role listed in phases.planning.roles",
      step2: "Collect plan outputs, then call execution agents with phases.execution.prompt",
      step3: "After execution, call judgment agents with phases.judgment.prompt",
      step4: "Parse scores using ct_score_review, aggregate with ct_aggregate_reviews, get verdict via ct_gate_verdict",
      step5: `If verdict is 'reject' or 'auto-reject' and reworkCount < ${maxReworkCycles}, call ct_run_pwj_cycle again with reworkCount=${reworkCount + 1} and previousFeedback set to judgment feedback`
    },
    config: {
      projectId: args.projectId,
      maxReworkCycles,
      currentReworkCount: reworkCount,
      complexityLevel: args.complexity.level,
      taskCount: args.taskSpecs.length
    }
  }, null, 2));
}
async function main() {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        // State readers (async — delegate to compiled modules)
        case "ct_team_status":
          return await handleTeamStatus(args);
        case "ct_kanban_board":
          return await handleKanbanBoard(args);
        case "ct_quality_summary":
          return await handleQualitySummary(args);
        case "ct_role_info":
          return await handleRoleInfo(args);
        case "ct_sprint_status":
          return await handleSprintStatus(args);
        // Logic tools
        case "ct_analyze_complexity":
          return await handleAnalyzeComplexity(args);
        case "ct_select_roles":
          return await handleSelectRoles(args);
        case "ct_build_dag":
          return await handleBuildDag(args);
        case "ct_validate_transition":
          return await handleValidateTransition(args);
        case "ct_score_review":
          return await handleScoreReview(args);
        case "ct_aggregate_reviews":
          return await handleAggregateReviews(args);
        case "ct_gate_verdict":
          return await handleGateVerdict(args);
        case "ct_get_agent_prompt":
          return await handleGetAgentPrompt(args);
        case "ct_decompose_task":
          return await handleDecomposeTask(args);
        case "ct_escalation_decision":
          return await handleEscalationDecision(args);
        case "ct_list_roles":
          return await handleListRoles();
        // State writers (async — delegate to compiled modules with file locking)
        case "ct_init_pipeline":
          return await handleInitPipeline(args);
        case "ct_update_state":
          return await handleUpdateState(args);
        case "ct_transition_phase":
          return await handleTransitionPhase(args);
        // Orchestration tools
        case "ct_build_team":
          return await handleBuildTeam(args);
        case "ct_register_team":
          return await handleRegisterTeam(args);
        case "ct_get_plan_status":
          return await handleGetPlanStatus(args);
        case "ct_run_pwj_cycle":
          return await handleRunPwjCycle(args);
        default:
          return err(`Unknown tool: ${name}`);
      }
    } catch (e) {
      return err(`${name} failed: ${e.message}`);
    }
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch(console.error);
