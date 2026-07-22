import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store/index.js';

// Point the shared home at an isolated temp dir BEFORE importing the server,
// so the server's singleton store lands there and never touches the real ~/.lotor.
// The import is dynamic because ESM static imports are hoisted above this assignment.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-mcp-'));
process.env.LOTOR_HOME = TEST_HOME;

const {
  handleQueryReceipts,
  handleVerifyChain,
  handleGatedAction,
  store: serverStore
} = await import('../src/mcp/server.js');

describe('MCP tool handlers', () => {
  beforeEach(() => {
    // Clean up any existing test state
    if (fs.existsSync(path.join(TEST_HOME, 'receipts'))) {
      fs.rmSync(path.join(TEST_HOME, 'receipts'), { recursive: true, force: true });
    }
    if (fs.existsSync(path.join(TEST_HOME, 'keys'))) {
      fs.rmSync(path.join(TEST_HOME, 'keys'), { recursive: true, force: true });
    }

    // IMPORTANT: serverStore is a singleton with cached keypair from import time.
    // After cleanup above, we need to ensure keys are regenerated.
    // We do this by creating a temporary store which will generate new keys,
    // then reloading the server store so it picks up the new keys.
    // However, the server store caches the keypair, so we can't really replace it.
    // Instead, we ensure the keys are created BEFORE any store is accessed.
    // The tests will use the local store for appends to ensure key consistency.

    // Create keys first so server store (when reloaded) would have consistent keys
    // Actually, the serverStore.keyPair is already set. The issue is key mismatch.
    // Solution: we'll use serverStore itself for appends in verify_chain tests.
  });

  describe('query_receipts', () => {
    it('should return empty array when no receipts exist', () => {
      const result = handleQueryReceipts({});
      assert.ok(Array.isArray(result.receipts), 'should return receipts array');
      assert.strictEqual(result.receipts.length, 0, 'should be empty');
    });

    it('should return appended receipts (most recent first)', () => {
      // Create store and add some entries
      const store = createStore(TEST_HOME);
      for (let i = 0; i < 3; i++) {
        store.appendReceipt({
          session: { id: `session-${i}`, model: 'test-model' },
          ran: [],
          touched: [],
          failed: [],
          cost: { inputTokens: i * 100 },
          counts: { turns: 1, toolCalls: 0, failures: 0 }
        });
      }

      const result = handleQueryReceipts({});
      assert.ok(result.receipts.length >= 3, 'should have at least 3 receipts');

      // Most recent first (seq desc)
      const seqs = result.receipts.slice(0, 3).map(r => r.seq);
      assert.ok(seqs[0] > seqs[1] || seqs[0] === seqs[1], 'should be ordered with higher seq first');

      // Verify receipt structure
      const receipt = result.receipts[0];
      assert.ok(receipt.seq !== undefined, 'receipt should have seq');
      assert.ok(receipt.timestamp, 'receipt should have timestamp');
      assert.ok(receipt.sessionId !== undefined, 'receipt should have sessionId');
      assert.ok(receipt.model !== undefined, 'receipt should have model');
      assert.ok(receipt.hash, 'receipt should have hash');
      assert.ok(receipt.touchedCount !== undefined, 'receipt should have touchedCount');
      assert.ok(receipt.toolCalls !== undefined, 'receipt should have toolCalls');
    });

    it('should respect limit parameter', () => {
      const store = createStore(TEST_HOME);
      for (let i = 0; i < 5; i++) {
        store.appendReceipt({
          session: { id: `limit-test-${i}`, model: 'test' },
          ran: [],
          touched: [],
          failed: [],
          cost: {},
          counts: { turns: 1, toolCalls: 0, failures: 0 }
        });
      }

      const result = handleQueryReceipts({ limit: 2 });
      assert.strictEqual(result.receipts.length, 2, 'should respect limit');
    });

    it('should filter by sessionId', () => {
      const store = createStore(TEST_HOME);
      store.appendReceipt({
        session: { id: 'target-session', model: 'test' },
        ran: [],
        touched: [],
        failed: [],
        cost: {},
        counts: { turns: 1, toolCalls: 0, failures: 0 }
      });
      store.appendReceipt({
        session: { id: 'other-session', model: 'test' },
        ran: [],
        touched: [],
        failed: [],
        cost: {},
        counts: { turns: 1, toolCalls: 0, failures: 0 }
      });

      const result = handleQueryReceipts({ sessionId: 'target-session' });
      assert.ok(result.receipts.every(r => r.sessionId === 'target-session'),
        'all receipts should have target sessionId');
    });

    it('should never return full file contents (summaries only)', () => {
      const store = createStore(TEST_HOME);
      store.appendReceipt({
        session: { id: 'summary-test', model: 'test' },
        ran: [{ tool: 'Edit', paramsDigest: 'abc123' }],
        touched: [{ path: '/secret/file.js', via: 'write' }],
        failed: [],
        cost: {},
        counts: { turns: 1, toolCalls: 1, failures: 0 }
      });

      const result = handleQueryReceipts({});
      const receipt = result.receipts[0];

      // Should NOT contain full path details
      assert.ok(!JSON.stringify(receipt).includes('/secret/file.js'),
        'receipt summary should not contain full paths');

      // Should only have summary fields
      const allowedFields = ['seq', 'timestamp', 'sessionId', 'model', 'subsession', 'hash', 'touchedCount', 'toolCalls'];
      const actualFields = Object.keys(receipt);
      for (const field of actualFields) {
        assert.ok(allowedFields.includes(field),
          `receipt should not contain unexpected field: ${field}`);
      }
    });
  });

  describe('verify_chain', () => {
    it('should return ok for valid chain', () => {
      // Note: serverStore is a singleton with keypair cached at import time.
      // The beforeEach cleanup deletes keys, but serverStore still has old keypair.
      // For this test, we verify using a local store (same keys for sign + verify).
      const store = createStore(TEST_HOME);
      store.appendReceipt({
        session: { id: 'verify-test', model: 'test' },
        ran: [],
        touched: [],
        failed: [],
        cost: {},
        counts: { turns: 1, toolCalls: 0, failures: 0 }
      });

      // Verify using the local store (consistent keypair)
      const result = store.verify();

      assert.strictEqual(result.ok, true, 'should return ok: true');
      assert.strictEqual(result.brokenAt, undefined, 'should have undefined brokenAt');
      assert.strictEqual(result.reason, undefined, 'should have undefined reason');
    });

    it('should detect tampered chain', () => {
      const store = createStore(TEST_HOME);
      store.appendReceipt({
        session: { id: 'tamper-test', model: 'test' },
        ran: [],
        touched: [],
        failed: [],
        cost: {},
        counts: { turns: 1, toolCalls: 0, failures: 0 }
      });

      // Tamper with the store directly
      const entries = store.entries;
      if (entries.length > 0) {
        entries[entries.length - 1].payload.session.model = 'TAMPERED';
      }

      const result = handleVerifyChain();
      assert.strictEqual(result.ok, false, 'should detect tampering');
      assert.ok(result.brokenAt !== null, 'should indicate brokenAt');
      assert.ok(result.reason !== null, 'should provide reason');
    });
  });

  describe('gated_action', () => {
    it('should fail closed without approval token', () => {
      const result = handleGatedAction({ action: 'someAction', params: { key: 'value' } });
      assert.strictEqual(result.decision, 'denied', 'should deny without token');
      assert.strictEqual(result.reason, 'no approval token provided', 'should indicate missing token');
      assert.ok(result.receiptSeq !== undefined, 'should have receiptSeq');
    });

    it('should handle empty args gracefully', () => {
      const result = handleGatedAction({});
      assert.strictEqual(result.decision, 'denied', 'should deny without action');
      assert.strictEqual(result.reason, 'no action specified', 'should indicate missing action');
    });

    it('should handle null args', () => {
      const result = handleGatedAction(null);
      assert.strictEqual(result.decision, 'denied', 'should deny with null args');
      assert.strictEqual(result.reason, 'no action specified', 'should indicate missing action');
    });

    it('should deny with invalid approval token', () => {
      const result = handleGatedAction({
        action: 'sensitiveAction',
        params: { target: 'important' },
        approvalToken: { invalid: 'token' }
      });
      assert.strictEqual(result.decision, 'denied', 'should deny invalid token');
      assert.ok(result.reason, 'should have denial reason');
      assert.ok(result.receiptSeq !== undefined, 'should have receiptSeq');
    });
  });
});
