/**
 * test/known-limits-pin-eol-patch.test.js
 *
 * STAGED, NOT YET LANDED. The KNOWN-LIMITS 81 fix is core (src/limits/pin.js,
 * bodyDigest), queued as proposals/l81-pin-eol.patch for the signing sitting.
 * This file proves the patch on a temp copy.
 *
 * bodyDigest hashes stripPinBlock(text) with no CRLF fold, so a CRLF checkout
 * digest differs from the LF bytes git stores. The queued patch folds CRLF to
 * LF BEFORE the strip: stripPinBlock trims blank lines with a bare-LF match,
 * so folding only after the strip would leave a CRLF checkout's digest
 * carrying the blank lines an LF checkout trims away (the pin block sits at
 * the very top of KNOWN-LIMITS.md).
 *
 * The rehearsal applies the patch to copies of the pin module under
 * os.tmpdir() -- git runs only there and in the repo-root apply --check,
 * which changes nothing -- and imports the copies, so the module itself does
 * the hashing. Nothing under src/ is written by this test.
 *
 * The assembled patch must exist at proposals/l81-pin-eol.patch before these
 * can pass; until then they fail at the patch read. Once the patch lands in
 * the core tree, the LANDED probe below skips every test here and an EOL
 * regression guard on the landed bodyDigest takes over.
 *
 * Each skip is `return t.skip(...)`: t.skip() only marks the test, it does
 * not stop the function, so without the return a landed tree went on to
 * re-apply the patch and failed with "patch does not apply".
 *
 * Line endings and the pin block markers are built structurally: no escape
 * sequences, no regex literals, and no less-than character anywhere in this
 * file.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);

// The pin block delimiters, built from character codes so this file carries
// no angle brackets at all (60 = the comment opener character, 45 = a dash,
// 62 = the comment closer character).
const OPEN_MARK = String.fromCharCode(60, 33, 45, 45);
const CLOSE_MARK = String.fromCharCode(45, 45, 62);

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATCH = path.join(repoRoot, 'proposals', 'l81-pin-eol.patch');
const PIN_PATH = path.join(repoRoot, 'src', 'limits', 'pin.js');
const LIMITS_PATH = path.join(repoRoot, 'KNOWN-LIMITS.md');

// READ ONLY peek at the live core, the same line the patch adds inside
// bodyDigest.
const LANDED = fs.readFileSync(PIN_PATH, 'utf8').includes(
  'KNOWN-LIMITS 81). The fold runs'
);

// Snapshot for the repo-unchanged check: the pin module bytes must be the
// same after this suite as before it.
const PIN_BYTES_BEFORE = fs.readFileSync(PIN_PATH);

function toLf(text) {
  return text.split(CRLF).join(LF);
}

function toCrlf(text) {
  return text.split(LF).join(CRLF);
}

// A sample log with a managed pin block at the very top and a body after it,
// the shape the real KNOWN-LIMITS.md has.
const SAMPLE_LF = [
  OPEN_MARK + ' known-limits:pin v1',
  ' This file describes commit 0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f',
  ' stamped 2026-11-15',
  ' subject: rehearsal sample',
  ' body-sha256: ' + 'a'.repeat(64),
  ' Re-stamp after updating this log: npm run limits-pin -- --stamp',
  'known-limits:pin end ' + CLOSE_MARK,
  '',
  '# Sample Log',
  '',
  'Entry one body text.',
  'Entry two body text.',
  '',
].join(LF);

const REAL_LF = toLf(fs.readFileSync(LIMITS_PATH, 'utf8'));

/**
 * bodyDigest as the module computes it with the queued patch applied if
 * `patched`. The pin module is copied (LF-normalized first so the copy's
 * starting shape does not depend on this checkout) into a temp dir marked as
 * an ESM package; if patched, git applies the patch there, the copy is
 * rewritten to the requested shape, and the copy itself computes the digest
 * when imported. The pin module imports only node builtins, so no siblings
 * are needed.
 */
