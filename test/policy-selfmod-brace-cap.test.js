/**
 * test/policy-selfmod-brace-cap.test.js
 *
 * The brace-expansion cap must FAIL CLOSED. The first LOTOR-C2 fix returned
 * partially-expanded leftovers as-is when the variant cap filled. Expansion
 * is depth-first and pops the last option first, so at the cap the leftovers
 * are exactly the FIRST options of the early groups, unexpanded. A protected
 * fragment split across two groups in first position, followed by a few
 * harmless trailing groups, slipped through the patched matcher:
 *
 *   touch src/{pol,xx}{icy,e}/p.js && echo {a,b}{c,d}{e,f}{g,h}{i,j}
 *
 * Found 2026-08-21 while verifying the C2 submission. This test pins the
 * fail-closed behaviour with a command that overflows any sane cap, and the
 * over-gating direction for an overflowing command that touches nothing
 * protected (that one is accepted: a wrong denial costs a signature, a wrong
 * allow edits the gate).
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
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-selfmod-brace-cap-'));
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

// Enough binary groups to overflow a 4096 cap: 2^13 = 8192 variants.
const PAD = '{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}{q,r}{s,t}{u,v}{w,x}{y,z}';

describe('policy: brace-expansion cap fails closed (LOTOR-C2 residual)', () => {
  it('gates: the demonstrated split-fragment evasion with five trailing groups', () => {
    assertGated('touch src/{pol,xx}{icy,e}/p.js && echo {a,b}{c,d}{e,f}{g,h}{i,j}');
  });

  it('gates: the same evasion padded past any cap', () => {
    assertGated(`touch src/{pol,xx}{icy,e}/p.js && echo ${PAD}`);
  });

  it('gates (fails closed): an overflowing command that names nothing protected', () => {
    // Accepted over-gating direction. Unverified must not mean allowed.
    assertGated(`echo ${PAD}`);
  });

  it('does NOT gate: a modest brace command that names nothing protected', () => {
    assert.equal(isSelfMod('Bash', { command: 'touch src/{foo,bar}/probe.js' }, baseDir), false);
  });
});
