/**
 * test/pap-sealed-patch.test.js
 *
 * STAGED, NOT YET LANDED. Sealed PAP bundles (WO-CARTRIDGE-SEAL part A) touch
 * src/publish and bin/, which are core (src/grant/core-paths.js CORE_DIRS),
 * so the change is queued as proposals/pap-sealed.patch for a signing sitting.
 * This file proves the queued patch on temp copies:
 *
 *   1. it applies to today's source, one --include per target, the shape the
 *      sitting runs (KNOWN-LIMITS 82: every target named on the command line);
 *   2. patched: test/pap-sealed.test.js passes with PAP_SEALED_REQUIRE=1, and
 *      the existing v1 suites (pap-pack, pap-qr) still pass;
 *   3. unpatched control: the same sealed suite FAILS with PAP_SEALED_REQUIRE=1
 *      (fail-first: the tests are not passing for a reason the patch does not
 *      supply).
 *
 * Copies live under os.tmpdir(); git runs only there. Nothing under src/ or
 * bin/ in this checkout is written, and no git command runs on this repo.
 * Once the patch lands, LANDED skips everything here and
 * test/pap-sealed.test.js is the guard. Each skip is `return t.skip(...)`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATCH = path.join(repoRoot, 'proposals', 'pap-sealed.patch');
const LANDED = fs.existsSync(path.join(repoRoot, 'src', 'publish', 'seal.js'));
const TARGETS = [
  'bin/pap-boot.js',
  'bin/pap-export.js',
  'bin/pap-keygen.js',
  'src/publish/manifest.js',
  'src/publish/pack.js',
  'src/publish/seal.js',
];
const SKIP = 'patch landed; test/pap-sealed.test.js is the guard now';

function copyTree(fromRel, toRoot) {
  const from = path.join(repoRoot, fromRel);
  for (const name of fs.readdirSync(from)) {
    const rel = path.join(fromRel, name);
    const src = path.join(repoRoot, rel);
    const dest = path.join(toRoot, rel);
    if (fs.statSync(src).isDirectory()) {
      copyTree(rel, toRoot);
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // LF-normalize text so the patch applies the same on an autocrlf checkout.
      if (/[.](js|mjs|json)$/.test(name)) {
        fs.writeFileSync(dest, fs.readFileSync(src, 'utf8').split(CRLF).join(LF));
      } else {
        fs.copyFileSync(src, dest);
      }
    }
  }
}

function makeCopy(patched) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-pap-sealed-patch-'));
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}' + LF);
  copyTree('src', tmp);
  copyTree('bin', tmp);
  copyTree(path.join('test-data', 'pap-vectors'), tmp);
  fs.mkdirSync(path.join(tmp, 'test'));
  for (const f of ['pap-sealed.test.js', 'pap-pack.test.js', 'pap-qr.test.js']) {
    fs.copyFileSync(path.join(repoRoot, 'test', f), path.join(tmp, 'test', f));
  }
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');
  execFileSync('git', ['init', '-q'], { cwd: tmp });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: tmp });
  if (patched) {
    fs.writeFileSync(path.join(tmp, 'pap-sealed.patch'), fs.readFileSync(PATCH, 'utf8').split(CRLF).join(LF));
    execFileSync('git', ['apply', ...TARGETS.map((p) => '--include=' + p), 'pap-sealed.patch'], { cwd: tmp });
  }
  return tmp;
}

function runSuites(root, files) {
  // A child `node --test` that inherits NODE_TEST_CONTEXT refuses to run its
  // files and exits 0 with a warning. Found by the control below on the first
  // run: that is a silent pass, so the variable is dropped here.
  const env = { ...process.env, PAP_SEALED_REQUIRE: '1' };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
  const count = (label) => {
    const line = r.stdout.split(LF).find((l) => l.startsWith('# ' + label + ' '));
    return line ? Number(line.split(' ')[2]) : NaN;
  };
  return { status: r.status, pass: count('pass'), fail: count('fail'), out: r.stdout + r.stderr };
}

function cleanup(tmp) {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // scratch space; a leftover dir is not a test failure
  }
}

describe('sealed PAP patch rehearsal (staged; proves the queued core patch)', () => {
  it("the patch applies to today's source, every target named", (t) => {
    if (LANDED) return t.skip(SKIP);
    const tmp = makeCopy(true);
    try {
      for (const rel of TARGETS) {
        assert.ok(fs.existsSync(path.join(tmp, ...rel.split('/'))), rel + ' missing after apply');
      }
      assert.ok(fs.readFileSync(path.join(tmp, 'src', 'publish', 'pack.js'), 'utf8').includes('function packSealed('));
    } finally {
      cleanup(tmp);
    }
  });

  it('patched: the sealed suite passes and the v1 suites still pass', (t) => {
    if (LANDED) return t.skip(SKIP);
    const tmp = makeCopy(true);
    try {
      const r = runSuites(tmp, ['test/pap-sealed.test.js', 'test/pap-pack.test.js', 'test/pap-qr.test.js']);
      assert.equal(r.fail, 0, r.out);
      assert.equal(r.status, 0, r.out);
      assert.ok(r.pass >= 29, 'expected at least 29 passing tests, got ' + r.pass + LF + r.out);
    } finally {
      cleanup(tmp);
    }
  });

  it('unpatched control: the sealed suite fails without the patch (fail-first)', (t) => {
    if (LANDED) return t.skip(SKIP);
    const tmp = makeCopy(false);
    try {
      const r = runSuites(tmp, ['test/pap-sealed.test.js']);
      assert.notEqual(r.status, 0, 'sealed suite passed with no patch: it proves nothing' + LF + r.out);
      assert.equal(r.pass, 0, r.out);
      assert.ok(r.fail >= 16, 'expected every sealed test to fail unpatched, got ' + r.fail);
    } finally {
      cleanup(tmp);
    }
  });
});
