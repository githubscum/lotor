/**
 * KNOWN-LIMITS 82: patch-applied writes must classify like direct writes.
 *
 * `git apply`, `git am` and `patch` take their write targets from inside the
 * patch file, so the command string alone never names a protected path. The
 * gate needs the classifier to open the patch and return its targets — and to
 * fail closed when the patch source cannot be read, is piped in, stdin-fed,
 * or a process substitution. A patch the classifier cannot see must never
 * classify as a safe no-op.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchApplyTargets } from '../proposals/l82-patch-targets/patch-apply.js';

const FILES = {
  '/repo/x.patch': '--- a/src/chain/index.js\n+++ b/src/chain/index.js\n',
  '/repo/0001.mbox': [
    'From 1115 Mon Sep 17 00:00:00 2001',
    'Subject: [PATCH] gate core',
    '',
    'diff --git a/bin/gate.js b/bin/gate.js',
    '--- a/bin/gate.js',
    '+++ b/bin/gate.js',
    '',
  ].join('\n'),
  '/repo/y.patch': '--- a/src/store/chain.js\n+++ b/src/store/chain.js\n',
  '/repo/fix.diff': '--- a/src/store/chain.js\n+++ b/src/store/chain.js\n',
  '/repo/rename.patch': [
    'diff --git a/src/gate/a.js b/docs/a.js',
    'rename from src/gate/a.js',
    'rename to docs/a.js',
  ].join('\n'),
  '/repo/devnull.patch': '--- /dev/null\n+++ b/x.js\t2026-01-01\n',
  '/repo/crlf.diff': '--- a/src/store/chain.js\r\n+++ b/src/store/chain.js\r\n',
  '/repo/lf.diff': '--- a/src/store/chain.js\n+++ b/src/store/chain.js\n',
};

// Never touch real disk: anything outside the map is an unreadable patch.
const readFile = (p) => {
  if (Object.prototype.hasOwnProperty.call(FILES, p)) return FILES[p];
  throw new Error(`ENOENT: ${p}`);
};

const run = (cmd) => patchApplyTargets(cmd, '/repo', readFile);

test('git apply on a readable patch returns its targets, not fail-closed', () => {
  const r = run('git apply x.patch');
  assert.ok(r);
  assert.equal(r.failClosed, false);
  assert.ok(r.targets.includes('src/chain/index.js'));
});

test('git -C repo am reads its mbox and returns the touched file', () => {
  const r = run('git -C repo am 0001.mbox');
  assert.ok(r);
  assert.equal(r.failClosed, false);
  assert.ok(r.targets.includes('bin/gate.js'));
});

test('patch -p1 < file returns the patch targets', () => {
  const r = run('patch -p1 < fix.diff');
  assert.ok(r);
  assert.equal(r.failClosed, false);
  assert.ok(r.targets.includes('src/store/chain.js'));
});

test('patch -i <f> and --input=<f> both feed the patch file', () => {
  for (const cmd of ['patch -p1 -i fix.diff', 'patch --input=fix.diff']) {
    const r = run(cmd);
    assert.ok(r, cmd);
    assert.equal(r.failClosed, false, cmd);
    assert.ok(r.targets.includes('src/store/chain.js'), cmd);
  }
});

test('an unreadable patch source fails closed', () => {
  const r = run('git apply missing.patch');
  assert.ok(r);
  assert.equal(r.failClosed, true);
});

test('piped or bare stdin-fed reads fail closed', () => {
  const piped = run('cat x.patch | git apply');
  assert.ok(piped);
  assert.equal(piped.failClosed, true);

  const bare = run('git apply');
  assert.ok(bare);
  assert.equal(bare.failClosed, true);
});

test('process substitution fails closed', () => {
  const r = run('git apply <(curl -s http://e/x)');
  assert.ok(r);
  assert.equal(r.failClosed, true);
});

test('browsing invocations are not patch applications (unless applying anyway)', () => {
  assert.equal(run('git apply --check x.patch'), null);
  assert.equal(run('git apply --stat x.patch'), null);
  const r = run('git apply --check --apply x.patch');
  assert.notEqual(r, null);
});

test('git am --abort writes nothing', () => {
  assert.equal(run('git am --abort'), null);
});

test('patch-shaped commands that write no patch return null', () => {
  for (const cmd of [
    'npm version patch',
    'kubectl patch deploy x',
    'git add --patch',
    'git log -p',
    'echo patch notes',
    'ls',
  ]) {
    assert.equal(run(cmd), null, cmd);
  }
});

test('an inline heredoc patch needs no source and yields its own targets', () => {
  const r = run("git apply <<'EOF'\n--- a/src/chain/index.js\n+++ b/src/chain/index.js\nEOF");
  assert.ok(r);
  assert.equal(r.inline, true);
  assert.equal(r.failClosed, false);
  assert.ok(r.targets.includes('src/chain/index.js'));
});

test('rename headers put both sides in targets', () => {
  const r = run('git apply rename.patch');
  assert.ok(r);
  assert.ok(r.targets.includes('src/gate/a.js'));
  assert.ok(r.targets.includes('docs/a.js'));
});

test('/dev/null never targets; timestamp suffix after tab is dropped', () => {
  const r = run('git apply devnull.patch');
  assert.ok(r);
  assert.ok(!r.targets.includes('/dev/null'));
  assert.ok(r.targets.includes('x.js'));
});

test('a patch application in a later segment is still detected', () => {
  const r = run('ls; git apply y.patch');
  assert.ok(r);
  assert.equal(r.failClosed, false);
  assert.ok(r.targets.includes('src/store/chain.js'));
});

test('CRLF patch text parses exactly like LF', () => {
  const crlf = run('git apply crlf.diff');
  const lf = run('git apply lf.diff');
  assert.ok(crlf);
  assert.equal(crlf.failClosed, false);
  assert.deepEqual(crlf.targets, lf.targets);
  assert.ok(crlf.targets.includes('src/store/chain.js'));
});

// WO-L82-02: verbs hidden behind env assignments, wrappers and shell strings.

test('leading env assignments no longer hide the verb', () => {
  const env = run('FOO=1 git apply x.patch');
  assert.ok(env);
  assert.equal(env.failClosed, false);
  assert.ok(env.targets.includes('src/chain/index.js'));

  const two = run('A=1 B=2 patch -p1 < fix.diff');
  assert.ok(two);
  assert.equal(two.failClosed, false);
  assert.ok(two.targets.includes('src/store/chain.js'));
});

test('wrappers and chained wrappers no longer hide the verb', () => {
  const s = run('sudo -u root patch -p1 -i fix.diff');
  assert.ok(s);
  assert.equal(s.failClosed, false);
  assert.ok(s.targets.includes('src/store/chain.js'));

  const chain = run('sudo env FOO=1 git apply x.patch');
  assert.ok(chain);
  assert.equal(chain.failClosed, false);
  assert.ok(chain.targets.includes('src/chain/index.js'));

  const e = run('env A=1 git am 0001.mbox');
  assert.ok(e);
  assert.equal(e.failClosed, false);
  assert.ok(e.targets.includes('bin/gate.js'));
});

test('xargs feeds patch names from stdin, so it fails closed', () => {
  const r = run('cat l | xargs git apply');
  assert.ok(r);
  assert.equal(r.failClosed, true);
});

test('shell -c re-entry finds the inner verb', () => {
  const b = run("bash -c 'git apply x.patch'");
  assert.ok(b);
  assert.equal(b.failClosed, false);
  assert.ok(b.targets.includes('src/chain/index.js'));

  const p = run('pwsh -Command "git apply x.patch"');
  assert.ok(p);
  assert.equal(p.failClosed, false);
  assert.ok(p.targets.includes('src/chain/index.js'));
});

test('a quoted inner command split by `;` is still found', () => {
  const r = run("bash -c 'cd r; git apply x.patch'");
  assert.ok(r);
  assert.equal(r.failClosed, false);
  assert.ok(r.targets.includes('src/chain/index.js'));
});

test('sudo over a non-patch, and a bare env, are not patch applications', () => {
  assert.equal(run('sudo ls'), null);
  assert.equal(run('env'), null);
});