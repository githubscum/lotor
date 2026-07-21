import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createStore, loadOrCreateKeyPair } from '../src/store/index.js';
import { verifyChain } from '../src/chain/index.js';

// Use isolated temp directories for each test
function createTempTestDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-test-'));
}

describe('store', () => {
  let testDirs = [];

  afterEach(() => {
    // Clean up all test directories
    for (const dir of testDirs) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    testDirs = [];
  });

  it('should create store and append entries with round-trip persistence', () => {
    const baseDir = createTempTestDir();
    testDirs.push(baseDir);

    const store = createStore(baseDir);
    const initialCount = store.entries.length;

    // Append a synthetic receipt
    const payload = {
      session: { id: 'test-session-001', model: 'test-model', version: '1.0' },
      ran: [{ tool: 'test', paramsDigest: 'abc123' }],
      touched: [{ path: '/test/file.js', via: 'write' }],
      failed: [],
      cost: { inputTokens: 100, outputTokens: 50 },
      counts: { turns: 1, toolCalls: 1, failures: 0 }
    };

    const entry = store.appendReceipt(payload);

    // Verify entry structure
    assert.ok(entry.seq >= 0, 'entry should have seq');
    assert.ok(entry.timestamp, 'entry should have timestamp');
    assert.ok(entry.nonce, 'entry should have nonce');
    assert.ok(entry.hash, 'entry should have hash');
    assert.ok(entry.sig, 'entry should have sig');
    assert.deepStrictEqual(entry.payload, payload, 'payload should match');

    // Verify store now has one more entry
    assert.strictEqual(store.entries.length, initialCount + 1);

    // Verify the persisted chain can be reloaded
    const store2 = createStore(baseDir);
    const reloadedEntries = store2.reload();
    assert.ok(reloadedEntries.length >= 1, 'should have at least one entry after reload');

    // Find our entry in the reloaded chain
    const foundEntry = reloadedEntries.find(e => e.payload?.session?.id === 'test-session-001');
    assert.ok(foundEntry, 'should find the entry in reloaded chain');
    assert.strictEqual(foundEntry.payload.session.model, 'test-model');
  });

  it('should verify a persisted chain successfully', () => {
    const baseDir = createTempTestDir();
    testDirs.push(baseDir);

    const store = createStore(baseDir);

    // Append multiple entries
    for (let i = 0; i < 3; i++) {
      store.appendReceipt({
        session: { id: `session-${i}`, model: 'test' },
        ran: [],
        touched: [],
        failed: [],
        cost: {},
        counts: { turns: 1, toolCalls: 0, failures: 0 }
      });
    }

    // Verify the chain
    const result = store.verify();
    assert.strictEqual(result.ok, true, 'chain should verify successfully');
    assert.strictEqual(result.brokenAt, undefined, 'no broken entries');
    assert.strictEqual(result.reason, undefined, 'no failure reason');
  });

  it('should detect tampered chain on verification', () => {
    const baseDir = createTempTestDir();
    testDirs.push(baseDir);

    const store = createStore(baseDir);

    // Append an entry
    store.appendReceipt({
      session: { id: 'tamper-test', model: 'test' },
      ran: [],
      touched: [],
      failed: [],
      cost: {},
      counts: { turns: 1, toolCalls: 0, failures: 0 }
    });

    // Tamper with the entry in memory
    store.entries[store.entries.length - 1].payload.session.model = 'TAMPERED';

    // Verification should detect tampering (hash mismatch)
    const result = store.verify();
    assert.strictEqual(result.ok, false, 'should detect tampering');
    assert.ok(result.reason, 'should have failure reason');
  });

  it('should generate keypair on first use', () => {
    const baseDir = createTempTestDir();
    testDirs.push(baseDir);

    // Create a fresh store - this should generate keys
    const store = createStore(baseDir);
    assert.ok(store.keyPair, 'store should have keyPair');
    assert.ok(store.keyPair.publicKey, 'keyPair should have publicKey');
    assert.ok(store.keyPair.privateKey, 'keyPair should have privateKey');

    // Keys should exist on disk
    assert.ok(fs.existsSync(path.join(baseDir, 'keys/chain.pub')), 'public key should be written');
    assert.ok(fs.existsSync(path.join(baseDir, 'keys/chain.key')), 'private key should be written');
  });

  it('should reload existing keys on subsequent use', () => {
    const baseDir = createTempTestDir();
    testDirs.push(baseDir);

    // First store creation generates keys
    const store1 = createStore(baseDir);
    const pubKey1 = store1.keyPair.publicKey;

    // Second store should load same keys
    const store2 = createStore(baseDir);
    const pubKey2 = store2.keyPair.publicKey;

    assert.strictEqual(pubKey1, pubKey2, 'should reuse existing keys');
  });

  it('should append multiple entries with correct sequence numbers', () => {
    const baseDir = createTempTestDir();
    testDirs.push(baseDir);

    const store = createStore(baseDir);
    const startSeq = store.entries.length;

    const entries = [];
    for (let i = 0; i < 5; i++) {
      const entry = store.appendReceipt({ test: `entry-${i}` });
      entries.push(entry);
    }

    // Verify sequence numbers are contiguous
    for (let i = 0; i < entries.length; i++) {
      assert.strictEqual(entries[i].seq, startSeq + i, `entry ${i} should have seq ${startSeq + i}`);
    }

    // Verify hash chain linkage
    for (let i = 1; i < entries.length; i++) {
      assert.strictEqual(entries[i].prevHash, entries[i - 1].hash,
        `entry ${i} should link to entry ${i - 1}`);
    }
  });

  it('should resume chain across store restarts with correct prevHash linkage', () => {
    const baseDir = createTempTestDir();
    testDirs.push(baseDir);

    // First store instance: append initial entries
    const store1 = createStore(baseDir);
    const entry1 = store1.appendReceipt({ test: 'first-entry' });
    const entry2 = store1.appendReceipt({ test: 'second-entry' });

    // Second store instance (simulating process restart): append more entries
    const store2 = createStore(baseDir);
    assert.strictEqual(store2.entries.length, 2, 'should load 2 persisted entries');
    assert.strictEqual(store2.entries[0].hash, entry1.hash, 'first entry should match');
    assert.strictEqual(store2.entries[1].hash, entry2.hash, 'second entry should match');

    // Append new entry - it should link to the last persisted entry
    const entry3 = store2.appendReceipt({ test: 'third-entry' });
    assert.strictEqual(entry3.seq, 2, 'new entry should have seq=2');
    assert.strictEqual(entry3.prevHash, entry2.hash, 'new entry should link to previous');

    // Verify the full chain
    const result = store2.verify();
    assert.strictEqual(result.ok, true, 'full chain should verify after restart');

    // Third store instance: verify full chain persists
    const store3 = createStore(baseDir);
    assert.strictEqual(store3.entries.length, 3, 'should have 3 entries');
    const verifyResult = store3.verify();
    assert.strictEqual(verifyResult.ok, true, 'chain should verify from fresh load');
  });
});
