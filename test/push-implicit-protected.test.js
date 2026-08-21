/**
 * test/push-implicit-protected.test.js
 *
 * C3: a bare `git push` from a checked-out protected branch names no ref in
 * its text, so the string matcher never fires. The fix resolves the implicit
 * target from git state (src/policy/git-context.js) and gates when the
 * resolved target is main/master, with UNRESOLVED failing toward gating.
 *
 * PROVE-FAIL-FIRST: the bare-push case fails against the unfixed matcher,
 * which is the evidence the hole is real. The feature-branch and explicit-ref
 * controls pass before and after, so a fix cannot buy coverage by gating
 * every push (the card's out-of-bounds).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isPushProtected, isImplicitProtectedPush, evaluate } from '../src/policy/index.js';
import { resolvePushContext } from '../src/policy/git-context.js';

const cmd = command => ({ command });
const ctx = (branch, upstreamBranch, pushDefault) => ({ status: 'resolved', branch, upstreamBranch, pushDefault });
const UNRESOLVED = { status: 'unresolved', reason: 'test' };

describe('push-protected: the implicit target from a bare git push', () => {
  it('gates a bare push when the current branch is main (simple)', () => {
    assert.strictEqual(isImplicitProtectedPush(cmd('git push'), ctx('main', 'origin/main', 'simple')), true);
  });

  it('gates a bare push when the current branch is main (current)', () => {
    assert.strictEqual(isImplicitProtectedPush(cmd('git push'), ctx('main', null, 'current')), true);
  });

  it('flows free for a feature branch with a feature upstream (simple)', () => {
    assert.strictEqual(isImplicitProtectedPush(cmd('git push'), ctx('feature/x', 'origin/feature/x', 'simple')), false);
  });

  it('gates when the context cannot be resolved (fail toward gating)', () => {
    assert.strictEqual(isImplicitProtectedPush(cmd('git push'), UNRESOLVED), true);
  });

  it('allows under push.default nothing (git refuses natively; nothing can leave)', () => {
    assert.strictEqual(isImplicitProtectedPush(cmd('git push'), ctx('main', null, 'nothing')), false);
  });

  it('does not treat an explicit feature ref as implicit', () => {
    assert.strictEqual(isImplicitProtectedPush(cmd('git push origin feature/x'), ctx('main', 'origin/main', 'simple')), false);
    assert.strictEqual(isPushProtected(cmd('git push origin feature/x')), false);
  });

  it('leaves the explicit main push to the old matcher', () => {
    assert.strictEqual(isPushProtected(cmd('git push origin main')), true);
  });

  it('gates a shell-variable ref that resolves to the current protected branch', () => {
    assert.strictEqual(isImplicitProtectedPush(cmd('git push $REF'), ctx('main', 'origin/main', 'simple')), true);
  });

  it('fires through the full evaluate() pipeline with a supplied context', () => {
    const policy = { mode: 'grazing', modes: { 'push-protected': 'gate' }, matcherVersion: 1 };
    const r = evaluate('Bash', { command: 'git push' }, policy, os.tmpdir(), ctx('main', 'origin/main', 'simple'));
    assert.ok(r, 'evaluate() should return a match');
    assert.strictEqual(r.ruleId, 'push-protected');
  });
});

describe('git-context resolution: never wedge, never hang', () => {
  it('resolves to unresolved in a directory that is not a repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-c3-norepo-'));
    try {
      const r = resolvePushContext(dir);
      assert.strictEqual(r.status, 'unresolved');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves branch and push.default in a real repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-c3-repo-'));
    try {
      execFileSync('git', ['-C', dir, 'init', '-b', 'main'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'config', 'user.name', 't'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'config', 'push.default', 'current'], { stdio: 'ignore' });
      const r = resolvePushContext(dir);
      assert.strictEqual(r.status, 'resolved');
      assert.strictEqual(r.branch, 'main');
      assert.strictEqual(r.pushDefault, 'current');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves to unresolved with no upstream under simple', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-c3-simple-'));
    try {
      execFileSync('git', ['-C', dir, 'init', '-b', 'main'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
      execFileSync('git', ['-C', dir, 'config', 'user.name', 't'], { stdio: 'ignore' });
      const r = resolvePushContext(dir); // push.default defaults to simple, no upstream
      assert.strictEqual(r.status, 'unresolved');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
