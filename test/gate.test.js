import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { gatedAction, verifyApproval, isApprovalKeyInitialized } from '../src/gate/index.js';
import {
  canonicalizeRequest
} from '../src/gate/sign.js';

// Synthetic test keypair (NEVER use for real approvals)
// We generate using Node's crypto and export to JWK for test use

/**
 * Generate a test approval keypair.
 * Returns { publicKeyJwk, privateKeyJwk, pubB64, privKeyObj, pubKeyObj }
 */
function generateTestKeypair() {
  // Generate a fresh Ed25519 keypair using Node.js crypto
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'jwk' },
    publicKeyEncoding: { type: 'spki', format: 'jwk' }
  });

  return {
    publicKeyJwk: publicKey,
    privateKeyJwk: privateKey,
    pubB64: publicKey.x,
    privKeyObj: crypto.createPrivateKey({ key: privateKey, format: 'jwk' }),
    pubKeyObj: crypto.createPublicKey({ key: publicKey, format: 'jwk' })
  };
}

/**
 * Create a synthetic approval token for testing.
 */
function createTestApprovalToken(actionRequest, keypair) {
  const canonical = canonicalizeRequest(actionRequest);
  const nonce = crypto.randomBytes(12).toString('base64url');
  const timestamp = Date.now();

  const signData = { request: canonical, nonce, timestamp };
  const signBuf = Buffer.from(JSON.stringify(signData, Object.keys(signData).sort()), 'utf8');

  const sig = crypto.sign(null, signBuf, keypair.privKeyObj);

  return {
    request: canonical,
    nonce,
    timestamp,
    signature: sig.toString('hex')
  };
}

/**
 * Create a mock chain for testing.
 */
function createMockChain() {
  const entries = [];
  let seq = 0;
  return {
    entries,
    append(payload) {
      const entry = {
        seq: seq++,
        timestamp: Date.now(),
        payload,
        hash: crypto.randomBytes(32).toString('hex')
      };
      entries.push(entry);
      return entry;
    }
  };
}

// Use isolated temp directories for each test
function createTempTestDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-receipts-gate-test-'));
}

