/**
 * test/policy-selfmod-settings-class.test.js
 *
 * Regression for listing 15 (BOUNTY C5) / KNOWN-LIMITS 57.
 *
 * The self-mod rule named ONE literal spelling of a Claude Code settings file:
 * `.claude/settings.json`. Claude Code reads a settings file per scope, and
 * each scope also has a local variant that carries permission rules of equal
 * power: an allow rule in `.claude/settings.local.json` suppresses prompts
 * exactly as the main file does. So an unsigned edit to the local variant
 * rewrites what the gate permits just as thoroughly.
 *
 * Measured 2026-09-15 against unpatched main: Edit, Write, NotebookEdit and a
 * shell write naming `.claude/settings.local.json` in the SAME directory as the
 * gated `.claude/settings.json` all matched no rule. Every case in the "the
 * local variant is a settings file too" block below FAILS against that main
 * and passes after `claudeSettingsHit()` classifies what the file is instead of
 * matching a remembered spelling.
 *
 * The controls beside them pin the two ways this fix could go wrong: dropping
 * the previously-gated spelling, or sweeping in files that are not settings
 * files (over-matching is its own defect: a gate that cries wolf gets turned
 * off).
 *
 * RESIDUAL, stated honestly: a settings file reached by a copy, rename or
 * symlink whose FINAL path does not carry the `.claude/settings*.json` shape is
 * not classified here; and a non-`.json` sibling such as
 * `settings.local.json.bak` is a data file, not a settings file, and is
 * deliberately not gated.
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
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-settings-class-'));
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

// The local variant of the user-scope settings file. Same directory as the
// gated spelling, same power over what prompts fire, invisible to the old rule.
const LOCAL_USER = '/home/agent/.claude/settings.local.json';
// The local variant at project scope.
const LOCAL_PROJECT = '/srv/app/.claude/settings.local.json';
// A managed (enterprise) settings file, which carries permission rules from
// outside a `.claude` directory.
const MANAGED = '/etc/claude-code/managed-settings.json';

describe('policy: the local Claude Code settings variant is a settings file too (KNOWN-LIMITS 57)', () => {
  // ---- cases that FAIL against unpatched main ----

  for (const [tool, fp] of [
    ['Edit', LOCAL_USER],
    ['Write', LOCAL_USER],
    ['NotebookEdit', LOCAL_USER],
    ['Edit', LOCAL_PROJECT],
    ['Write', LOCAL_PROJECT],
  ]) {
    it(`gates ${tool} of ${fp}`, () => {
      assert.equal(isSelfMod(tool, { file_path: fp }, baseDir), true,
        `${tool} ${fp} carries permission rules and must gate`);
    });
  }

  it('gates the Windows-separator spelling of the local variant', () => {
    assert.equal(
      isSelfMod('Edit', { file_path: 'C:\\Users\\agent\\.claude\\settings.local.json' }, baseDir),
      true
    );
  });

  it('gates any settings.<variant>.json inside a .claude directory', () => {
    assert.equal(isSelfMod('Edit', { file_path: '/srv/app/.claude/settings.enterprise.json' }, baseDir), true);
  });

  it('gates the Windows trailing-dot spelling of the local variant', () => {
    // Windows strips trailing dots from a path's last component, so this names
    // the real settings file (KNOWN-LIMITS 22).
    assert.equal(isSelfMod('Edit', { file_path: '/srv/app/.claude/settings.local.json.' }, baseDir), true);
  });

  it('gates a managed (enterprise) settings file', () => {
    assert.equal(isSelfMod('Edit', { file_path: MANAGED }, baseDir), true);
  });

  // The command half. Closing only the Edit path would let a shell write
  // rewrite the policy unsigned while the tool layer refused.
  it('gates a shell write to the local variant', () => {
    assert.equal(
      isSelfMod('Bash', { command: `sed -i s/false/true/ ${LOCAL_PROJECT}` }, baseDir),
      true
    );
  });

  it('gates a shell write to the local variant through the PowerShell tool', () => {
    assert.equal(
      isSelfMod('PowerShell', { command: `Set-Content ${LOCAL_USER} -Value '{"permissions":{}}'` }, baseDir),
      true
    );
  });

  it('gates an output redirect into the local variant', () => {
    assert.equal(isSelfMod('Bash', { command: `echo '{"allow":["Bash"]}' > ${LOCAL_PROJECT}` }, baseDir), true);
  });

  // ---- assertions through evaluate(), the entry the hook actually calls ----

  it('resolves to the self-mod rule, gated, through evaluate()', () => {
    const hit = evaluate('Edit', { file_path: LOCAL_PROJECT }, policy, baseDir);
    assert.ok(hit, 'no rule matched an unsigned edit to a settings file that carries permission rules');
    assert.equal(hit.ruleId, 'self-mod');
    assert.equal(hit.mode, 'gate');

    const cmd = evaluate('Bash', { command: `sed -i s/a/b/ ${LOCAL_USER}` }, policy, baseDir);
    assert.ok(cmd, 'no rule matched a shell edit of the same file');
    assert.equal(cmd.ruleId, 'self-mod');
  });

  // ---- controls: the fix must not drop what already gated, or over-match ----

  it('keeps gating the spelling that already gated', () => {
    assert.equal(isSelfMod('Edit', { file_path: '/home/agent/.claude/settings.json' }, baseDir), true);
    assert.equal(isSelfMod('Edit', { file_path: '.claude/settings.json' }, baseDir), true);
    assert.equal(isSelfMod('Bash', { command: 'sed -i s/a/b/ /home/agent/.claude/settings.json' }, baseDir), true);
  });

  for (const fp of [
    '/srv/app/config.json',
    '/srv/app/settings.json',
    '/srv/app/.claude/notes.json',
    '/srv/app/.claude/settings.txt',
    '/srv/app/my.claude/settings.json',
    '/srv/app/.claude/settings.local.json.bak',
  ]) {
    it(`does not gate the non-settings path ${fp}`, () => {
      assert.equal(isSelfMod('Edit', { file_path: fp }, baseDir), false,
        `${fp} is not a Claude Code settings file; gating it is a false positive`);
    });
  }
});
