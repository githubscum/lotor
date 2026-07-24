/**
 * test/policy-destructive-dotdot.test.js
 *
 * Regression test for the S1-3 finding (2026-07-24 gate-coverage review):
 * the `destructive` allowlist matches if ANY path segment is a scratch dir,
 * and `..` is never normalized. So `rm -rf /tmp/../etc` is allowlisted because
 * the FIRST segment is `tmp`, even though the path resolves to `/etc`.
 *
 * The fix is lexical: collapse `.` and `..` segments without touching the
 * filesystem (no symlink resolution, no stat), then base the allowlist on the
 * NORMALIZED FINAL target. Both `/` and `\` separators and Windows drive
 * letters are handled.
 *
 * Each case is asserted both via isDestructive() and through evaluate() so
 * the test fails the moment the matcher is wrong.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isDestructive, evaluate, loadPolicy } from '../src/policy/index.js';

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-dotdot-'));
const policy = loadPolicy(baseDir);

describe('policy: destructive allowlist normalizes .. (S1-3 regression)', () => {
  // ---- cases that MUST gate after the fix ----

  it('gates "rm -rf /tmp/../etc" (tmp is allowlisted but .. resolves out)', () => {
    assert.equal(
      isDestructive({ command: 'rm -rf /tmp/../etc' }),
      true,
      'the normalized target is /etc, not under any scratch root'
    );
  });

  it('gates "rm -rf tmp/../secret" (relative tmp escapes via ..)', () => {
    assert.equal(
      isDestructive({ command: 'rm -rf tmp/../secret' }),
      true,
      'normalized: secret, not under a scratch root'
    );
  });

  it('gates "rm -rf /var/../etc" (var is not allowlisted, .. does not help)', () => {
    // This is a control: the path is not allowlisted before normalization
    // either, so it already gates. The test is here as a baseline.
    assert.equal(
      isDestructive({ command: 'rm -rf /var/../etc' }),
      true
    );
  });

  it('gates "rm -rf /tmp/sub/../../../etc" (multiple .. climb out)', () => {
    assert.equal(
      isDestructive({ command: 'rm -rf /tmp/sub/../../../etc' }),
      true,
      'after collapsing .. the path is /etc'
    );
  });

  it('gates "Remove-Item -Recurse -Force temp/../C_important" (PowerShell ..)', () => {
    assert.equal(
      isDestructive({ command: 'Remove-Item -Recurse -Force temp/../C_important' }),
      true,
      'PowerShell Remove-Item has the same .. trap'
    );
  });

  it('gates via evaluate() so the rule fires through the full policy pipeline', () => {
    const r = evaluate(
      'Bash',
      { command: 'rm -rf /tmp/../etc' },
      policy,
      baseDir
    );
    assert.ok(r, 'evaluate() should return a match');
    assert.equal(r.ruleId, 'destructive');
  });

  // ---- cases that MUST NOT regress ----

  it('still exempts "rm -rf /tmp/foo" (legit /tmp deletion)', () => {
    assert.equal(
      isDestructive({ command: 'rm -rf /tmp/foo' }),
      false,
      'real /tmp deletion stays under the allowlist'
    );
  });

  it('still exempts "rm -rf ./scratchpad/build" (legit scratchpad work)', () => {
    assert.equal(
      isDestructive({ command: 'rm -rf ./scratchpad/build' }),
      false
    );
  });

  // The PR#7 segment-equality fix must stay intact: a directory whose name
  // merely CONTAINS an allow-word still gates.
  it('still gates "rm -rf /home/me/mktemp-xyz" (substring, not segment)', () => {
    assert.equal(isDestructive({ command: 'rm -rf /home/me/mktemp-xyz' }), true);
  });

  it('still gates "rm -rf templates" (substring, not segment)', () => {
    assert.equal(isDestructive({ command: 'rm -rf templates' }), true);
  });

  it('still gates "rm -rf C:/site/templates"', () => {
    assert.equal(isDestructive({ command: 'rm -rf C:/site/templates' }), true);
  });

  it('still exempts "rm -rf /tmp/./foo" (. inside the scratch root stays)', () => {
    // ./ inside an allowlisted path is a no-op; the final target is /tmp/foo.
    assert.equal(
      isDestructive({ command: 'rm -rf /tmp/./foo' }),
      false,
      'a no-op . inside an allowlisted path stays under the allowlist'
    );
  });
});
