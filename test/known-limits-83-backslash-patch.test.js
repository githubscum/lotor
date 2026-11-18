/**
 * test/known-limits-83-backslash-patch.test.js
 *
 * STAGED, NOT YET LANDED (WO-L83-01). The KNOWN-LIMITS 83 fix is core: it
 * edits src/grant/core-paths.js and src/policy/index.js, so it is queued as
 * proposals/l83-backslash-fold.patch for the signing sitting. This file
 * proves the queued patch on scratch space:
 *
 *   - `git apply --check` shows the patch still fits today's working tree.
 *   - The patch is APPLIED only to a temp copy of src/ (plus package.json,
 *     so the copies import as ESM), never to this repo, and the patched
 *     copies are imported dynamically.
 *   - The two real source files are byte-compared before and after the run.
 *
 * Nothing under src/ is written and no git command mutates this repo.
 *
 * Every backslash spelling is built with String.fromCharCode(92): authoring
 * channels can mangle backslash escapes (KNOWN-LIMITS 81), so this file
 * carries no escape sequences and no regex literals.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const BS = String.fromCharCode(92);

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATCH = path.join(repoRoot, 'proposals', 'l83-backslash-fold.patch');
const PKG_JSON = path.join(repoRoot, 'package.json');
const SRC_DIR = path.join(repoRoot, 'src');
const CORE_SOURCE = path.join(SRC_DIR, 'grant', 'core-paths.js');
const POLICY_SOURCE = path.join(SRC_DIR, 'policy', 'index.js');

// The two files the queued patch rewrites. They are its preimages, so they
// are the only files in the temp copy whose line endings matter.
const PATCH_TARGETS = [
  path.join('src', 'grant', 'core-paths.js'),
  path.join('src', 'policy', 'index.js')
];

function toLf(text) {
  return text.split(CRLF).join(LF);
}

// READ ONLY peek at the live core: each string only exists once the queued
// patch has landed in that file.
const GRANT_ANCHOR = 'drive-letter absolute path on a non-Windows host';
const POLICY_ANCHOR = 'candidate.split(String.fromCharCode(92))';
const LANDED =
  fs.readFileSync(CORE_SOURCE, 'utf8').indexOf(GRANT_ANCHOR) !== -1 ||
  fs.readFileSync(POLICY_SOURCE, 'utf8').indexOf(POLICY_ANCHOR) !== -1;

// Byte snapshots of the two real sources, taken before any test runs. The
// rehearsal touches them read-only; the final test holds the run to that.
const bytesBefore = {
  core: fs.readFileSync(CORE_SOURCE),
  policy: fs.readFileSync(POLICY_SOURCE)
};

function cleanupDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // scratch space; a leftover dir is not a test failure
  }
}

let patched = null;

/**
 * A temp root carrying the whole src tree plus package.json, with the queued
 * patch applied there and both modules imported from the patched copies.
 * The patch travels byte for byte, so the rehearsal sees the bytes the
 * generator wrote. The two files the patch touches are LF-normalized in the
 * copy: the queued patch is LF-only end to end (the generator reads its
 * sources LF-normalized, and .gitattributes forces proposals/*.patch to LF),
 * while this checkout's working tree is CRLF and a copied file keeps those
 * bytes. This temp repo sets core.autocrlf false, so git does no conversion
 * here and would compare the patch's LF context against a CRLF preimage byte
 * for byte. The rest of the tree is copied as it is: nothing else is
 * patched. Memoized so one copy serves all tests.
 */
async function patchedCopy() {
  if (patched) return patched;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'l83-backslash-'));
  fs.cpSync(SRC_DIR, path.join(tmp, 'src'), { recursive: true });
  fs.copyFileSync(PKG_JSON, path.join(tmp, 'package.json'));
  PATCH_TARGETS.forEach((rel) => {
    const target = path.join(tmp, rel);
    fs.writeFileSync(target, toLf(fs.readFileSync(target, 'utf8')));
  });
  execFileSync('git', ['init', '-q'], { cwd: tmp });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: tmp });
  fs.writeFileSync(path.join(tmp, 'l83.patch'), fs.readFileSync(PATCH));
  execFileSync('git', ['apply', 'l83.patch'], { cwd: tmp });
  const grant = await import(pathToFileURL(path.join(tmp, 'src', 'grant', 'core-paths.js')).href);
  const policy = await import(pathToFileURL(path.join(tmp, 'src', 'policy', 'index.js')).href);
  patched = { tmp, grant, policy };
  return patched;
}