describe('gate', () => {
  let testKeypair;
  let mockChain;
  let testDirs = [];

  beforeEach(() => {
    testKeypair = generateTestKeypair();
    mockChain = createMockChain();
  });

  afterEach(() => {
    // Clean up all test directories
    for (const dir of testDirs) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    testDirs = [];
  });

  function setupTestKey(baseDir) {
    // Create keys directory and write test public key
    const keysDir = path.join(baseDir, 'keys');
    fs.mkdirSync(keysDir, { recursive: true });

    const fp = crypto.createHash('sha256').update(Buffer.from(testKeypair.pubB64, 'base64')).digest('hex').slice(0, 32);
    fs.writeFileSync(path.join(keysDir, 'approval.pub'), `ed25519:${testKeypair.pubB64}:fingerprint:${fp}\n`);
  }

  describe('verifyApproval', () => {
    it('should return valid=true for correct token', () => {
      const baseDir = createTempTestDir();
      testDirs.push(baseDir);
      setupTestKey(baseDir);

      const actionRequest = { action: 'test-action', params: { key: 'value' } };
      const token = createTestApprovalToken(actionRequest, testKeypair);

      const result = verifyApproval(actionRequest, token, baseDir);
      assert.strictEqual(result.valid, true, 'token should be valid');
    });

    it('should return valid=false for forged/wrong-key signature', () => {
      const baseDir = createTempTestDir();
      testDirs.push(baseDir);
      setupTestKey(baseDir);

      const actionRequest = { action: 'test-action', params: {} };

      // Generate a completely different keypair to simulate an attacker
      const attackerKeypair = generateTestKeypair();

      const token = createTestApprovalToken(actionRequest, attackerKeypair);

      const result = verifyApproval(actionRequest, token, baseDir);
      assert.strictEqual(result.valid, false, 'wrong key should fail verification');
      assert.ok(result.reason.includes('signature'), 'should mention signature failure');
    });

    it('should return valid=false for mismatched action (token for action A presented for action B)', () => {
      const baseDir = createTempTestDir();
      testDirs.push(baseDir);
      setupTestKey(baseDir);

      const actionRequestA = { action: 'action-A', params: {} };
      const actionRequestB = { action: 'action-B', params: {} };
      const token = createTestApprovalToken(actionRequestA, testKeypair);

      const result = verifyApproval(actionRequestB, token, baseDir);
      assert.strictEqual(result.valid, false, 'mismatched action should fail');
      assert.ok(result.reason.includes('mismatch'), 'should mention request mismatch');
    });

    it('should return valid=false for replayed nonce', () => {
      const baseDir = createTempTestDir();
      testDirs.push(baseDir);
      setupTestKey(baseDir);

      const actionRequest = { action: 'test-action', params: {} };
      const token = createTestApprovalToken(actionRequest, testKeypair);

      // First verification should succeed
      const result1 = verifyApproval(actionRequest, token, baseDir);
      assert.strictEqual(result1.valid, true, 'first use should be valid');

      // Record the nonce (simulating that the first approval was consumed)
      const nonceLog = path.join(baseDir, 'keys', 'approval-nonces.log');
      fs.appendFileSync(nonceLog, token.nonce + '\n');

      // Second verification should fail (replay)
      const result2 = verifyApproval(actionRequest, token, baseDir);
      assert.strictEqual(result2.valid, false, 'replay should be rejected');
      assert.ok(result2.reason.includes('replay'), 'should mention replay');
    });
  });

  describe('gatedAction', () => {
    it('should DENY when no approval token provided', () => {
      const baseDir = createTempTestDir();
      testDirs.push(baseDir);
      setupTestKey(baseDir);

      const actionRequest = { action: 'delete-everything', params: {} };

      const result = gatedAction(actionRequest, null, mockChain, baseDir);

      assert.strictEqual(result.decision, 'denied', 'should deny without token');
      assert.strictEqual(result.reason, 'no approval token provided', 'should indicate missing token');
      assert.ok(result.receiptSeq !== undefined, 'should have receiptSeq');

      // Verify denial receipt was appended
      const lastEntry = mockChain.entries[mockChain.entries.length - 1];
      assert.strictEqual(lastEntry.payload.type, 'gated-action');
      assert.strictEqual(lastEntry.payload.decision, 'denied');
      assert.strictEqual(lastEntry.payload.action, 'delete-everything');
    });

    it('should DENY for forged/wrong-key signature (fail closed)', () => {
      const baseDir = createTempTestDir();
      testDirs.push(baseDir);
      setupTestKey(baseDir);

      const actionRequest = { action: 'sensitive-action', params: {} };

      // Generate a completely different keypair to simulate an attacker
      const attackerKeypair = generateTestKeypair();
      const forgedToken = createTestApprovalToken(actionRequest, attackerKeypair);

      const result = gatedAction(actionRequest, forgedToken, mockChain, baseDir);

      assert.strictEqual(result.decision, 'denied', 'should deny forged token');
      assert.ok(result.reason.includes('signature'), 'should indicate signature failure');
      assert.ok(result.receiptSeq !== undefined, 'should have receiptSeq');

      // Verify denial receipt was appended
      const lastEntry = mockChain.entries[mockChain.entries.length - 1];
      assert.strictEqual(lastEntry.payload.decision, 'denied');
    });

    it('should DENY when signature for action A presented for action B', () => {
      const baseDir = createTempTestDir();
      testDirs.push(baseDir);
      setupTestKey(baseDir);

      const actionA = { action: 'safe-action', params: {} };
      const actionB = { action: 'dangerous-action', params: {} };
      const tokenForA = createTestApprovalToken(actionA, testKeypair);

      const result = gatedAction(actionB, tokenForA, mockChain, baseDir);

      assert.strictEqual(result.decision, 'denied', 'should deny mismatched action');
      assert.ok(result.reason.includes('mismatch'), 'should indicate mismatch');

      // Verify denial receipt was appended
      const lastEntry = mockChain.entries[mockChain.entries.length - 1];
      assert.strictEqual(lastEntry.payload.decision, 'denied');
    });

    it('should DENY for replayed nonce (same valid token twice)', () => {
      const baseDir = createTempTestDir();
      testDirs.push(baseDir);
      setupTestKey(baseDir);

      const actionRequest = { action: 'test-action', params: {} };
      const token = createTestApprovalToken(actionRequest, testKeypair);

      // First use: should succeed
      const result1 = gatedAction(actionRequest, token, mockChain, baseDir);
      assert.strictEqual(result1.decision, 'approved', 'first use should approve');

      // Second use: should deny (replay)
      const result2 = gatedAction(actionRequest, token, mockChain, baseDir);
      assert.strictEqual(result2.decision, 'denied', 'second use should deny (replay)');
      assert.ok(result2.reason.includes('replay') || result2.reason.includes('nonce'), 'should indicate replay');
    });

    it('should APPROVE for valid token and append approval receipt', () => {
      const baseDir = createTempTestDir();
      testDirs.push(baseDir);
      setupTestKey(baseDir);

      const actionRequest = { action: 'permitted-action', params: { target: 'file.txt' } };
      const token = createTestApprovalToken(actionRequest, testKeypair);

      const result = gatedAction(actionRequest, token, mockChain, baseDir);

      assert.strictEqual(result.decision, 'approved', 'should approve valid token');
      assert.ok(result.approvalNonce, 'should have approvalNonce');
      assert.ok(result.receiptSeq !== undefined, 'should have receiptSeq');

      // Verify approval receipt was appended
      const lastEntry = mockChain.entries[mockChain.entries.length - 1];
      assert.strictEqual(lastEntry.payload.type, 'gated-action');
      assert.strictEqual(lastEntry.payload.decision, 'approved');
      assert.strictEqual(lastEntry.payload.action, 'permitted-action');
      assert.strictEqual(lastEntry.payload.approvalNonce, result.approvalNonce);
    });

    it('should append both denial and approval receipts in sequence', () => {
      const baseDir = createTempTestDir();
      testDirs.push(baseDir);
      setupTestKey(baseDir);

      const action1 = { action: 'first-action', params: {} };
      const action2 = { action: 'second-action', params: {} };

      // First: denial (no token)
      gatedAction(action1, null, mockChain, baseDir);

      // Second: approval (valid token)
      const token = createTestApprovalToken(action2, testKeypair);
      gatedAction(action2, token, mockChain, baseDir);

      // Verify both receipts in chain
      assert.strictEqual(mockChain.entries.length, 2);
      assert.strictEqual(mockChain.entries[0].payload.decision, 'denied');
      assert.strictEqual(mockChain.entries[0].payload.action, 'first-action');
      assert.strictEqual(mockChain.entries[1].payload.decision, 'approved');
      assert.strictEqual(mockChain.entries[1].payload.action, 'second-action');
    });

    it('should handle errors gracefully and fail closed', () => {
      const baseDir = createTempTestDir();
      testDirs.push(baseDir);
      setupTestKey(baseDir);

      // Pass malformed token to trigger error path
      const actionRequest = { action: 'test-action', params: {} };
      const malformedToken = { request: 'not-json', nonce: null, timestamp: 'invalid', signature: 'deadbeef' };

      const result = gatedAction(actionRequest, malformedToken, mockChain, baseDir);

      assert.strictEqual(result.decision, 'denied', 'should deny on error');
      assert.ok(result.reason, 'should have error reason');
    });
  });

  describe('isApprovalKeyInitialized', () => {
    it('should return true when test key exists', () => {
      const baseDir = createTempTestDir();
      testDirs.push(baseDir);
      setupTestKey(baseDir);

      assert.strictEqual(isApprovalKeyInitialized(baseDir), true);
    });

    it('should return false when no key exists', () => {
      const baseDir = createTempTestDir();
      testDirs.push(baseDir);
      // No key setup

      assert.strictEqual(isApprovalKeyInitialized(baseDir), false);
    });
  });
});
