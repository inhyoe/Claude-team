#!/usr/bin/env node

/**
 * Claude Team - SessionStart Hook
 *
 * Fires when a new Claude Code session starts. Checks for active
 * Claude Team pipeline state and provides resume context.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

async function main() {
  try {
    const cwd = process.env.CLAUDE_WORKING_DIRECTORY || process.cwd();
    const statePath = join(cwd, '.omc', 'state', 'ct-pipeline-state.json');

    if (!existsSync(statePath)) return;

    const raw = readFileSync(statePath, 'utf-8');
    const state = JSON.parse(raw);

    if (!state || state.schemaVersion !== 2) return;

    if (state.active) {
      const phase = state.phase || 'unknown';
      const tasks = state.execution || {};
      const completed = tasks.tasksCompleted || 0;
      const total = tasks.tasksTotal || 0;

      process.stdout.write(
        `[Claude Team] Active pipeline detected. Phase: ${phase}, Progress: ${completed}/${total} tasks. Use ct_team_status MCP tool for details.`
      );
    } else if (state.cancel?.preserveForResume) {
      process.stdout.write(
        `[Claude Team] Resumable pipeline found (cancelled with preserve). Use ct_team_status to check status.`
      );
    }
  } catch {
    // Silent fail
  }
}

main();
