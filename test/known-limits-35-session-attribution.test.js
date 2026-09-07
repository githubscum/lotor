/**
 * KNOWN-LIMITS 35 — a gate decision carries no session id, so a denial cannot
 * be attributed. HALF LANDED 2026-09-07 at the signing sitting.
 *
 * This was a TRIPWIRE asserting the uniform defective state (gatedAction()
 * dropped meta.sessionId at every site; the hook never passed it). Five edits
 * were staged and signed. Two landed:
 *   - bin/hook-pre-tool-use.js: all three `const meta = { ruleId, heldMs };`
 *     sites became `const meta = { ruleId, heldMs, sessionId: parsed.sessionId };`
 *     (request 1725d400).
 *   - src/gate/index.js: the NO-TOKEN DENIAL receipt gained
 *     `sessionId: meta.sessionId || null,` (request 0892f44a).
 * Three did not: the stale-or-mismatch denial, the replay denial and the
 * approved receipt (requests 3614fcb7, 76404e71, b3891aac) were denied on
 * replay because spending the first gate token purged the other three
 * (KNOWN-LIMITS 73).
 *
 * So this file now asserts the PARTIAL state exactly, which the old tripwire
 * itself called "worse than the uniform gap": one receipt shape attributable,
 * three not. The assertions marked TRIPWIRE below fail again the moment the
 * remaining gate edits land, and must be inverted then, not deleted. The fully
 * inverted version is parked in the brain
 * (projects/lotor/wo/signing-2026-09-07-tests/fix6-known-limits-35-session-attribution.test.js).
 *
 * meta stays informational: it never enters canonicalizeRequest or
 * verifyApproval, so a session id cannot be forged into an approval.
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

describe('KNOWN-LIMITS 35 — gate receipts carry the session id on one shape of four (half landed 2026-09-07)', () => {
  let testDirs = [];

  beforeEach(() => { testDirs = []; });

  it('no-token DENIED receipt carries meta.sessionId, per the ruleId/heldMs precedent (landed)', () => {
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
    assert.strictEqual(receipt.ruleId, 'some-rule', 'control: ruleId already threads through meta');
    assert.strictEqual(receipt.heldMs, 12, 'control: heldMs already threads through meta');
    assert.strictEqual(receipt.sessionId, 'sess-abc123',
      'gatedAction() must copy meta.sessionId onto the no-token denial receipt (KNOWN-LIMITS 35). ' +
      'If this fails, the landed half regressed.');
  });

  it('a meta with no sessionId lands as null on the no-token denial, never invented (landed)', () => {
    const baseDir = createTempTestDir();
    testDirs.push(baseDir);
    const keypair = generateTestKeypair();
    setupTestKey(baseDir, keypair.pubB64);
    const chain = createMockChain();

    const result = gatedAction({ action: 'x', params: {} }, null, chain, baseDir, { ruleId: 'r', heldMs: 1 });
    assert.strictEqual(result.decision, 'denied');
    const receipt = chain.entries[chain.entries.length - 1].payload;
    assert.strictEqual(receipt.sessionId, null, 'absence is null, the same shape ruleId uses');
  });

  it('APPROVED receipt still drops meta.sessionId (TRIPWIRE for the unlanded b3891aac edit)', () => {
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
      'TRIPWIRE: the approved receipt does not carry meta.sessionId yet (gate edit b3891aac denied on replay, ' +
      'KNOWN-LIMITS 73). If this now fails, that edit landed: invert to sess-def456 and amend entry 35.');
  });

  it('the hook passes sessionId in meta at every gatedAction() call site (landed)', () => {
    const hookPath = path.join(process.cwd(), 'bin', 'hook-pre-tool-use.js');
    const src = fs.readFileSync(hookPath, 'utf8');

    assert.match(src, /const sessionId = typeof payload\.session_id/,
      'control: the hook extracts session_id from the payload');
    assert.match(src, /sessionId: parsed\.sessionId,/,
      'control: parsed.sessionId is threaded onto the policy-warn receipt');

    const bareMetaSites = (src.match(/const meta = \{ ruleId, heldMs \};/g) || []).length;
    const fullMetaSites = (src.match(/const meta = \{ ruleId, heldMs, sessionId: parsed\.sessionId \};/g) || []).length;
    assert.strictEqual(bareMetaSites, 0,
      `found ${bareMetaSites} site(s) still building meta without sessionId`);
    assert.strictEqual(fullMetaSites, 3,
      `expected 3 meta sites carrying sessionId, found ${fullMetaSites}`);
  });

  it('the gate copies the id onto one of the four gated-action receipt shapes (TRIPWIRE: must become four)', () => {
    // Four append sites: denied (no token), stale-or-mismatch, replay, approved.
    // Only the first carries the id today.
    const gatePath = path.join(process.cwd(), 'src', 'gate', 'index.js');
    const src = fs.readFileSync(gatePath, 'utf8');
    const appendSites = (src.match(/type: 'gated-action'/g) || []).length;
    const idSites = (src.match(/sessionId: meta\.sessionId \|\| null,/g) || []).length;
    assert.strictEqual(appendSites, 4, 'control: four gated-action receipt shapes');
    assert.strictEqual(idSites, 1,
      `TRIPWIRE: expected exactly 1 receipt shape carrying sessionId (the no-token denial), found ${idSites}. ` +
      'If this is now 4, the remaining gate edits landed: invert this and the APPROVED case above, and ' +
      'amend KNOWN-LIMITS 35 to CLOSED in the same change. If it is 2 or 3, the partial got more partial; ' +
      'record which sites in entry 35 and update this number.');
  });
});
