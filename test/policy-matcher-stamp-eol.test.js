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
 * WHEN THE FIX LANDS, THIS FILE FAILS. That is the point. The repair is:
 * normalize CRLF to LF inside `matcherHashInputs()` before it is cached, bump
 * MATCHER_SCHEMA to `matcher/3` (the hashing METHOD changes, so the stamp
 * moves by construction), invert the assertions in this file, and amend the
 * KNOWN-LIMITS entry in the same change. Do NOT delete the block: a confession
 * that can be closed by deleting its evidence is not a confession.
 *
 * The fix is `src/policy` and therefore non-delegable core. It is not
 * attempted here; it queues for a signing sitting.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import crypto from 'node:crypto';
import { matcherHashInputs, matcherVersionHash } from '../src/policy/index.js';

const sha16 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const hashed = matcherHashInputs();
const lf = hashed.replace(/\r\n/g, '\n');
const crlf = lf.replace(/\n/g, '\r\n');

describe('matcher stamp line-ending dependence (tripwire)', () => {
  it('CONTROL: the hashed inputs span lines, so line endings matter', () => {
    assert.equal(lf.includes('\n'), true, 'inputs do not span lines; this file is vacuous');
    assert.ok(lf.length > 1000, 'hashed inputs are implausibly short');
  });

  it('CONFESSION (machine-independent): checkout line endings change the digest', () => {
    // The two line-ending spellings of the same logical source hash differently,
    // so the stamp is not a function of the source, only of the checkout.
    assert.notEqual(sha16(lf), sha16(crlf), 'LF and CRLF of the same source digest the same: canonicalization is already in place, invert this file');
    assert.equal(matcherVersionHash(), sha16(hashed), 'the stamp is no longer a raw digest of checkout bytes');
  });

  it('CONFESSION (structural): matcherHashInputs() does no CR-normalization', () => {
    // If the fix is in, the function body contains a `\r` literal (the replace
    // pattern) and this assertion fails. Invert it then.
    assert.doesNotMatch(
      matcherHashInputs.toString(),
      /\\r/,
      'matcherHashInputs now normalizes line endings: the fix landed, invert this file'
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