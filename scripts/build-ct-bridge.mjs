#!/usr/bin/env node
/**
 * Build script for ct-bridge.cjs
 *
 * Bundles the MCP bridge with its dependencies from dist/ into a single CJS file.
 * The bridge needs access to compiled TypeScript modules for runtime logic.
 */
import { build } from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

await build({
  entryPoints: [resolve(root, 'bridge/ct-bridge.cjs')],
  outfile: resolve(root, 'bridge/ct-bridge.bundled.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: [
    'better-sqlite3',
    '@modelcontextprotocol/sdk',
    '@modelcontextprotocol/sdk/server/index.js',
    '@modelcontextprotocol/sdk/server/stdio.js',
    '@modelcontextprotocol/sdk/types.js',
  ],
  logLevel: 'info',
});

console.log('ct-bridge built successfully.');
