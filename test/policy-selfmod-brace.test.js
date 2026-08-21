/**
 * test/policy-selfmod-brace.test.js
 *
 * Regression test for LOTOR-C2: shell brace expansion splits a protected
 * path fragment across shell syntax. `touch src/{policy,gate}/probe.js`
 * writes into src/policy AND src/gate, but the literal command contains
 * neither `src/policy/` nor `src/gate/` contiguously, so the substring
 * checks in isSelfModCommand miss it.
 *
 * Each gated case is asserted both via isSelfMod() and through evaluate()
 * with the default policy, mirroring policy-selfmod-spelling.test.js.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isSelfMod, evaluate, loadPolicy } from '../src/policy/index.js';

let baseDir;
let savedHome;

before(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-selfmod-brace-'));
  savedHome = process.env.LOTOR_HOME;
  process.env.LOTOR_HOME = baseDir;
});

after(() => {
  if (savedHome === undefined) {
    delete process.env.LOTOR_HOME;
  } else {
    process.env.LOTOR_HOME = savedHome;
  }
  try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const policy = loadPolicy(os.tmpdir());

function assertGated(cmd) {
  assert.equal(isSelfMod('Bash', { command: cmd }, baseDir), true, `isSelfMod: ${cmd}`);
  const r = evaluate('Bash', { command: cmd }, policy, baseDir);
  assert.ok(r, `evaluate() should return a match for: ${cmd}`);
  assert.equal(r.ruleId, 'self-mod', `ruleId for: ${cmd}`);
}

function assertFree(cmd) {
  assert.equal(isSelfMod('Bash', { command: cmd }, baseDir), false, `isSelfMod: ${cmd}`);
  const r = evaluate('Bash', { command: cmd }, policy, baseDir);
  assert.ok(r == null || r.ruleId !== 'self-mod', `self-mod must not fire for: ${cmd}`);
}

describe('policy: self-mod catches brace-expanded protected paths (LOTOR-C2)', () => {
  // ---- cases that MUST gate ----
  it('gates: touch src/{policy,gate}/probe.js', () => {
    assertGated('touch src/{policy,gate}/probe.js');
  });

  it("gates: sed -i 's/grazing/loose/' src/{policy,gate}/index.js", () => {
    assertGated("sed -i 's/grazing/loose/' src/{policy,gate}/index.js");
  });

  it('gates: touch src/{policy,chain}/{a,b}.js (two groups)', () => {
    assertGated('touch src/{policy,chain}/{a,b}.js');
  });

  it('gates: cp README.md src/{docs,grant}/x.js (one protected option)', () => {
    assertGated('cp README.md src/{docs,grant}/x.js');
  });

  // ---- controls that MUST NOT over-gate ----
  it('does NOT gate: touch src/{foo,bar}/probe.js (no protected option)', () => {
    assertFree('touch src/{foo,bar}/probe.js');
  });

  it('does NOT gate: inert double-quoted commit message naming src/{policy,gate}', () => {
    assertFree('git commit -m "edit src/{policy,gate} later"');
  });

  // ---- regression guards: un-braced forms still gate ----
  it('still gates the plain spelling: touch src/policy/probe.js', () => {
    assertGated('touch src/policy/probe.js');
  });

  it('still gates the plain spelling: touch src/gate/probe.js', () => {
    assertGated('touch src/gate/probe.js');
  });
});