let execCwd = null;

/** A temp cwd holding an extensionless shebang script named deploy. */
function deployCwd() {
  if (execCwd) return execCwd;
  execCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'l83-deploy-'));
  fs.writeFileSync(path.join(execCwd, 'deploy'), '#!/bin/sh' + LF + 'echo deploy' + LF, { mode: 0o755 });
  return execCwd;
}

after(() => {
  cleanupDir(patched === null ? null : patched.tmp);
  cleanupDir(execCwd);
});

describe('KNOWN-LIMITS 83 backslash-fold patch rehearsal (staged; proves the queued patch)', () => {
  it("the patch applies to today's working tree (git apply --check)", (t) => {
    if (LANDED) return t.skip('patch landed; the tree already carries the fold');
    execFileSync('git', ['apply', '--check', PATCH], { cwd: repoRoot });
  });

  it('the patch carries no CR byte: it is LF end to end', (t) => {
    if (LANDED) return t.skip('patch landed; the tree already carries the fold');
    const cr = fs.readFileSync(PATCH).indexOf(13);
    assert.equal(
      cr,
      -1,
      'the patch carries a CR byte at offset ' + cr + '. The queued patch is LF-only: a CR inside a context line does not match the preimage git compares it against, and a CR on a blank context line is a parse error'
    );
  });

  it('patched: a backslash spelling of a core file classifies as core on every host', async (t) => {
    if (LANDED) return t.skip('patch landed; the tree already carries the fold');
    const { grant, tmp } = await patchedCopy();
    const result = grant.classifyPath(['src', 'gate', 'index.js'].join(BS), tmp);
    assert.equal(result.verdict, 'core', 'verdict for src' + BS + 'gate' + BS + 'index.js after the fold');
  });

  it('patched: a drive-letter backslash path into another directory refuses on every host', async (t) => {
    if (LANDED) return t.skip('patch landed; the tree already carries the fold');
    const { grant, tmp } = await patchedCopy();
    const target = ['C:', 'other', 'repo', 'bin', 'x.js'].join(BS);
    const result = grant.classifyPath(target, tmp);
    assert.equal(result.verdict, 'refused', 'a drive-letter absolute path must refuse, not classify grantable');
  });

  it("patched: the forward-slash spelling still classifies core and a plain non-core file keeps today's verdict", async (t) => {
    if (LANDED) return t.skip('patch landed; the tree already carries the fold');
    const { grant, tmp } = await patchedCopy();
    assert.equal(grant.classifyPath('src/gate/index.js', tmp).verdict, 'core');
    // The current, unpatched module from the real repo, imported read-only.
    const current = await import(pathToFileURL(CORE_SOURCE).href);
    const plain = 'docs/x.md';
    assert.equal(
      grant.classifyPath(plain, tmp).verdict,
      current.classifyPath(plain, repoRoot).verdict,
      'the fold must not move the verdict for a plain forward-slash non-core path'
    );
  });

  it('patched policy: the Windows spelling of an extensionless script gates as opaque exec', async (t) => {
    if (LANDED) return t.skip('patch landed; the tree already carries the fold');
    const { policy } = await patchedCopy();
    const cwd = deployCwd();
    const command = '.' + BS + 'deploy';
    assert.equal(policy.isOpaqueExec({ command }, cwd), true, 'a shebang script behind a dot-backslash spelling of deploy must gate after the fold');
  });

  it('the repo is unchanged afterwards', () => {
    assert.ok(
      bytesBefore.core.equals(fs.readFileSync(CORE_SOURCE)),
      'src/grant/core-paths.js changed during the rehearsal'
    );
    assert.ok(
      bytesBefore.policy.equals(fs.readFileSync(POLICY_SOURCE)),
      'src/policy/index.js changed during the rehearsal'
    );
  });
});
