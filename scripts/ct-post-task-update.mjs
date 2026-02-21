#!/usr/bin/env node

/**
 * Claude Team - PostToolUse:TaskUpdate Hook
 *
 * Fires after TaskUpdate calls. Provides contextual guidance:
 * - When task moves to 'review': remind about quality gate
 * - When task is 'completed': show kanban progress hint
 */

import { readStdin } from './lib/stdin.mjs';

async function main() {
  try {
    const raw = await readStdin();
    if (!raw) return;

    const input = JSON.parse(raw);
    const toolInput = input?.tool_input;
    if (!toolInput) return;

    const status = toolInput.status;
    const taskId = toolInput.taskId;

    if (!status || !taskId) return;

    if (status === 'review' || status === 'in_progress' && toolInput.activeForm?.includes('review')) {
      process.stdout.write(
        `Task #${taskId} moved to review. Consider running quality gate: use ct_review_score MCP tool.`
      );
    } else if (status === 'completed') {
      process.stdout.write(
        `Task #${taskId} completed. Check TaskList for remaining work or newly unblocked tasks.`
      );
    }
  } catch {
    // Silent fail - hooks should never crash the pipeline
  }
}

main();
