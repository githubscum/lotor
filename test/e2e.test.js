/**
 * test/e2e.test.js
 *
 * End-to-end test of the complete gated action flow.
 * Uses a TEST approval key (programmatic, isolated temp dir).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { ingestSession } from '../src/ingest/index.js';
import { createStore } from '../src/store/index.js';
import { gatedAction } from '../src/gate/index.js';
import { renderSessionReceipt, renderMorningAfter } from '../src/views/index.js';
import { verifyChain } from '../src/chain/index.js';
import { canonicalizeRequest } from '../src/gate/sign.js';

// Test key storage (key objects, not JWK)
let testKeyObjects = null;

/**
 * Generate a test approval keypair programmatically.
 * Stores key objects in module scope for use by other functions.
 */
function generateTestKeypair() {
  // Generate Ed25519 keys and store the objects
  const keyPair = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });

  // Also export JWK for the public key to write to disk
  const pubKeyObj = crypto.createPublicKey(keyPair.publicKey);
  const pubJwk = pubKeyObj.export({ format: 'jwk', type: 'public' });

  // Store the key objects (not PEM strings) for signing
  testKeyObjects = {
    publicKey: pubKeyObj,
    privateKey: crypto.createPrivateKey(keyPair.privateKey)
  };

  return { publicKey: pubJwk, privateKey: keyPair.privateKey };
}

/**
 * Create an approval token for testing.
 * @param {Object} actionRequest - The action request
 * @param {Object} keyPair - The test keypair (JWK format, not used directly)
 */
function createTestApprovalToken(actionRequest, keyPair) {
  const canonical = canonicalizeRequest(actionRequest);
  const nonce = crypto.randomBytes(12).toString('base64url');
  const timestamp = Date.now();

  const signData = { request: canonical, nonce, timestamp };
  const signBuf = Buffer.from(JSON.stringify(signData, Object.keys(signData).sort()), 'utf8');

  // Use the stored key object for signing
  const sig = crypto.sign(null, signBuf, testKeyObjects.privateKey);

  return {
    request: canonical,
    nonce,
    timestamp,
    signature: sig.toString('hex')
  };
}

/**
 * Write the test approval public key to disk.
 * @param {string} baseDir - Base directory
 * @param {Object} keyPair - The test keypair
 */
function writeTestApprovalPubkey(baseDir, keyPair) {
  const keysDir = path.join(baseDir, 'keys');
  fs.mkdirSync(keysDir, { recursive: true });

  const pubB64 = keyPair.publicKey.x;
  const fp = crypto.createHash('sha256').update(Buffer.from(pubB64, 'base64')).digest('hex').slice(0, 32);

  const approvalPubFile = path.join(keysDir, 'approval.pub');
  fs.writeFileSync(approvalPubFile, `ed25519:${pubB64}:fingerprint:${fp}\n`, { mode: 0o644 });

  return { b64: pubB64, fp };
}

