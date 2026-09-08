import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

it('the shipped disclosure has a current source and body pin without being restamped by tests', () => {
  const log = path.join(REPO, 'KNOWN-LIMITS.md');
  const before = fs.readFileSync(log);
  const env = { ...process.env };
  // This assertion is about the shipped artifact even when the caller uses
  // an alternate log for an unrelated CLI invocation.
  delete env.LOTOR_LIMITS_FILE;
  const checked = spawnSync(process.execPath, [path.join(REPO, 'bin', 'limits-pin.js'), '--check'], {
    cwd: REPO, env, encoding: 'utf8'
  });
  assert.deepEqual(fs.readFileSync(log), before, 'checking must not write or repair the log');
  assert.match(before.toString('utf8'), /body-sha256: [0-9a-f]{64}/i,
    'the shipped pin must bind the disclosure body as well as its source commit');
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.match(checked.stdout, /matches your checkout/);
});