async function bodyDigestOf(eol, patched) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-pin-eol-'));
  try {
    // A bare .js under os.tmpdir() would import as CommonJS.
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}' + LF);
    const destDir = path.join(tmp, 'src', 'limits');
    fs.mkdirSync(destDir, { recursive: true });
    const destPin = path.join(destDir, 'pin.js');
    fs.writeFileSync(destPin, toLf(fs.readFileSync(PIN_PATH, 'utf8')));
    if (patched) {
      execFileSync('git', ['init', '-q'], { cwd: tmp });
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: tmp });
      fs.writeFileSync(path.join(tmp, 'l81.patch'), toLf(fs.readFileSync(PATCH, 'utf8')));
      execFileSync('git', ['apply', 'l81.patch'], { cwd: tmp });
    }
    if (eol === 'crlf') {
      fs.writeFileSync(destPin, toCrlf(fs.readFileSync(destPin, 'utf8')));
    }
    const mod = await import(pathToFileURL(destPin).href);
    return mod.bodyDigest;
  } finally {
    // Windows can hold a just-imported file for a moment; retry, then let go.
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // scratch space; a leftover dir is not a test failure
    }
  }
}

// The live module, read from the repo (importing changes no bytes). This is
// the unpatched computing today's digest.
const liveMod = await import(pathToFileURL(PIN_PATH).href);
const CURRENT_DIGEST = liveMod.bodyDigest;

describe('KNOWN-LIMITS 81 pin EOL patch rehearsal (staged; proves the queued patch)', () => {
  it("the patch applies to today's source (git apply --check)", async (t) => {
    if (LANDED) return t.skip('patch landed; the landed tree carries the fold already');
    execFileSync('git', ['apply', '--check', 'proposals/l81-pin-eol.patch'], { cwd: repoRoot });
    t.diagnostic('git apply --check passed against the working tree');
  });

  it('patched: an LF digest does not move (sample and real log)', async (t) => {
    if (LANDED) return t.skip('patch landed; the landed tree carries the fold already');
    assert.ok(CURRENT_DIGEST(SAMPLE_LF), 'the live module produced no digest; the comparison would be vacuous');
    const patchedLf = await bodyDigestOf('lf', true);
    assert.equal(
      patchedLf(SAMPLE_LF),
      CURRENT_DIGEST(SAMPLE_LF),
      'patching moved the LF digest of the sample: a receipt would be silently redigested'
    );
    assert.equal(
      patchedLf(REAL_LF),
      CURRENT_DIGEST(REAL_LF),
      'patching moved the LF digest of the repo log: a receipt would be silently redigested'
    );
  });

  it('patched: LF and CRLF copies digest the same (sample and real log)', async (t) => {
    if (LANDED) return t.skip('patch landed; the landed tree carries the fold already');
    const patchedLf = await bodyDigestOf('lf', true);
    const patchedCrlf = await bodyDigestOf('crlf', true);
    assert.ok(patchedLf(SAMPLE_LF), 'the LF patched copy produced no digest; the comparison would be vacuous');
    assert.equal(patchedCrlf(SAMPLE_LF), patchedLf(SAMPLE_LF), 'the sample still moves its digest with the checkout');
    assert.equal(patchedCrlf(REAL_LF), patchedLf(REAL_LF), 'the repo log still moves its digest with the checkout');
  });

  it('unpatched control: LF and CRLF differ today (pins the bug)', async (t) => {
    if (LANDED) return t.skip('patch landed; the landed tree carries the fold already');
    const patchedLf = await bodyDigestOf('lf', true);
    assert.notEqual(
      CURRENT_DIGEST(toCrlf(SAMPLE_LF)),
      CURRENT_DIGEST(SAMPLE_LF),
      'unpatched copies already agree, so the patched tests here prove nothing (control failed)'
    );
    assert.notEqual(
      CURRENT_DIGEST(toCrlf(REAL_LF)),
      CURRENT_DIGEST(REAL_LF),
      'unpatched copies already agree on the real log, so the patched tests prove nothing (control failed)'
    );
  });

  it('patched: a non-string body digests as today (no regression)', async (t) => {
    if (LANDED) return t.skip('patch landed; the landed tree carries the fold already');
    const patchedLf = await bodyDigestOf('lf', true);
    assert.equal(
      patchedLf(undefined),
      CURRENT_DIGEST(undefined),
      'patched bodyDigest(undefined) moved: callers passing a non-string would redigest'
    );
    assert.equal(
      patchedLf(42),
      CURRENT_DIGEST(42),
      'patched bodyDigest(42) moved: callers passing a non-string would redigest'
    );
  });

  it('the repo is unchanged afterwards (pin module bytes equal before and after)', async () => {
    assert.ok(
      PIN_BYTES_BEFORE.equals(fs.readFileSync(PIN_PATH)),
      'the real pin module bytes changed during the rehearsal'
    );
  });
});
