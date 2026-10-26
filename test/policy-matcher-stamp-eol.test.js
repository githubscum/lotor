/**
 * test/policy-matcher-stamp-eol.test.js
 *
 * REGRESSION GUARD. Until 2026-10-25 this file was a tripwire asserting defective behaviour,
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
 * The fix landed 2026-10-25 (matcher/3): matcherHashInputs() folds CRLF to LF
 * before caching. Test 2 now asserts the LF and CRLF copies stamp the same;
 * the structural test 3 was deleted because the fix is written with
 * String.fromCharCode, not a pattern; test 4 asserts the live stamp equals
 * the LF copy's stamp on any checkout.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { matcherHashInputs, matcherVersionHash } from '../src/policy/index.js';

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

describe('matcher stamp line-ending independence', () => {
  it('CONTROL: the hashed inputs span lines, so line endings matter', () => {
    assert.equal(lf.includes('\n'), true, 'inputs do not span lines; this file is vacuous');
    assert.ok(lf.length > 1000, 'hashed inputs are implausibly short');
  });

  it('GUARD (any checkout): the same policy source stamps the same as LF and as CRLF', async () => {
    const lfStamp = await stampOfCopy('lf');
    const crlfStamp = await stampOfCopy('crlf');
    assert.match(lfStamp, /^[0-9a-f]{16}$/);
    assert.match(crlfStamp, /^[0-9a-f]{16}$/);
    assert.equal(
      lfStamp,
      crlfStamp,
      'the LF and CRLF copies stamp differently: line endings reach the stamp again (KNOWN-LIMITS 77)'
    );
  });

  it('GUARD (this checkout): the live stamp equals the LF copy stamp', async () => {
    assert.equal(
      matcherVersionHash(),
      await stampOfCopy('lf'),
      'this checkout stamps a value an LF clone of the same source cannot reproduce'
    );
  });
});
