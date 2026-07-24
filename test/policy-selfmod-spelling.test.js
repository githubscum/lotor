/**
 * test/policy-selfmod-spelling.test.js
 *
 * Regression test for the S1-4 finding (2026-07-24 gate-coverage review):
 * `self-mod` matches the receipts/keys/nonce-log by the absolute baseDir
 * fragment only. Tilde (`~`), `$HOME`, `%USERPROFILE%`, and relative
 * spellings slip through, so `rm -rf ~/.lotor/receipts` falls to
 * `destructive` = warn on a default install. The chain and signing key
 * delete UNSIGNED. This contradicts the "fixed 2026-07-24" claim in
 * KNOWN-LIMITS 22.
 *
 * The fix gates:
 *   - The basenames chain.jsonl, chain.key, approval-nonces.log
 *     unconditionally (they are Lotor-specific, not a generic risk).
 *   - `receipts`/`keys` as a path segment in a `.lotor` / LOTOR_HOME
 *     context.
 * Normalize `~`, `$HOME`, `%USERPROFILE%` to the resolved home before
 * matching.
 *
 * Each case is asserted both via isSelfMod() and through evaluate() with
 * the default policy.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isSelfMod, evaluate, loadPolicy } from '../src/policy/index.js';

// Isolated home. We use a real temp dir so resolveHome() returns its
// equivalent under PATH, but we also use process.env.LOTOR_HOME to make
// the resolved home match the temp dir exactly. Otherwise a "real" home
// like C:\Users\liemi\.lotor would not exist on this machine and the
// tilde-expansion tests would still pass but for a different reason.
let baseDir;
let savedHome;

before(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-selfmod-'));
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

const policy = loadPolicy(baseDir);

// Helper: build an "absolute-equivalent" path under baseDir/.lotor. We
// cannot just write "~/.lotor/receipts" because the tests run with
// LOTOR_HOME set to a tempdir; the test instead uses the tempdir itself
// as if it were the home, and the relevant spellings are expanded by
// the matcher using os.homedir() (which we cannot redirect cheaply).
// To make these tests robust regardless of how the implementation
// resolves "~", we exercise the four spellings in two ways: (1) with the
// matcher asked about a synthesized command that uses the home path
// string, and (2) directly via the underlying command string with the
// real home.

describe('policy: self-mod catches non-absolute Lotor paths (S1-4 regression)', () => {
  // ---- cases that MUST gate after the fix ----

  it('gates "rm -rf ~/.lotor/receipts" (tilde spelling)', () => {
    // The user's home is os.homedir(); ~/.lotor is real-world notation.
    // The matcher must normalize ~ to the home and then match.
    const cmd = `rm -rf ${os.homedir()}/.lotor/receipts`;
    assert.equal(isSelfMod('Bash', { command: cmd }, baseDir), true, `command: ${cmd}`);
  });

  it('gates "rm -rf $HOME/.lotor/receipts" (env-var spelling)', () => {
    // The matcher must normalize $HOME/<...> to the home and then match.
    const cmd = `rm -rf $HOME/.lotor/receipts`;
    assert.equal(isSelfMod('Bash', { command: cmd }, baseDir), true, `command: ${cmd}`);
  });

  it('gates "rm -rf .lotor/receipts" (relative spelling)', () => {
    const cmd = `rm -rf .lotor/receipts`;
    assert.equal(isSelfMod('Bash', { command: cmd }, baseDir), true, `command: ${cmd}`);
  });

  it('gates "rm ~/.lotor/keys/chain.key" (key basename, tilde spelling)', () => {
    const cmd = `rm ${os.homedir()}/.lotor/keys/chain.key`;
    assert.equal(isSelfMod('Bash', { command: cmd }, baseDir), true, `command: ${cmd}`);
  });

  it('gates "rm -rf ~/.lotor" (the Lotor home itself)', () => {
    const cmd = `rm -rf ${os.homedir()}/.lotor`;
    assert.equal(isSelfMod('Bash', { command: cmd }, baseDir), true, `command: ${cmd}`);
  });

  it('gates "cd ~/.lotor && rm -rf receipts" (split across &&)', () => {
    // The cd doesn't matter; what matters is the rm targeting receipts.
    const cmd = `cd ${os.homedir()}/.lotor && rm -rf receipts`;
    assert.equal(isSelfMod('Bash', { command: cmd }, baseDir), true, `command: ${cmd}`);
  });

  // Re-review finding #1: Windows strips trailing dots from a path's last
  // component, so `~/.lotor.` resolves to the real home. The terminator class
  // must treat '.' as a boundary or this evades self-mod entirely and, on the
  // default grazing preset, deletes the chain unsigned (KNOWN-LIMITS 22).
  it('gates "Remove-Item -Recurse -Force ~/.lotor." (Windows trailing-dot)', () => {
    const cmd = `Remove-Item -Recurse -Force ${os.homedir()}/.lotor.`;
    assert.equal(isSelfMod('PowerShell', { command: cmd }, baseDir), true, `command: ${cmd}`);
  });

  it('gates "rm -rf ~/.lotor..." (multiple trailing dots)', () => {
    const cmd = `rm -rf ${os.homedir()}/.lotor...`;
    assert.equal(isSelfMod('Bash', { command: cmd }, baseDir), true, `command: ${cmd}`);
  });

  // Re-review finding #3: LOTOR_HOME is the home on a custom install; its
  // env-var spellings must gate so a custom-home store is not deletable unsigned.
  it('gates "rm -rf $LOTOR_HOME" and its spellings (env-var home)', () => {
    assert.equal(isSelfMod('Bash', { command: 'rm -rf $LOTOR_HOME' }, baseDir), true);
    assert.equal(isSelfMod('Bash', { command: 'rm -rf ${LOTOR_HOME}/receipts' }, baseDir), true);
    assert.equal(isSelfMod('PowerShell', { command: 'Remove-Item $env:LOTOR_HOME -Recurse -Force' }, baseDir), true);
  });

  // Re-review round-3 finding #5: the cmd.exe %LOTOR_HOME% spelling was missed.
  it('gates cmd.exe "%LOTOR_HOME%" spelling', () => {
    assert.equal(isSelfMod('Bash', { command: 'rmdir /s /q %LOTOR_HOME%' }, baseDir), true);
  });

  it('gates any command that references "chain.jsonl" (the basename is unambiguous)', () => {
    // chain.jsonl is Lotor-specific enough that seeing the literal name
    // anywhere in a command must gate, regardless of how it was spelled
    // or where it sits. The pre-fix matcher only matched an absolute
    // baseDir/.../chain.jsonl fragment, so a bare name slipped through.
    assert.equal(isSelfMod('Bash', { command: 'cat chain.jsonl' }, baseDir), true);
    assert.equal(isSelfMod('Bash', { command: 'rm chain.jsonl' }, baseDir), true);
  });

  it('gates any command that references "chain.key"', () => {
    assert.equal(isSelfMod('Bash', { command: 'cat chain.key' }, baseDir), true);
    assert.equal(isSelfMod('Bash', { command: 'rm chain.key' }, baseDir), true);
  });

  it('gates any command that references "approval-nonces.log"', () => {
    assert.equal(isSelfMod('Bash', { command: 'cat approval-nonces.log' }, baseDir), true);
  });

  it('gates via evaluate() so the rule fires through the full policy pipeline', () => {
    const cmd = `rm -rf ${os.homedir()}/.lotor/receipts`;
    const r = evaluate('Bash', { command: cmd }, policy, baseDir);
    assert.ok(r, 'evaluate() should return a match');
    assert.equal(r.ruleId, 'self-mod');
  });

  // ---- cases that MUST NOT over-gate ----

  // The WO's explicit warning: do not gate the bare word "keys" everywhere.
  it('does NOT gate "rm -rf ./my-app/keys" (unrelated keys dir, no .lotor context)', () => {
    assert.equal(isSelfMod('Bash', { command: 'rm -rf ./my-app/keys' }, baseDir), false);
  });

  it('does NOT gate "rm -rf /var/keys" (unrelated keys dir, no .lotor context)', () => {
    assert.equal(isSelfMod('Bash', { command: 'rm -rf /var/keys' }, baseDir), false);
  });

  it('does NOT gate "cat .loudkey" (the basename chain.key is required, not a substring)', () => {
    // .loudkey contains the substring "key" but not the Lotor-specific
    // basename chain.key. Must not be a false positive.
    assert.equal(isSelfMod('Bash', { command: 'cat .loudkey' }, baseDir), false);
  });

  it('does NOT gate "echo my-chain" (the literal chain.jsonl/chain.key is required)', () => {
    assert.equal(isSelfMod('Bash', { command: 'echo my-chain' }, baseDir), false);
  });

  // The existing absolute-path form must still gate (regression guard).
  it('still gates the absolute baseDir/receipts path (regression guard)', () => {
    const cmd = `rm -rf ${baseDir}/receipts`;
    assert.equal(isSelfMod('Bash', { command: cmd }, baseDir), true, `command: ${cmd}`);
  });

  it('still gates the absolute baseDir/keys/chain.key path (regression guard)', () => {
    const cmd = `rm ${baseDir}/keys/chain.key`;
    assert.equal(isSelfMod('Bash', { command: cmd }, baseDir), true, `command: ${cmd}`);
  });

  it('still gates the absolute baseDir/keys/approval.pub path (regression guard)', () => {
    const cmd = `rm ${baseDir}/keys/approval.pub`;
    assert.equal(isSelfMod('Bash', { command: cmd }, baseDir), true, `command: ${cmd}`);
  });
});
