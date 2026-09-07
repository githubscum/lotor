/**
 * KNOWN-LIMITS 35 — a gate decision carries no session id, so a denial cannot
 * be attributed.
 *
 * This is a TRIPWIRE, not a regression guard: it asserts the CURRENT
 * defective state (gatedAction() silently drops meta.sessionId; the hook
 * never passes it) so that fixing the gap fails this test loudly instead of
 * fixing something nobody is watching (the entry-25 lesson, applied to a
 * confession instead of a heading).
 *
 * meta.ruleId and meta.heldMs already prove the pattern this fix follows:
 * "informational only, never signed" fields carried on `meta` and copied
 * onto the receipt without entering canonicalizeRequest/verifyApproval.
 * sessionId belongs in that same family.
 *
 * WHEN LIMIT 35 IS FIXED, three things change together and this file must be
 * updated in the SAME PR, not deleted:
 *   1. src/gate/index.js: all three `chain.append({ type: 'gated-action', ... })`
 *      call sites (denied / stale-or-mismatch / approved) gain
 *      `sessionId: meta.sessionId || null,` alongside the existing `ruleId`
 *      and `heldMs` lines.
 *   2. bin/hook-pre-tool-use.js: the three `const meta = { ruleId, heldMs };`
 *      sites (as of this writing, around lines 932, 958, 995) become
 *      `const meta = { ruleId, heldMs, sessionId: parsed.sessionId };` —
 *      `parsed.sessionId` is already computed at line ~109 and already used
 *      for the `both-layers-permissive` policy-warn receipt at line ~773, so
 *      no new plumbing is needed to obtain it, only to pass it through.
 *   3. Every assertion below that currently reads `undefined`/`false` inverts
 *      to read the real session id / `true`.
 *
 * Both halves are core (src/gate, bin/hook-*) per the lane's charter and
 * queue for Isaac's signing sitting; this file ships without them.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { gatedAction } from '../src/gate/index.js';
import { canonicalizeRequest } from '../src/gate/sign.js';

function generateTestKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'jwk' },
    publicKeyEncoding: { type: 'spki', format: 'jwk' }
  });
  return {
    pubB64: publicKey.x,
    privKeyObj: crypto.createPrivateKey({ key: privateKey, format: 'jwk' })
  };
}

function createTestApprovalToken(actionRequest, keypair) {
  const canonical = canonicalizeRequest(actionRequest);
  const nonce = crypto.randomBytes(12).toString('base64url');
  const timestamp = Date.now();
  const signData = { request: canonical, nonce, timestamp };
  const signBuf = Buffer.from(JSON.stringify(signData, Object.keys(signData).sort()), 'utf8');
  const sig = crypto.sign(null, signBuf, keypair.privKeyObj);
  return { request: canonical, nonce, timestamp, signature: sig.toString('hex') };
}

function createMockChain() {
  const entries = [];
  let seq = 0;
  return {
    entries,
    append(payload) {
      const entry = { seq: seq++, timestamp: Date.now(), payload, hash: crypto.randomBytes(32).toString('hex') };
      entries.push(entry);
      return entry;
    }
  };
}

function createTempTestDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-gate-sessionid-test-'));
}

function setupTestKey(baseDir, pubB64) {
  const keysDir = path.join(baseDir, 'keys');
  fs.mkdirSync(keysDir, { recursive: true });
  const fp = crypto.createHash('sha256').update(Buffer.from(pubB64, 'base64')).digest('hex').slice(0, 32);
  fs.writeFileSync(path.join(keysDir, 'approval.pub'), `ed25519:${pubB64}:fingerprint:${fp}\n`);
}

describe('KNOWN-LIMITS 35 tripwire — gate receipts carry no session id (yet)', () => {
  let testDirs = [];

  beforeEach(() => { testDirs = []; });

  it('DENIED receipt drops meta.sessionId today (fix: carry it, per ruleId/heldMs precedent)', () => {
    const baseDir = createTempTestDir();
    testDirs.push(baseDir);
    const keypair = generateTestKeypair();
    setupTestKey(baseDir, keypair.pubB64);
    const chain = createMockChain();

    const actionRequest = { action: 'delete-everything', params: {} };
    const meta = { ruleId: 'some-rule', heldMs: 12, sessionId: 'sess-abc123' };

    const result = gatedAction(actionRequest, null, chain, baseDir, meta);
    assert.strictEqual(result.decision, 'denied');

    const receipt = chain.entries[chain.entries.length - 1].payload;
    // Controls: the sibling informational fields DO already survive today.
    assert.strictEqual(receipt.ruleId, 'some-rule', 'control: ruleId already threads through meta');
    assert.strictEqual(receipt.heldMs, 12, 'control: heldMs already threads through meta');
    // The tripwire: sessionId does not, even though it was supplied.
    assert.strictEqual(receipt.sessionId, undefined,
      'TRIPWIRE: gatedAction() does not yet copy meta.sessionId onto the denial receipt (KNOWN-LIMITS 35). ' +
      'If this now fails, the core fix landed — invert this assertion to sess-abc123 and update the docstring above.');
  });

  it('APPROVED receipt drops meta.sessionId today (same gap, opposite decision path)', () => {
    const baseDir = createTempTestDir();
    testDirs.push(baseDir);
    const keypair = generateTestKeypair();
    setupTestKey(baseDir, keypair.pubB64);
    const chain = createMockChain();

    const actionRequest = { action: 'safe-action', params: {} };
    const token = createTestApprovalToken(actionRequest, keypair);
    const meta = { ruleId: 'another-rule', heldMs: 5, sessionId: 'sess-def456' };

    const result = gatedAction(actionRequest, token, chain, baseDir, meta);
    assert.strictEqual(result.decision, 'approved');

    const receipt = chain.entries[chain.entries.length - 1].payload;
    assert.strictEqual(receipt.ruleId, 'another-rule', 'control: ruleId already threads through on approval too');
    assert.strictEqual(receipt.sessionId, undefined,
      'TRIPWIRE: approved receipts also drop meta.sessionId today. ' +
      'If this now fails, invert to sess-def456 — both decision paths must carry it, not just denial.');
  });

  it('the hook never passes sessionId in meta, though it already has the value in hand', () => {
    // Static-source check, not a live hook invocation: proves the SECOND half
    // of the gap (the caller, not just the callee) without needing to spawn
    // the actual CLI hook binary. `parsed.sessionId` is computed once near
    // the top of the file and reused for the both-layers-permissive
    // policy-warn receipt — so the value is available, just not forwarded to
    // gatedAction's meta.
    const hookPath = path.join(process.cwd(), 'bin', 'hook-pre-tool-use.js');
    const src = fs.readFileSync(hookPath, 'utf8');

    // Control: the file does compute a session id and does use it elsewhere.
    assert.match(src, /const sessionId = typeof payload\.session_id/,
      'control: the hook already extracts session_id from the payload');
    assert.match(src, /sessionId: parsed\.sessionId,/,
      'control: parsed.sessionId is already threaded onto at least one receipt (policy-warn)');

    // Every `const meta = { ruleId, heldMs };` construction site feeding
    // gatedAction() is missing sessionId. If a future edit adds it to even
    // one but not all three, this count assertion catches the partial fix
    // too — it should go to zero, not stay at a smaller nonzero number.
    const bareMetaSites = (src.match(/const meta = \{ ruleId, heldMs \};/g) || []).length;
    assert.strictEqual(bareMetaSites, 3,
      `TRIPWIRE: found ${bareMetaSites} site(s) building meta without sessionId (expected 3 today). ` +
      'If this is now 0, all call sites were fixed — delete this assertion and the two above should ' +
      'also now be inverted in the same PR. If it is between 1 and 2, the fix is PARTIAL: some gate ' +
      'decisions would be attributable and others silently would not, which is worse than the ' +
      'uniform gap this test currently documents.');
  });
});
