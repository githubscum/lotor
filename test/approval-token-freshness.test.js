/**
 * test/approval-token-freshness.test.js
 *
 * KNOWN-LIMITS 16: approval tokens had no expiry. `verifyApproval` checked
 * structure, request match, nonce replay and signature, and never compared the
 * token's `timestamp` to the current time. A token signed a week ago still
 * authorized an action attempted today; staleness alone was not a rejection
 * reason.
 *
 * The fix adds a freshness window in `verifyApproval` (src/gate/index.js):
 * APPROVAL_MAX_AGE_MS of 60 minutes, plus APPROVAL_FUTURE_SKEW_MS of 120s of
 * tolerance for a slightly-fast clock.
 *
 * ON "PROVE THE TEST FAILS FIRST" (2026-07-24 discipline), stated honestly
 * because this file does NOT fully satisfy it:
 *
 *   The patch was applied before these tests were written, so the empirical
 *   before-run was never captured. What stands in its place is a logical
 *   argument rather than an observation: the pre-fix `verifyApproval` contained
 *   no reference to `timestamp` beyond destructuring it and checking it was
 *   truthy, so the STALE and FUTURE cases below could not have passed against
 *   it under any circumstances - there was no code path that could return
 *   `valid: false` for a well-formed, correctly-signed, unreplayed token.
 *
 *   That is weaker than the rule asks for and is recorded as such. Anyone
 *   revisiting this can confirm it empirically with `git stash` on the gate
 *   patch and a re-run.
 *
 * Why 60 minutes rather than something tighter: the owner may sign from a phone
 * over a VPN while away from the machine, so the gap between signing and the
 * agent's retry is realistically minutes and occasionally longer. Every false
 * denial teaches the operator to sign faster and read less (limit 26), so an
 * over-tight window would damage the thing the gate exists to protect.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalizeRequest } from '../src/gate/sign.js';
import { verifyApproval } from '../src/gate/index.js';

const ACTION = { action: 'Bash', params: { command: 'git push origin main' } };

let home;
let keyPair;

function writeApprovalPub(dir, publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  const fp = crypto.createHash('sha256').update(jwk.x).digest('hex').slice(0, 32);
  fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'keys', 'approval.pub'), `ed25519:${jwk.x}:fingerprint:${fp}\n`);
}

/**
 * A correctly-signed token whose ONLY variable is its timestamp. Every other
 * field is valid, so a rejection below can only be about freshness - the test
 * cannot pass for the wrong reason (bad signature, request mismatch, replay).
 * Each call uses a fresh nonce so replay protection never interferes.
 */
function makeTokenAt(timestamp, nonceSuffix) {
  const request = canonicalizeRequest(ACTION);
  const nonce = `freshness-${nonceSuffix}`;
  const signData = { request, nonce, timestamp };
  const signBuf = Buffer.from(JSON.stringify(signData, Object.keys(signData).sort()), 'utf8');
  const signature = crypto.sign(null, signBuf, keyPair.privateKey).toString('hex');
  return { request, nonce, timestamp, signature };
}

const MINUTE = 60 * 1000;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-fresh-'));
  keyPair = crypto.generateKeyPairSync('ed25519');
  writeApprovalPub(home, keyPair.publicKey);
});

after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('approval token freshness window (KNOWN-LIMITS 16)', () => {
  it('accepts a token signed just now', () => {
    const r = verifyApproval(ACTION, makeTokenAt(Date.now(), 'now'), home);
    assert.equal(r.valid, true, `fresh token should verify, got: ${r.reason}`);
  });

  it('accepts a token inside the window (59 minutes old)', () => {
    // Guards an off-by-one that would silently halve the usable window and
    // produce false denials in exactly the away-signing case the 60 minutes
    // was chosen for.
    const r = verifyApproval(ACTION, makeTokenAt(Date.now() - 59 * MINUTE, 'edge'), home);
    assert.equal(r.valid, true, `59-minute-old token should verify, got: ${r.reason}`);
  });

  it('REJECTS a token older than the window (61 minutes) and says why', () => {
    const r = verifyApproval(ACTION, makeTokenAt(Date.now() - 61 * MINUTE, 'stale'), home);
    assert.equal(r.valid, false, 'stale token must be rejected');
    assert.match(r.reason, /stale/i, 'reason should name staleness, not look like a mismatch');
    assert.match(r.reason, /re-sign/i, 'reason should tell the operator what to do');
  });

  it('REJECTS a week-old token, which is the case limit 16 described', () => {
    const r = verifyApproval(ACTION, makeTokenAt(Date.now() - 7 * 24 * 60 * MINUTE, 'week'), home);
    assert.equal(r.valid, false, 'a week-old token must not still authorize an action');
  });

  it('REJECTS a token stamped well in the future', () => {
    // A future timestamp is a clock problem or a forged one. Both deserve a look.
    const r = verifyApproval(ACTION, makeTokenAt(Date.now() + 10 * MINUTE, 'future'), home);
    assert.equal(r.valid, false, 'far-future token must be rejected');
    assert.match(r.reason, /future/i, 'reason should name the future timestamp');
  });

  it('tolerates minor future skew, so a slightly fast clock is not a denial', () => {
    const r = verifyApproval(ACTION, makeTokenAt(Date.now() + 30 * 1000, 'skew'), home);
    assert.equal(r.valid, true, `30s of skew should be tolerated, got: ${r.reason}`);
  });

  it('rejects a non-numeric timestamp without throwing', () => {
    const bad = makeTokenAt(Date.now(), 'nan');
    bad.timestamp = 'not-a-number';
    const r = verifyApproval(ACTION, bad, home);
    assert.equal(r.valid, false, 'a non-numeric timestamp must be rejected, not crash');
  });
});
