/**
 * src/registration.js
 *
 * Read-only snapshot of which Lotor hooks are registered in Claude Code's
 * settings. Shared by bin/hook-session-start.js (stamped into every
 * session-open receipt) and src/mcp/server.js (lotor_status), so both
 * report the same view of the same file rather than drifting independently.
 *
 * Best-effort and read-only: an unreadable or absent settings file yields
 * `{ readable: false }` rather than throwing. `readable: false` means "not
 * found in the files checked", not "provably absent everywhere" — project
 * and enterprise settings can also register hooks and are not read here.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The real Claude Code settings locations. A parameter default rather than
 * a module constant so tests can substitute fixture paths without touching
 * the actual machine's settings.
 */
function defaultSettingsPaths() {
  return [
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.local.json')
  ];
}

/**
 * Snapshot which Lotor hooks are visible in the given settings files.
 * @param {string[]} [candidates] - Paths to check; defaults to the real
 *   user and local Claude Code settings files.
 */
function snapshotHookRegistration(candidates = defaultSettingsPaths()) {
  let readable = false;
  let blob = '';
  const sourcesRead = [];

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      blob += fs.readFileSync(file, 'utf8');
      sourcesRead.push(file);
      readable = true;
    } catch (e) {
      // best-effort; a file we cannot read is simply not counted
    }
  }

  if (!readable) return { readable: false };

  const has = needle => blob.includes(needle);
  return {
    readable: true,
    sessionStart: has('hook-session-start.js'),
    preToolUse: has('hook-pre-tool-use.js'),
    postToolUse: has('hook-post-tool-use.js'),
    sessionEnd: has('hook-session-end.js'),
    sourcesRead
  };
}

export { snapshotHookRegistration, defaultSettingsPaths };