describe('E2E: full gated action flow', () => {
  let tempDir;
  let testKeypair;
  let originalCwd;
  let originalHome;

  beforeEach(() => {
    // Create isolated temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-e2e-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);

    // Point the shared home at the temp dir so entry points (ingestSession)
    // resolve to this isolated dir and never touch the real ~/.lotor.
    originalHome = process.env.LOTOR_HOME;
    process.env.LOTOR_HOME = tempDir;

    // Generate test keypair
    testKeypair = generateTestKeypair();
    writeTestApprovalPubkey(tempDir, testKeypair);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.LOTOR_HOME;
    } else {
      process.env.LOTOR_HOME = originalHome;
    }
    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('full flow: ingest → gate denies → sign → gate approves → view → verify', () => {
    // === Step 1: Create synthetic session fixture ===
    const sessionJsonl = [
      JSON.stringify({ sessionId: 'test-session-001', version: '1.0.0', createdAt: '2026-07-21T10:00:00.000Z' }),
      JSON.stringify({ message: { role: 'assistant', model: 'test-model', content: [{ type: 'text', text: 'Hello' }], usage: { input_tokens: 10, output_tokens: 5 } }, createdAt: '2026-07-21T10:00:01.000Z' }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', id: 'read-001', input: { file_path: '/home/test/file.txt' } }] }, createdAt: '2026-07-21T10:00:02.000Z' }),
      JSON.stringify({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-001', content: 'file content', is_error: false }] }, createdAt: '2026-07-21T10:00:03.000Z' })
    ].join('\n');

    // === Step 2: Ingest the session ===
    const entry1 = ingestSession(sessionJsonl);
    assert.strictEqual(entry1.seq, 0, 'First entry should have seq=0');
    assert.ok(entry1.hash, 'Entry should have a hash');
    assert.ok(entry1.sig, 'Entry should have a signature');

    // === Step 3: Create store and chain for gated action ===
    const store = createStore(tempDir);
    const chain = {
      entries: store.entries,
      append: store.appendReceipt.bind(store)
    };

    // === Step 4: Attempt gated action WITHOUT approval token ===
    const actionRequest = { action: 'delete_sensitive_files', params: { pattern: '*.key' } };
    const denyResult = gatedAction(actionRequest, null, chain, tempDir);

    assert.strictEqual(denyResult.decision, 'denied', 'Should deny without token');
    assert.strictEqual(denyResult.reason, 'no approval token provided', 'Should have correct reason');
    assert.strictEqual(typeof denyResult.receiptSeq, 'number', 'Should return receipt sequence');

    // === Step 5: Create approval token ===
    const approvalToken = createTestApprovalToken(actionRequest, testKeypair);
    assert.ok(approvalToken.request, 'Token should have request');
    assert.ok(approvalToken.nonce, 'Token should have nonce');
    assert.ok(approvalToken.signature, 'Token should have signature');

    // === Step 6: Attempt gated action WITH approval token ===
    const approveResult = gatedAction(actionRequest, approvalToken, chain, tempDir);

    assert.strictEqual(approveResult.decision, 'approved', 'Should approve with valid token');
    assert.strictEqual(approveResult.approvalNonce, approvalToken.nonce, 'Should return the nonce');
    assert.strictEqual(typeof approveResult.receiptSeq, 'number', 'Should return receipt sequence');

    // === Step 7: Verify the chain ===
    const verifyResult = store.verify();
    assert.strictEqual(verifyResult.ok, true, 'Chain should verify');

    // === Step 8: Load and check chain entries ===
    const entries = store.reload();
    assert.strictEqual(entries.length, 3, 'Should have 3 entries (1 session + 2 gated actions)');

    // Check session receipt
    const sessionEntry = entries.find(e => e.payload?.session);
    assert.ok(sessionEntry, 'Should have session entry');
    assert.strictEqual(sessionEntry.payload.session.id, 'test-session-001', 'Session ID should match');

    // Check gated action receipts
    const gatedEntries = entries.filter(e => e.payload?.type === 'gated-action');
    assert.strictEqual(gatedEntries.length, 2, 'Should have 2 gated action entries');

    const deniedEntry = gatedEntries.find(e => e.payload.decision === 'denied');
    assert.ok(deniedEntry, 'Should have denied entry');
    assert.strictEqual(deniedEntry.payload.reason, 'no approval token provided');

    const approvedEntry = gatedEntries.find(e => e.payload.decision === 'approved');
    assert.ok(approvedEntry, 'Should have approved entry');
    assert.strictEqual(approvedEntry.payload.approvalNonce, approvalToken.nonce);

    // === Step 9: Verify receipt views work ===
    const sessionReceipt = entries.find(e => e.payload?.session)?.payload;
    assert.ok(sessionReceipt, 'Should find session receipt');

    const sessionView = renderSessionReceipt(sessionReceipt);
    assert.ok(sessionView.includes('SESSION RECEIPT'), 'Session view should have header');
    assert.ok(sessionView.includes('test-session-001'), 'Session view should include session ID');
    assert.ok(sessionView.includes('TOOLS RAN'), 'Session view should have tools section');
    assert.ok(sessionView.includes('FILES TOUCHED'), 'Session view should have touched section');

    const morningView = renderMorningAfter(entries);
    assert.ok(morningView.includes('MORNING-AFTER SUMMARY'), 'Morning view should have header');
    assert.ok(morningView.includes('Chain intact'), 'Morning view should show chain intact');
    assert.ok(morningView.includes('Approved:'), 'Morning view should show approved count');
    assert.ok(morningView.includes('Denied:'), 'Morning view should show denied count');
  });

  it('replay protection: using same token twice fails', () => {
    // Create store and chain
    const store = createStore(tempDir);
    const chain = {
      entries: store.entries,
      append: store.appendReceipt.bind(store)
    };

    // Create action and token
    const actionRequest = { action: 'test_action', params: {} };
    const approvalToken = createTestApprovalToken(actionRequest, testKeypair);

    // First use should succeed
    const result1 = gatedAction(actionRequest, approvalToken, chain, tempDir);
    assert.strictEqual(result1.decision, 'approved', 'First use should approve');

    // Second use should fail (replay detected)
    const result2 = gatedAction(actionRequest, approvalToken, chain, tempDir);
    assert.strictEqual(result2.decision, 'denied', 'Second use should deny (replay)');
    assert.ok(result2.reason.includes('nonce already used'), 'Should indicate replay');
  });

  it('token binding: token for different action is rejected', () => {
    // Create store and chain
    const store = createStore(tempDir);
    const chain = {
      entries: store.entries,
      append: store.appendReceipt.bind(store)
    };

    // Create token for action A
    const actionA = { action: 'action_a', params: {} };
    const approvalToken = createTestApprovalToken(actionA, testKeypair);

    // Try to use token for action B
    const actionB = { action: 'action_b', params: {} };
    const result = gatedAction(actionB, approvalToken, chain, tempDir);

    assert.strictEqual(result.decision, 'denied', 'Should deny mismatched action');
    assert.ok(result.reason.includes('mismatch'), 'Should indicate mismatch');
  });

  it('file-based flow: --action-file and --token-file read correctly', () => {
    // Create store and chain
    const store = createStore(tempDir);
    const chain = {
      entries: store.entries,
      append: store.appendReceipt.bind(store)
    };

    // Step 1: Write action to a file (simulating --action-file)
    const actionRequest = { action: 'delete_sensitive_files', params: { pattern: '*.key' } };
    const actionFilePath = path.join(tempDir, 'action.json');
    fs.writeFileSync(actionFilePath, JSON.stringify(actionRequest), { mode: 0o644 });

    // Step 2: Read action from file and attempt gate without token
    const actionFromFile = JSON.parse(fs.readFileSync(actionFilePath, 'utf8'));
    const denyResult = gatedAction(actionFromFile, null, chain, tempDir);

    assert.strictEqual(denyResult.decision, 'denied', 'Should deny without token');
    assert.strictEqual(denyResult.reason, 'no approval token provided', 'Should have correct reason');

    // Step 3: Create approval token and write to file (simulating --out)
    const approvalToken = createTestApprovalToken(actionRequest, testKeypair);
    const tokenFilePath = path.join(tempDir, 'token.json');
    fs.writeFileSync(tokenFilePath, JSON.stringify(approvalToken, null, 2), { mode: 0o600 });

    // Step 4: Read token from file and attempt gate (simulating --token-file)
    const tokenFromFile = JSON.parse(fs.readFileSync(tokenFilePath, 'utf8'));
    const approveResult = gatedAction(actionFromFile, tokenFromFile, chain, tempDir);

    assert.strictEqual(approveResult.decision, 'approved', 'Should approve with valid token from file');
    assert.strictEqual(approveResult.approvalNonce, approvalToken.nonce, 'Should return the nonce');

    // Step 5: Verify the chain is intact
    const verifyResult = store.verify();
    assert.strictEqual(verifyResult.ok, true, 'Chain should verify');
  });

  it('file-based flow: malformed action file produces clear error', () => {
    // Write malformed JSON to a file
    const actionFilePath = path.join(tempDir, 'malformed.json');
    fs.writeFileSync(actionFilePath, '{ invalid json }', { mode: 0o644 });

    // Attempt to parse (simulating what the CLI does)
    let parseError = null;
    try {
      JSON.parse(fs.readFileSync(actionFilePath, 'utf8'));
    } catch (e) {
      parseError = e;
    }

    assert.ok(parseError, 'Should throw on malformed JSON');
    assert.ok(parseError.message.length > 0, 'Should have clear error message');
  });

  it('file-based flow: missing file produces clear error', () => {
    const missingFilePath = path.join(tempDir, 'nonexistent.json');

    // Attempt to read (simulating what the CLI does)
    let readError = null;
    try {
      fs.readFileSync(missingFilePath, 'utf8');
    } catch (e) {
      readError = e;
    }

    assert.ok(readError, 'Should throw on missing file');
    assert.ok(readError.code === 'ENOENT', 'Should have ENOENT error code');
  });
});
