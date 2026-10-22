/**
 * test/policy-matcher-stamp-eol.test.js
 *
 * TRIPWIRE, not a regression test. It asserts CURRENT DEFECTIVE behaviour,
 * found 2026-10-19 (run 39, recorded as a KNOWN-LIMITS entry in PR #67).
 *
 * `matcherVersionHash()` is sha256 of the text `matcherHashInputs()` returns.
 * That text is joined from `Function.prototype.toString()` of the policy
 * functions, which returns source text exactly as checked out. A
 * `core.autocrlf=true` clone (Windows) holds CRLF bytes; an LF clone of the
 * same commit holds LF bytes. Measured on this machine at 5198a07: CRLF
 * checkout stamps c4165ee9ff7612bd, LF checkout e0877fab0f459e0c. Two receipts
 * written from two clones of the SAME commit therefore disagree on the matcher
 * version and the record cannot tell whether the rules changed.
 *
 * Test 2 is the proof that does not depend on this checkout: it copies the
 * policy module out twice, once LF and once CRLF, imports each copy as its own
 * ESM module, and compares the two stamps the module itself computes. It holds
 * on an LF checkout and on a CRLF one, and it fails once the stamp stops
 * depending on line endings, wherever in the module the fix is written.
 *
 * WHEN THE FIX LANDS, THIS FILE FAILS. That is the point. The repair is:
 * normalize CRLF to LF inside `matcherHashInputs()` before it is cached, bump
 * MATCHER_SCHEMA to `matcher/3` (the hashing METHOD changes; only CRLF-checkout
 * stamps move, onto the LF value), amend the KNOWN-LIMITS entry in the same
 * change, and then turn this file around test by test. Do not flip every
 * assertion blindly:
 *   - Test 1 (control): keep as is.
 *   - Test 2: change `notEqual` to `equal`. That is the regression guard from
 *     then on: the LF copy and the CRLF copy must stamp the same.
 *   - Test 3 (structural): invert it only if the fix is written as a `\r`
 *     pattern inside `matcherHashInputs()`. Otherwise delete it; test 2 holds
 *     the line.
 *   - Test 4: do NOT just flip `notEqual` to `equal`. With the fix inside
 *     `matcherHashInputs()` its inputs never contain `\r`, so the CRLF branch
 *     is never reached and an inverted test 4 would skip forever on every
 *     machine. Rewrite it to assert, without the skip, that
 *     `matcherVersionHash()` equals the LF copy's stamp from test 2: on a CRLF
 *     checkout that proves live receipts now carry the canonical stamp.
 * Do NOT delete the file: a confession that can be closed by deleting its
 * evidence is not a confession.
 *
 * The fix is `src/policy` and therefore non-delegable core. It is not
 * attempted here; it queues for a signing sitting.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { matcherHashInputs, matcherVersionHash } from '../src/policy/index.js';

const sha16 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const POLICY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'policy');

const hashed = matcherHashInputs();
const lf = hashed.replace(/\r\n/g, '\n');

/**
 * The stamp the policy module computes when its files carry `eol` line
 * endings, whatever this checkout holds. The module is copied (every .js in
 * src/policy, the working tree as it stands) into a temp dir marked as an ESM
 * package and imported from there, so the module's own matcherVersionHash
 * does the hashing: no reimplementation of the stamp. Same technique as
 * matcherHashAt in src/views/matcher-history.js (PR #67).
 */
async function stampOfCopy(eol) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-eol-tripwire-'));
  try {
    // A bare .js under os.tmpdir() would import as CommonJS.
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}\n');
    const dest = path.join(tmp, 'src', 'policy');
    fs.mkdirSync(dest, { recursive: true });
    const files = fs.readdirSync(POLICY_DIR).filter((n) => n.endsWith('.js'));
    assert.ok(files.includes('index.js'), 'src/policy/index.js not found to copy');
    for (const name of files) {
      const asLf = fs.readFileSync(path.join(POLICY_DIR, name), 'utf8').replace(/\r\n/g, '\n');
      fs.writeFileSync(path.join(dest, name), eol === 'crlf' ? asLf.replace(/\n/g, '\r\n') : asLf);
    }
    const mod = await import(pathToFileURL(path.join(dest, 'index.js')).href);
    return mod.matcherVersionHash();
  } finally {
    // Windows can hold a just-imported file for a moment; retry, then let go.
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // scratch space; a leftover dir is not a test failure
    }
  }
}

describe('matcher stamp line-ending dependence (tripwire)', () => {
  it('CONTROL: the hashed inputs span lines, so line endings matter', () => {
    assert.equal(lf.includes('\n'), true, 'inputs do not span lines; this file is vacuous');
    assert.ok(lf.length > 1000, 'hashed inputs are implausibly short');
  });

  it('CONFESSION (any checkout): the same policy source stamps differently as LF and as CRLF', async () => {
    const lfStamp = await stampOfCopy('lf');
    const crlfStamp = await stampOfCopy('crlf');
    assert.match(lfStamp, /^[0-9a-f]{16}$/);
    assert.match(crlfStamp, /^[0-9a-f]{16}$/);
    // The copies must reproduce the live stamp, or this test proves nothing
    // about the real module: this checkout is one of the two shapes.
    assert.equal(
      matcherVersionHash(),
      hashed.includes('\r') ? crlfStamp : lfStamp,
      'the copied module does not reproduce this checkout\'s live stamp; the copy is not a faithful stand-in'
    );
    assert.notEqual(
      lfStamp,
      crlfStamp,
      'the LF and CRLF copies stamp the same: line endings no longer reach the stamp, the fix landed; turn this file around (see header)'
    );
  });

  it('CONFESSION (structural): matcherHashInputs() does no CR-normalization', () => {
    // If the fix is in, the function body contains a `\r` literal (the replace
    // pattern) and this assertion fails. See the header for what to do then.
    assert.doesNotMatch(
      matcherHashInputs.toString(),
      /\\r/,
      'matcherHashInputs now normalizes line endings: the fix landed, see the header'
    );
  });

  it('CONFESSION (this checkout only): a CRLF clone stamps a value an LF clone cannot reproduce', (t) => {
    if (hashed.includes('\r')) {
      assert.notEqual(
        matcherVersionHash(),
        sha16(lf),
        'this checkout stamps CRLF bytes; the LF-normalized digest differs, so the stamp is checkout-dependent'
      );
    } else {
      t.skip('LF checkout: the stamp already equals the LF value here');
    }
  });
});
