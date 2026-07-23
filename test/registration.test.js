/**
 * test/registration.test.js
 *
 * Unit tests for src/registration.js, the shared hook-registration
 * snapshot used by both bin/hook-session-start.js (stamped into every
 * session-open receipt) and src/mcp/server.js (lotor_status).
 *
 * Uses fixture files passed explicitly as the `candidates` argument rather
 * than the real ~/.claude/settings.json, so this suite never reads or
 * depends on the state of the machine it runs on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { snapshotHookRegistration } from '../src/registration.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-registration-'));
}

describe('snapshotHookRegistration', () => {
  it('reports readable: false when no candidate file exists', () => {
    const dir = makeTempDir();
    const result = snapshotHookRegistration([path.join(dir, 'nope.json')]);
    assert.strictEqual(result.readable, false);
  });

  it('detects all four hooks when all are registered', () => {
    const dir = makeTempDir();
    const settingsFile = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'node /x/bin/hook-session-start.js' }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'node /x/bin/hook-pre-tool-use.js' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'node /x/bin/hook-post-tool-use.js' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'node /x/bin/hook-session-end.js' }] }]
      }
    }));

    const result = snapshotHookRegistration([settingsFile]);
    assert.strictEqual(result.readable, true);
    assert.strictEqual(result.sessionStart, true);
    assert.strictEqual(result.preToolUse, true);
    assert.strictEqual(result.postToolUse, true);
    assert.strictEqual(result.sessionEnd, true);
    assert.deepStrictEqual(result.sourcesRead, [settingsFile]);
  });

  it('reports individual hooks as false when only some are registered (the gap this exists to catch)', () => {
    const dir = makeTempDir();
    const settingsFile = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: 'node /x/bin/hook-session-end.js' }] }]
      }
    }));

    const result = snapshotHookRegistration([settingsFile]);
    assert.strictEqual(result.readable, true);
    assert.strictEqual(result.preToolUse, false, 'the gate being unregistered must be visible');
    assert.strictEqual(result.sessionStart, false);
    assert.strictEqual(result.sessionEnd, true);
  });

  it('merges across multiple candidate files (user + local settings)', () => {
    const dir = makeTempDir();
    const userFile = path.join(dir, 'settings.json');
    const localFile = path.join(dir, 'settings.local.json');
    fs.writeFileSync(userFile, JSON.stringify({
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'node /x/bin/hook-session-end.js' }] }] }
    }));
    fs.writeFileSync(localFile, JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node /x/bin/hook-pre-tool-use.js' }] }] }
    }));

    const result = snapshotHookRegistration([userFile, localFile]);
    assert.strictEqual(result.sessionEnd, true, 'from the user file');
    assert.strictEqual(result.preToolUse, true, 'from the local file');
    assert.strictEqual(result.sourcesRead.length, 2);
  });

  it('an unreadable candidate is skipped rather than throwing', () => {
    const dir = makeTempDir();
    const asDirectory = path.join(dir, 'settings.json');
    fs.mkdirSync(asDirectory); // exists, but is not a file
    assert.doesNotThrow(() => snapshotHookRegistration([asDirectory]));
    const result = snapshotHookRegistration([asDirectory]);
    assert.strictEqual(result.readable, false);
  });
});
