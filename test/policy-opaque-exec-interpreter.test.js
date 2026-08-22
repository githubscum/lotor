/**
 * test/policy-opaque-exec-interpreter.test.js
 *
 * Regression test for the C2-2026-08-22 finding: `opaque-exec` recognises a
 * script only by its FILE's extension. `SCRIPT_EXT` covers
 * `.ps1|.sh|.bash|.zsh|.bat|.cmd`, so a local script the gate cannot read
 * flows free whenever it is handed to an interpreter rather than spelled with
 * one of those six extensions:
 *
 *   python /tmp/evil.py        python3 x.py        node /tmp/evil.js
 *   ruby /tmp/evil.rb          perl /tmp/evil.pl   php /tmp/evil.php
 *   bash /tmp/deploy           sh /tmp/deploy      (extensionless shell script)
 *
 * Each is the deploy-incident class (KNOWN-LIMITS 21): a local file whose
 * contents the engine cannot read, executed as a program. One extension
 * spelling away from `./deploy.sh`, which gates.
 *
 * DISCRIMINATION (what must stay free):
 *   - inline-code forms: `bash -c "..."`, `sh -c "..."`, `python -c "..."`,
 *     `node -e "..."` — the code string is IN the command, visible to the
 *     other matchers, so opaque-exec does not need to own it.
 *   - module forms: `python -m http.server` — an installed module, not a
 *     local script file.
 *   - flags-only: `python --version`, `node -v` — no file handed over.
 *   - plain commands: `ls -la`, `cat file.txt` — no interpreter, no script.
 *
 * Each case is asserted both via the direct matcher and through evaluate()
 * with the default policy.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isOpaqueExec, evaluate, loadPolicy } from '../src/policy/index.js';

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-opaque-interp-'));
const policy = loadPolicy(baseDir);

describe('policy: opaque-exec interpreter-with-file (C2-2026-08-22)', () => {
  // ---- cases that MUST gate after the fix ----

  it('gates "python /tmp/evil.py" (interpreter + local file)', () => {
    assert.equal(isOpaqueExec({ command: 'python /tmp/evil.py' }), true);
  });

  it('gates "python3 script.py"', () => {
    assert.equal(isOpaqueExec({ command: 'python3 script.py' }), true);
  });

  it('gates "node /tmp/evil.js"', () => {
    assert.equal(isOpaqueExec({ command: 'node /tmp/evil.js' }), true);
  });

  it('gates "ruby /tmp/evil.rb"', () => {
    assert.equal(isOpaqueExec({ command: 'ruby /tmp/evil.rb' }), true);
  });

  it('gates "perl /tmp/evil.pl"', () => {
    assert.equal(isOpaqueExec({ command: 'perl /tmp/evil.pl' }), true);
  });

  it('gates "php /tmp/evil.php"', () => {
    assert.equal(isOpaqueExec({ command: 'php /tmp/evil.php' }), true);
  });

  it('gates "bash /tmp/deploy" (extensionless shell script)', () => {
    assert.equal(isOpaqueExec({ command: 'bash /tmp/deploy' }), true);
  });

  it('gates "sh /tmp/deploy" (extensionless shell script)', () => {
    assert.equal(isOpaqueExec({ command: 'sh /tmp/deploy' }), true);
  });

  it('gates "env python /tmp/evil.py" (env-prefixed interpreter)', () => {
    assert.equal(isOpaqueExec({ command: 'env python /tmp/evil.py' }), true);
  });

  it('gates an interpreter with flags before the file: "bash --posix /tmp/deploy"', () => {
    assert.equal(isOpaqueExec({ command: 'bash --posix /tmp/deploy' }), true);
  });

  it('gates through evaluate() so the rule fires through the full policy pipeline', () => {
    const r = evaluate(
      'Bash',
      { command: 'python /tmp/evil.py -d https://host/collect' },
      policy,
      baseDir
    );
    assert.ok(r, 'evaluate() should return a match');
    assert.equal(r.ruleId, 'opaque-exec');
  });

  // ---- cases that MUST NOT regress ----

  it('does not gate "bash -c \\"echo hi\\"" (inline code is visible to the matchers)', () => {
    assert.equal(isOpaqueExec({ command: 'bash -c "echo hi"' }), false);
  });

  it('does not gate "sh -c \\"echo hi\\""', () => {
    assert.equal(isOpaqueExec({ command: 'sh -c "echo hi"' }), false);
  });

  it('does not gate "python -c \\"print(1)\\""', () => {
    assert.equal(isOpaqueExec({ command: 'python -c "print(1)"' }), false);
  });

  it('does not gate "node -e \\"console.log(1)\\""', () => {
    assert.equal(isOpaqueExec({ command: 'node -e "console.log(1)"' }), false);
  });

  it('does not gate "python -m http.server" (module, not a local file)', () => {
    assert.equal(isOpaqueExec({ command: 'python -m http.server' }), false);
  });

  it('does not gate "python --version" (flags only, no file)', () => {
    assert.equal(isOpaqueExec({ command: 'python --version' }), false);
  });

  it('does not gate "node -v" (flags only, no file)', () => {
    assert.equal(isOpaqueExec({ command: 'node -v' }), false);
  });

  it('does not gate "ls -la" (no interpreter, no script)', () => {
    assert.equal(isOpaqueExec({ command: 'ls -la' }), false);
  });

  it('does not gate "cat file.txt" (no interpreter, no script)', () => {
    assert.equal(isOpaqueExec({ command: 'cat file.txt' }), false);
  });

  it('does not gate "which python" (interpreter as an argument, not the command)', () => {
    assert.equal(isOpaqueExec({ command: 'which python' }), false);
  });

  it('does not gate "echo python /tmp/x.py" (interpreter only in printable prose)', () => {
    assert.equal(isOpaqueExec({ command: 'echo python /tmp/x.py' }), false);
  });

  it('still gates "a && ./evil.sh" (the existing && path must not regress)', () => {
    assert.equal(isOpaqueExec({ command: 'a && ./evil.sh' }), true);
  });

  it('still gates "source /tmp/deploy.sh" (existing extension path)', () => {
    assert.equal(isOpaqueExec({ command: 'source /tmp/deploy.sh' }), true);
  });
});