/**
 * Regression for listing 14 / the PR #28 residual.
 *
 * An explicitly local extensionless executable cannot be classified from its
 * spelling. Read the resolved file header before deciding: a shebang is an
 * unreadable script and must gate; ELF is a compiled binary and stays free;
 * an existing regular file with neither header remains unknown and gates in
 * the safe direction.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isOpaqueExec, evaluate, loadPolicy } from '../src/policy/index.js';

let cwd;

before(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-extensionless-'));
  fs.writeFileSync(path.join(cwd, 'deploy'), '#!/bin/sh\necho deploy\n', { mode: 0o755 });
  fs.writeFileSync(path.join(cwd, 'native'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]), { mode: 0o755 });
  fs.writeFileSync(path.join(cwd, 'unknown'), 'not a recognised executable header\n', { mode: 0o755 });
  fs.mkdirSync(path.join(cwd, 'directory'));
});

after(() => fs.rmSync(cwd, { recursive: true, force: true }));

describe('policy: extensionless local execution reads the resolved file header', () => {
  it('gates a shebang script invoked as ./deploy', () => {
    assert.equal(isOpaqueExec({ command: './deploy' }, cwd), true);
  });

  it('gates the Windows spelling .\\deploy', () => {
    assert.equal(isOpaqueExec({ command: '.\\deploy' }, cwd), true);
  });

  it('gates a quoted explicit local path', () => {
    assert.equal(isOpaqueExec({ command: '"./deploy" --target production' }, cwd), true);
  });

  it('fires through the full policy pipeline', () => {
    const result = evaluate('Bash', { command: './deploy' }, loadPolicy(cwd), cwd, undefined, cwd);
    assert.equal(result?.ruleId, 'opaque-exec');
  });

  it('does not gate an ELF binary', () => {
    assert.equal(isOpaqueExec({ command: './native' }, cwd), false);
  });

  it('gates an existing regular file with an unknown header', () => {
    assert.equal(isOpaqueExec({ command: './unknown' }, cwd), true);
  });

  it('does not gate a missing path, directory, or PATH-resolved command', () => {
    assert.equal(isOpaqueExec({ command: './missing' }, cwd), false);
    assert.equal(isOpaqueExec({ command: './directory' }, cwd), false);
    assert.equal(isOpaqueExec({ command: 'deploy' }, cwd), false);
  });

  it('still treats a read-only segment as a read', () => {
    assert.equal(isOpaqueExec({ command: 'cat ./deploy' }, cwd), false);
  });
});
