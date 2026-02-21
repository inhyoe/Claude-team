/**
 * Claude Team - Worker Preamble
 *
 * Preamble templates for team workers, extending OMC's preamble with role awareness.
 */

import type { RoleType } from '../shared/types.js';
import { ROLE_DEFINITIONS } from '../shared/constants.js';
import { getMergedCapabilities } from './role-merger.js';

/**
 * Base worker preamble for Claude Team agents.
 */
export const CT_WORKER_PREAMBLE = `CONTEXT: You are a ROLE-BASED TEAM WORKER in a Claude Team project.

== IDENTITY ==
ROLE: {role_name}
PERSONA: {persona_name}
DAG LAYER: {dag_layer}
CAPABILITIES: {capabilities}

== WORK PROTOCOL ==

1. CLAIM: Call TaskList to see your assigned tasks (owner = "{worker_name}").
   Pick the first task with status "pending" that is assigned to you.
   Call TaskUpdate to set status "in_progress".

2. WORK: Execute the task using your tools (Read, Write, Edit, Bash).
   ONLY modify files within your file ownership scope.
   Do NOT spawn sub-agents. Do NOT delegate. Work directly.

3. ARTIFACT: Save deliverables to .omc/artifacts/{sprint_id}/{task_id}/
   Use the appropriate artifact type for your role.

4. COMPLETE: When done, mark the task completed:
   TaskUpdate(taskId, status: "completed")

5. REPORT: Notify the lead via SendMessage:
   SendMessage(type: "message", recipient: "team-lead",
     content: "Completed task #ID: <summary>", summary: "Task #ID complete")

6. NEXT: Check TaskList for more assigned tasks. If none, stand by.

== KANBAN AWARENESS ==
Tasks flow: Backlog → Todo → In-Progress → Review → Done
You move tasks to In-Progress when starting and request Review when done.
Only QA/Security/PL can approve (Review → Done).

== QUALITY STANDARDS ==
All code must pass quality gates before moving to Done:
- correctness >= 3, security >= 3, performance >= 3
- maintainability >= 3, test_coverage >= 3
- Overall average >= 7.0

== FILE OWNERSHIP ==
ONLY modify files assigned to you. If you need to change shared files,
request PL mediation via SendMessage.

== COMMUNICATION ==
- Report to: team-lead (PL)
- Request review: Send artifact + review_request message
- Report blockers: Escalate to PL immediately
- Use SendMessage with type "message" only, never "broadcast"

== SHUTDOWN ==
When you receive a shutdown_request, respond with:
SendMessage(type: "shutdown_response", request_id: "<from request>", approve: true)
`;

/**
 * Build a role-specific preamble for a team worker.
 */
export function buildRolePreamble(
  role: RoleType,
  workerName: string,
  teamName: string,
  mergedRoles: RoleType[] = [],
  fileOwnership: string[] = [],
  sprintId?: string
): string {
  const def = ROLE_DEFINITIONS[role];
  if (!def) return CT_WORKER_PREAMBLE;

  const capabilities = getMergedCapabilities(role, mergedRoles);

  let preamble = CT_WORKER_PREAMBLE
    .replace('{role_name}', `${def.role}${mergedRoles.length > 0 ? ` (+${mergedRoles.join(', ')})` : ''}`)
    .replace('{persona_name}', def.persona)
    .replace('{dag_layer}', def.dagLayer)
    .replace('{capabilities}', capabilities.join(', '))
    .replace('{worker_name}', workerName)
    .replace('{sprint_id}', sprintId ?? 'unassigned');

  // Add team context
  preamble = `TEAM: ${teamName}\nYOUR NAME: ${workerName}\n\n${preamble}`;

  // Add file ownership if specified
  if (fileOwnership.length > 0) {
    preamble += `\n== YOUR FILE SCOPE ==\n${fileOwnership.map(f => `- ${f}`).join('\n')}\n`;
  }

  return preamble;
}

/**
 * Build a preamble for MCP (Codex/Gemini) workers.
 */
export function buildMcpRolePreamble(
  role: RoleType,
  taskSubject: string,
  taskDescription: string,
  workingDirectory: string,
  mergedRoles: RoleType[] = []
): string {
  const def = ROLE_DEFINITIONS[role];
  const capabilities = getMergedCapabilities(role, mergedRoles);

  return `CONTEXT: You are an autonomous ${def?.description ?? role} agent.
ROLE: ${role}${mergedRoles.length > 0 ? ` (+${mergedRoles.join(', ')})` : ''}
CAPABILITIES: ${capabilities.join(', ')}

TASK: ${taskSubject}

DESCRIPTION:
${taskDescription}

WORKING DIRECTORY: ${workingDirectory}

INSTRUCTIONS:
- Complete the task using your role's expertise
- Make all necessary code changes directly
- Run verification commands to confirm changes work
- Document all modified files in your output
- Note any issues or follow-up work needed
`;
}
