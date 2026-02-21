#!/usr/bin/env node

/**
 * Claude Team - PreToolUse:Edit/Write Hook
 *
 * Fires before Edit/Write tool calls. Provides a warning if the file
 * being edited is outside the current agent's assigned file ownership scope.
 *
 * This is advisory only (does not block) since file ownership info
 * requires the pipeline state which may not always be available.
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readStdin } from './lib/stdin.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  try {
    const raw = await readStdin();
    if (!raw) return;

    const input = JSON.parse(raw);
    const filePath = input?.tool_input?.file_path;

    if (!filePath) return;

    // Only check if we have a pipeline state with file ownership info
    const cwd = process.env.CLAUDE_WORKING_DIRECTORY || process.cwd();
    const statePath = join(cwd, '.omc', 'state', 'ct-pipeline-state.json');

    if (!existsSync(statePath)) return;

    // Try to use the compiled file-ownership module for detailed checks
    try {
      const distPath = join(__dirname, '..', 'dist', 'core', 'file-ownership.js');

      if (existsSync(distPath)) {
        const { resolveFileOwner } = await import(distPath);
        const state = JSON.parse(readFileSync(statePath, 'utf-8'));

        // Extract nodes from state
        const nodes = state?.plan?.nodes ? Object.values(state.plan.nodes) : [];

        if (nodes.length > 0) {
          const result = resolveFileOwner(filePath, nodes);

          if (result.owner) {
            process.stdout.write(
              `File ownership: ${result.owner.id} (${result.owner.roleId})`
            );
          } else if (result.conflicts.length > 0) {
            const conflictIds = result.conflicts.map(n => n.id).join(', ');
            process.stdout.write(
              `WARNING: File has conflicting ownership: ${conflictIds}`
            );
          } else {
            process.stdout.write(
              'Verify this file is within your assigned file ownership scope before editing.'
            );
          }
          return;
        }
      }
    } catch {
      // Fall through to generic message
    }

    // Fallback: Advisory message only - don't block edits
    // The team lead assigns file ownership during task decomposition
    // Workers should be aware of their scope
    process.stdout.write(
      'Verify this file is within your assigned file ownership scope before editing.'
    );
  } catch {
    // Silent fail
  }
}

main();
