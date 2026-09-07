/**
 * KNOWN-LIMITS 35 — a gate decision carries no session id, so a denial cannot
 * be attributed. CLOSED 2026-09-07 at the signing sitting.
 *
 * This was a TRIPWIRE asserting the defective state (gatedAction() dropped
 * meta.sessionId; the hook never passed it). The three-part repair landed as
 * the tripwire named it, and every assertion here is the inverted one:
 *   1. src/gate/index.js: every `chain.append({ type: 'gated-action', ... })`
 *      site (denied / stale-or-mismatch / replay / approved, four of them)
 *      carries `sessionId: meta.sessionId || null,` beside `ruleId` and
 *      `heldMs`. meta stays informational: it never enters
 *      canonicalizeRequest or verifyApproval, so a session id cannot be
 *      forged into an approval and costs nothing to add.
 *   2. bin/hook-pre-tool-use.js: the three `const meta = { ruleId, heldMs };`
 *      sites became `const meta = { ruleId, heldMs, sessionId: parsed.sessionId };`.
 *   3. This file asserts the id survives on both decision paths, that an
 *      absent id lands as `null` rather than being invented, and that no
 *      bare meta site remains in the hook (a partial fix would leave some
 *      decisions attributable and others silently not, which is worse than
 *      the uniform gap).
 *
 * Attribution is still self-report at the hook's altitude: the id is whatever
 * the harness put in `session_id`. That is the same trust the session
 * receipts already run on (limit 1) and is not new here.
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

describe('KNOWN-LIMITS 35 — gate receipts carry the session id (closed 2026-09-07)', () => {
  let testDirs = [];

  beforeEach(() => { testDirs = []; });

  it('DENIED receipt carries meta.sessionId, per the ruleId/heldMs precedent', () => {
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
    // The repair: sessionId survives alongside them.
    assert.strictEqual(receipt.sessionId, 'sess-abc123',
      'gatedAction() must copy meta.sessionId onto the denial receipt (KNOWN-LIMITS 35). ' +
      'If this fails, the core fix regressed.');
  });

  it('a meta with no sessionId lands as null on the receipt, never invented', () => {
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

  it('APPROVED receipt carries meta.sessionId (same field, opposite decision path)', () => {
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
    assert.strictEqual(receipt.sessionId, 'sess-def456',
      'approved receipts must carry meta.sessionId too; both decision paths, not just denial.');
  });

  it('the hook passes sessionId in meta at every gatedAction() call site', () => {
    // Static-source check, not a live hook invocation: proves the SECOND half
    // of the repair (the caller, not just the callee) without needing to spawn
    // the actual CLI hook binary. `parsed.sessionId` is computed once near
    // the top of the file and was already used for the both-layers-permissive
    // policy-warn receipt; now it is forwarded to gatedAction's meta as well.
    const hookPath = path.join(process.cwd(), 'bin', 'hook-pre-tool-use.js');
    const src = fs.readFileSync(hookPath, 'utf8');

    // Control: the file does compute a session id and does use it elsewhere.
    assert.match(src, /const sessionId = typeof payload\.session_id/,
      'control: the hook extracts session_id from the payload');
    assert.match(src, /sessionId: parsed\.sessionId,/,
      'control: parsed.sessionId is threaded onto the policy-warn receipt');

    // No bare meta site may remain, and all three must carry the id. A count
    // between 1 and 2 on either side is a PARTIAL fix: some gate decisions
    // attributable and others silently not, which is worse than a uniform gap.
    const bareMetaSites = (src.match(/const meta = \{ ruleId, heldMs \};/g) || []).length;
    const fullMetaSites = (src.match(/const meta = \{ ruleId, heldMs, sessionId: parsed\.sessionId \};/g) || []).length;
    assert.strictEqual(bareMetaSites, 0,
      `found ${bareMetaSites} site(s) still building meta without sessionId`);
    assert.strictEqual(fullMetaSites, 3,
      `expected 3 meta sites carrying sessionId, found ${fullMetaSites}`);
  });

  it('the gate copies the id onto every gated-action receipt shape it writes (static)', () => {
    // Four append sites: denied (no token), stale-or-mismatch, replay, approved.
    const gatePath = path.join(process.cwd(), 'src', 'gate', 'index.js');
    const src = fs.readFileSync(gatePath, 'utf8');
    const appendSites = (src.match(/type: 'gated-action'/g) || []).length;
    const idSites = (src.match(/sessionId: meta\.sessionId \|\| null,/g) || []).length;
    assert.strictEqual(appendSites, 4, 'control: four gated-action receipt shapes');
    assert.strictEqual(idSites, 4, 'every one of them carries sessionId');
  });
});
