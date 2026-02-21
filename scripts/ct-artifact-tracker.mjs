#!/usr/bin/env node

/**
 * Claude Team - PostToolUse:Write Hook
 *
 * Fires after Write tool calls. If the file is in .omc/artifacts/,
 * reminds the agent to register it via the artifact exchange protocol.
 */

import { readStdin } from './lib/stdin.mjs';

async function main() {
  try {
    const raw = await readStdin();
    if (!raw) return;

    const input = JSON.parse(raw);
    const filePath = input?.tool_input?.file_path;

    if (!filePath) return;

    if (filePath.includes('.omc/artifacts/') || filePath.includes('.omc\\artifacts\\')) {
      process.stdout.write(
        'Artifact written. Register via ct_update_state MCP tool for tracking.'
      );
    }
  } catch {
    // Silent fail
  }
}

main();
