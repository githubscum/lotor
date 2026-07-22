/**
 * src/home.js
 *
 * Resolves the single canonical home for Lotor's receipt chain and keys.
 * Entry points (MCP server and CLIs) call resolveHome() so they all read
 * and write the same store, regardless of the client's launch directory.
 */

import os from 'node:os';
import path from 'node:path';

/**
 * Resolve the canonical Lotor home directory as an absolute path.
 * Honors LOTOR_HOME if set and non-empty; otherwise ~/.lotor.
 * @returns {string} Absolute path to the Lotor home directory.
 */
function resolveHome() {
  const override = process.env.LOTOR_HOME;
  if (override && override.trim() !== '') {
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.lotor');
}

export { resolveHome };
