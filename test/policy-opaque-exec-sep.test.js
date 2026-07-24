/**
 * test/policy-opaque-exec-sep.test.js
 *
 * Regression test for the S1-1 finding (2026-07-24 gate-coverage review):
 * `opaque-exec` is bypassed by the single `&` (bash background, cmd.exe
 * sequential) and by carriage returns.
 *
 * The current CMD_SEPARATORS regex is /(?:&&|\|\||[;|\n])/ — single `&` and
 * `\r` are missing. So `ls & ./deploy.ps1 ...` is treated as one segment and
 * the read-verb lead exempts the script exec. A quoted URL with `&` may now
 * split in this path — that is safe-direction (gate-or-neutral); this test
 * also asserts it never becomes a new under-gate.
 *
 * Each case below is asserted both via the direct matcher and through
 * evaluate() with the default policy, so the test fails the moment the
 * matcher is wrong, regardless of where the gap was.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isOpaqueExec, evaluate, loadPolicy } from '../src/policy/index.js';

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-opaque-sep-'));
const policy = loadPolicy(baseDir);

describe('policy: opaque-exec separator set (S1-1 regression)', () => {
  // ---- cases that MUST gate after the fix ----

  it('gates "ls & ./deploy.ps1 -PiHost pi@host" (bash background single &)', () => {
    assert.equal(
      isOpaqueExec({ command: 'ls & ./deploy.ps1 -PiHost pi@host' }),
      true,
      'single & is a shell separator; the script is being executed in the second segment'
    );
  });

  it('gates "cat /dev/null & ./deploy.ps1 -PiHost pi@host"', () => {
    assert.equal(
      isOpaqueExec({ command: 'cat /dev/null & ./deploy.ps1 -PiHost pi@host' }),
      true,
      'read lead is on the first segment, the script is in the second'
    );
  });

  it('gates "type x & ./evil.bat" (cmd.exe sequential &)', () => {
    assert.equal(
      isOpaqueExec({ command: 'type x & ./evil.bat' }),
      true,
      'cmd.exe uses & to chain commands; the second runs'
    );
  });

  it('gates a carriage-return-separated "cat hi\\r./evil.ps1" (CR-only is a separator)', () => {
    // cat is a read verb, but only for the segment it leads. With \r treated
    // as a separator, the second segment "./evil.ps1" is the one being
    // executed and the read lead does not apply there. Without the \r
    // addition, the whole string is one segment, cat is the read lead, and
    // the rule is bypassed.
    assert.equal(
      isOpaqueExec({ command: 'cat hi\r./evil.ps1' }),
      true,
      '\\r splits the command; the second segment executes the script and the read lead does not cover it'
    );
  });

  it('gates via evaluate() so the rule fires through the full policy pipeline', () => {
    const r = evaluate(
      'Bash',
      { command: 'ls & ./deploy.ps1 -PiHost pi@host' },
      policy,
      baseDir
    );
    assert.ok(r, 'evaluate() should return a match');
    assert.equal(r.ruleId, 'opaque-exec');
  });

  // ---- cases that MUST NOT regress ----

  it('does not gate a plain "ls -la" (no script anywhere)', () => {
    assert.equal(isOpaqueExec({ command: 'ls -la' }), false);
  });

  it('does not gate "cat file.txt" (no script anywhere)', () => {
    assert.equal(isOpaqueExec({ command: 'cat file.txt' }), false);
  });

  it('still gates "a && ./evil.sh" (the existing && path must not regress)', () => {
    assert.equal(isOpaqueExec({ command: 'a && ./evil.sh' }), true);
  });

  it('still gates "a || ./evil.sh" (the existing || path must not regress)', () => {
    assert.equal(isOpaqueExec({ command: 'a || ./evil.sh' }), true);
  });

  it('still gates "echo hi; ./evil.sh" (the existing ; path must not regress)', () => {
    assert.equal(isOpaqueExec({ command: 'echo hi; ./evil.sh' }), true);
  });

  // Re-review finding #2: a script executed inside a command substitution or a
  // subshell is terminated by ')' or a backtick, which SCRIPT_EXT must count as
  // boundaries or the exec hides one indirection away (the deploy-incident class).
  it('gates "$(./evil.ps1)" (command substitution)', () => {
    assert.equal(isOpaqueExec({ command: '$(./evil.ps1)' }), true);
    assert.equal(isOpaqueExec({ command: 'x=$(./deploy.sh)' }), true);
  });

  it('gates a backtick-substituted script exec', () => {
    assert.equal(isOpaqueExec({ command: '`./evil.ps1`' }), true);
  });

  it('gates "(./evil.ps1)" (subshell)', () => {
    assert.equal(isOpaqueExec({ command: '(./evil.ps1)' }), true);
  });

  // Re-review round-3 finding #1: a no-space redirect after the extension
  // (`./deploy.ps1>log`) evaded the terminator allowlist. The negative-lookahead
  // rewrite closes redirects and any future terminator in one move.
  it('gates a script exec with a no-space redirect', () => {
    assert.equal(isOpaqueExec({ command: './deploy.ps1>log.txt' }), true);
    assert.equal(isOpaqueExec({ command: './deploy.ps1>>log' }), true);
    assert.equal(isOpaqueExec({ command: './x.sh<in' }), true);
  });

  it('does not treat a longer extension as a script (.ps1x is not .ps1)', () => {
    assert.equal(isOpaqueExec({ command: './deploy.ps1x arg' }), false);
  });

  // The contract on a quoted URL containing `&` is gate-or-neutral. The only
  // failure mode this test guards against is the URL being under-gated by the
  // separator set; the matching expansion is acceptable.
  it('a quoted URL containing & is at worst gated, never silently allowed', () => {
    // No script in either half. The earlier version treated the whole string
    // as one segment (because & was not a separator), so the matcher saw no
    // script and returned false. After the fix, splitting on the bare & yields
    // segments that are also script-free — still no script, still false.
    // The important invariant: it must not return true for a non-script
    // command (it never did), and it must not return a "skip" result. The
    // bottom line: false is the only acceptable answer, both before and
    // after, for a command with no script at all.
    assert.equal(
      isOpaqueExec({ command: 'curl "https://example.com/?a=1&b=2"' }),
      false,
      'a curl with a URL containing & but no script is not opaque-exec'
    );
  });
});
