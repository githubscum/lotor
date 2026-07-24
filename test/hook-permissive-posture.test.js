/**
 * test/hook-permissive-posture.test.js
 *
 * KNOWN-LIMITS 15, corrected 2026-07-24.
 *
 * The entry claimed Lotor and the harness "cannot see" each other. That was
 * an assumption nobody checked and it was false: `permission_mode` arrives
 * on every hook event and was being discarded in parsePayload(). So the one
 * combination that entry calls genuinely dangerous — Lotor in Loose plus a
 * harness that also skips tool-call review — was invisible while being
 * detectable the whole time.
 *
 * These spawn the real hook binary against a temporary LOTOR_HOME, because
 * the behaviour under test is the hook's, not a helper's. Asserting on a
 * function here would repeat the mistake that let the limit stand.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandMode } from '../src/policy/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO_ROOT, 'bin', 'hook-pre-tool-use.js');

let home;

/**
 * Write a real policy for the named preset.
 *
 * The first version of this helper wrote {version, mode} and nothing else.
 * loadPolicy() requires a `modes` object and silently falls back to the
 * default preset without one, so every policy this test wrote was grazing
 * and the condition under test was never reachable. The four negative cases
 * passed anyway, which is exactly how a suite reports green while proving
 * nothing.
 *
 * Expanding through the module's own expandMode() rather than hand-writing
 * the map means the fixture cannot drift from the presets it is imitating.
 */
function setMode(mode) {
  fs.writeFileSync(
    path.join(home, 'policy.json'),
    JSON.stringify({ version: 1, mode, modes: expandMode(mode) }, null, 2)
  );
}

function callHook({ permissionMode, sessionId = 's-posture', tool = 'Edit', input = { file_path: 'README.md' } }) {
  const payload = {
    session_id: sessionId,
    tool_name: tool,
    tool_input: input
  };
  if (permissionMode !== undefined) payload.permission_mode = permissionMode;
  return spawnSync(process.execPath, [HOOK, JSON.stringify(payload)], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, LOTOR_HOME: home }
  });
}

function warnReceipts() {
  const f = path.join(home, 'receipts', 'chain.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n')
    .map(l => { try { return JSON.parse(l).payload; } catch { return null; } })
    .filter(p => p && p.ruleId === 'both-layers-permissive');
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-posture-'));
});

after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('both layers permissive is no longer invisible', () => {
  it('warns when Loose meets a harness that skips review', () => {
    setMode('loose');
    const r = callHook({ permissionMode: 'bypassPermissions', sessionId: 's-warn' });
    assert.strictEqual(r.status, 0, 'a warning must never block the call');
    assert.match(r.stderr, /LOOSE/, 'the warning must name Lotor\'s mode');
    assert.match(r.stderr, /bypassPermissions/, 'and the harness mode it saw');
    assert.match(r.stderr, /Neither layer is stopping anything/);
  });

  it('records the posture on the chain, with both modes named', () => {
    const found = warnReceipts().filter(p => p.sessionId === 's-warn');
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].lotorMode, 'loose');
    assert.strictEqual(found[0].harnessMode, 'bypassPermissions');
  });

  it('records once per session, not once per tool call', () => {
    // In a Loose plus bypass session every call would otherwise append an
    // entry, and a log that repeats itself thousands of times is a log
    // nobody reads.
    for (let i = 0; i < 3; i++) callHook({ permissionMode: 'dontAsk', sessionId: 's-warn' });
    const found = warnReceipts().filter(p => p.sessionId === 's-warn');
    assert.strictEqual(found.length, 1, 'still exactly one entry for this session');
  });

  it('treats a different session as a different posture to record', () => {
    callHook({ permissionMode: 'auto', sessionId: 's-other' });
    assert.strictEqual(warnReceipts().filter(p => p.sessionId === 's-other').length, 1);
  });
});

describe('it stays quiet when the combination is not dangerous', () => {
  it('says nothing when the harness is prompting normally', () => {
    setMode('loose');
    const r = callHook({ permissionMode: 'default', sessionId: 's-quiet-1' });
    assert.strictEqual(r.status, 0);
    assert.doesNotMatch(r.stderr, /Neither layer is stopping anything/);
  });

  it('says nothing about acceptEdits, deliberately', () => {
    // Partial case: edits auto-accept, commands still prompt. Warning on a
    // posture that is usually reasonable is how a warning gets ignored, and
    // alarm fatigue is the same failure as approval fatigue one layer up.
    const r = callHook({ permissionMode: 'acceptEdits', sessionId: 's-quiet-2' });
    assert.doesNotMatch(r.stderr, /Neither layer is stopping anything/);
  });

  it('says nothing when Lotor is not in Loose, however open the harness is', () => {
    setMode('grazing');
    const r = callHook({ permissionMode: 'bypassPermissions', sessionId: 's-quiet-3' });
    assert.doesNotMatch(r.stderr, /Neither layer is stopping anything/);
  });

  it('says nothing when the harness reports no mode at all', () => {
    setMode('loose');
    const r = callHook({ sessionId: 's-quiet-4' });
    assert.strictEqual(r.status, 0);
    assert.doesNotMatch(r.stderr, /Neither layer is stopping anything/);
  });
});
