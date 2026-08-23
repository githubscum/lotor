/**
 * test/policy-destructive-flag-order-git-clean.test.js
 *
 * Regression tests for two under-gated destructive classes found by
 * hermes-nicosanchez (#912) during the 2026-08-22 C2 audit:
 *
 * 1. Long-form / reordered rm triggers. isDestructive fired only when the
 *    compact regex saw `-<letters>*[rR]...[fF]` ADJACENT to `rm`, or
 *    `--recursive` as the literal next token. So `rm --force --recursive`
 *    (long form, force-first), `rm --ignore-times --force --recursive`,
 *    and separated shorts (`rm -r -f`) all passed SILENTLY — no warn,
 *    no receipt. extractDestructiveTarget already tokenized flags in any
 *    order; the TRIGGER did not. Fix: the trigger uses the same shared
 *    token predicates as the extractor.
 *
 * 2. git clean. `git clean -fdx` force-deletes every untracked (and with
 *    -x, ignored) file without ever touching an rm token, so the
 *    destructive matcher had zero handling for it. Fix: `git clean` with
 *    -f AND (-d OR -x) is destructive; the first pathspec token goes
 *    through the same scratch-segment allowlist as rm targets, and a
 *    bare `git clean -fdx` (whole tree) always gates.
 *
 * Each case is asserted via isDestructive() (and the pipeline via
 * evaluate() for one case per class) so the test fails the moment the
 * matcher is wrong.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isDestructive, evaluate, loadPolicy } from '../src/policy/index.js';

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-flagorder-'));
const policy = loadPolicy(baseDir);

describe('policy: destructive rm trigger accepts any flag order/form', () => {
  // ---- cases that MUST gate (each failed silently before the fix) ----

  it('gates "rm --force --recursive src/policy" (long form, force-first)', () => {
    assert.equal(
      isDestructive({ command: 'rm --force --recursive src/policy' }),
      true,
      'flag ORDER must not matter; --force-first was silent at HEAD'
    );
  });

  it('gates "rm --ignore-times --force --recursive /var/www/app" (stacked long opts)', () => {
    assert.equal(
      isDestructive({ command: 'rm --ignore-times --force --recursive /var/www/app' }),
      true,
      'an unrelated long option between --force and --recursive hid the pair'
    );
  });

  it('gates "rm -r -f src/policy" (separated short flags)', () => {
    assert.equal(
      isDestructive({ command: 'rm -r -f src/policy' }),
      true,
      'short flags given separately never matched the adjacent-pair regex'
    );
  });

  it('gates "rm --recursive --force src/policy" (recursive-first long form)', () => {
    assert.equal(isDestructive({ command: 'rm --recursive --force src/policy' }), true);
  });

  it('gates "rm file.txt --force --recursive" (flags AFTER the operand)', () => {
    assert.equal(
      isDestructive({ command: 'rm file.txt --force --recursive' }),
      true,
      'operand-first spelling must gate like every other'
    );
  });

  it('fires through evaluate() (full policy pipeline)', () => {
    const r = evaluate(
      'Bash',
      { command: 'rm --force --recursive src/policy' },
      policy,
      baseDir
    );
    assert.ok(r, 'evaluate() should return a match');
    assert.equal(r.ruleId, 'destructive');
  });

  // ---- allowlist interaction must survive the widened trigger ----

  it('still exempts "rm --force --recursive /tmp/foo" (scratch allowlist)', () => {
    assert.equal(
      isDestructive({ command: 'rm --force --recursive /tmp/foo' }),
      false,
      'the widened trigger must not eat the legitimate-scratch exemption'
    );
  });

  it('still exempts "rm -r -f ./scratchpad/build"', () => {
    assert.equal(isDestructive({ command: 'rm -r -f ./scratchpad/build' }), false);
  });

  // ---- compact spellings keep gating (no regression) ----

  it('still gates "rm -rf src/policy" (compact)', () => {
    assert.equal(isDestructive({ command: 'rm -rf src/policy' }), true);
  });

  it('still gates "rm -fr src/policy" (compact, flipped)', () => {
    assert.equal(isDestructive({ command: 'rm -fr src/policy' }), true);
  });
});

describe('policy: git clean -f with -d/-x is destructive', () => {
  // ---- cases that MUST gate (all silent before the fix) ----

  it('gates "git clean -fdx" (whole tree, no pathspec)', () => {
    assert.equal(
      isDestructive({ command: 'git clean -fdx' }),
      true,
      'no pathspec means the ENTIRE tree: always destructive'
    );
  });

  it('gates "git clean -fd" (untracked dirs, no -x needed for the gate)', () => {
    assert.equal(isDestructive({ command: 'git clean -fd' }), true);
  });

  it('gates "git clean -fx" (ignored files only)', () => {
    assert.equal(isDestructive({ command: 'git clean -fx' }), true);
  });

  it('gates "git clean -fdx src/" (pathspec outside scratch)', () => {
    assert.equal(isDestructive({ command: 'git clean -fdx src/' }), true);
  });

  it('gates "git clean --force --directory --ignored build/" (long forms)', () => {
    assert.equal(
      isDestructive({ command: 'git clean --force --directory --ignored build/' }),
      true
    );
  });

  it('gates "cd /srv/app && git clean -fdx" (second command segment)', () => {
    assert.equal(isDestructive({ command: 'cd /srv/app && git clean -fdx' }), true);
  });

  it('fires through evaluate() (full policy pipeline)', () => {
    const r = evaluate(
      'Bash',
      { command: 'git clean -fdx' },
      policy,
      baseDir
    );
    assert.ok(r, 'evaluate() should return a match');
    assert.equal(r.ruleId, 'destructive');
  });

  // ---- allowlist interaction ----

  it('exempts "git clean -fdx /tmp/build" (pathspec under scratch root)', () => {
    assert.equal(
      isDestructive({ command: 'git clean -fdx /tmp/build' }),
      false,
      'a scoped clean of a scratch path stays exempt, like rm'
    );
  });

  // ---- non-force cleans MUST stay free ----

  it('does not gate "git clean -n" (dry run)', () => {
    assert.equal(isDestructive({ command: 'git clean -n' }), false);
  });

  it('does not gate "git clean -i" (interactive)', () => {
    assert.equal(isDestructive({ command: 'git clean -i' }), false);
  });

  it('does not gate "git clean -fd" WITHOUT force is impossible - sanity: plain "git clean" stays free', () => {
    assert.equal(isDestructive({ command: 'git clean' }), false);
  });

  it('does not gate "git clean -q" (quiet, nothing deleted)', () => {
    assert.equal(isDestructive({ command: 'git clean -q' }), false);
  });
});
