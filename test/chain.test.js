import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createChain, verifyChain, generateKeyPair, GENESIS_PREV_HASH } from '../src/chain/index.js';

describe('createChain and verifyChain', () => {
  it('should create a chain with valid entries', () => {
    const keyPair = generateKeyPair();
    const chain = createChain(keyPair);

    // Append 3 entries
    chain.append({ action: 'first', data: 'hello' });
    chain.append({ action: 'second', data: 'world' });
    chain.append({ action: 'third', data: '!' });

    assert.strictEqual(chain.entries.length, 3);

    // Verify all entries have required fields
    chain.entries.forEach((entry, i) => {
      assert.strictEqual(entry.seq, i, `entry ${i} should have seq ${i}`);
      assert.ok(entry.timestamp, `entry ${i} should have timestamp`);
      assert.ok(entry.nonce, `entry ${i} should have nonce`);
      assert.ok(entry.hash, `entry ${i} should have hash`);
      assert.ok(entry.sig, `entry ${i} should have sig`);
      assert.ok(entry.payload, `entry ${i} should have payload`);
    });

    // Genesis entry has constant prevHash
    assert.strictEqual(chain.entries[0].prevHash, GENESIS_PREV_HASH);

    // Subsequent entries link to previous
    assert.strictEqual(chain.entries[1].prevHash, chain.entries[0].hash);
    assert.strictEqual(chain.entries[2].prevHash, chain.entries[1].hash);
  });

  it('should verify a valid chain', () => {
    const keyPair = generateKeyPair();
    const chain = createChain(keyPair);

    chain.append({ action: 'first' });
    chain.append({ action: 'second' });
    chain.append({ action: 'third' });

    const result = verifyChain(chain.entries, keyPair.publicKey);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.brokenAt, undefined);
    assert.strictEqual(result.reason, undefined);
  });

  it('should detect payload mutation (tampered entry)', () => {
    const keyPair = generateKeyPair();
    const chain = createChain(keyPair);

    chain.append({ action: 'first' });
    chain.append({ action: 'second' });
    chain.append({ action: 'third' });

    // Tamper with entry 1's payload
    chain.entries[1].payload = { action: 'TAMPERED' };

    const result = verifyChain(chain.entries, keyPair.publicKey);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.brokenAt, 1);
    assert.ok(result.reason.includes('hash mismatch'));
  });

  it('should detect signature corruption', () => {
    const keyPair = generateKeyPair();
    const chain = createChain(keyPair);

    chain.append({ action: 'first' });
    chain.append({ action: 'second' });
    chain.append({ action: 'third' });

    // Corrupt entry 2's signature
    const originalSig = chain.entries[2].sig;
    chain.entries[2].sig = originalSig.slice(0, -4) + 'dead';

    const result = verifyChain(chain.entries, keyPair.publicKey);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.brokenAt, 2);
    assert.ok(result.reason.includes('signature verification failed'));
  });

  it('should detect broken prevHash link', () => {
    const keyPair = generateKeyPair();
    const chain = createChain(keyPair);

    chain.append({ action: 'first' });
    chain.append({ action: 'second' });
    chain.append({ action: 'third' });

    // Break the link: make entry 2 point to wrong prevHash
    chain.entries[2].prevHash = 'deadbeef' + '0'.repeat(56);

    const result = verifyChain(chain.entries, keyPair.publicKey);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.brokenAt, 2);
    // prevHash mutation changes the hash, so we catch it as hash mismatch
    // (prevHash is included in the canonical hash computation)
    assert.ok(result.reason.includes('hash mismatch') || result.reason.includes('prevHash'));
  });

  it('should detect genesis entry prevHash mismatch', () => {
    const keyPair = generateKeyPair();
    const chain = createChain(keyPair);

    chain.append({ action: 'first' });

    // Tamper with genesis entry's prevHash
    chain.entries[0].prevHash = 'deadbeef' + '0'.repeat(56);

    const result = verifyChain(chain.entries, keyPair.publicKey);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.brokenAt, 0);
    // prevHash mutation changes the hash, so we catch it as hash mismatch
    assert.ok(result.reason.includes('hash mismatch') || result.reason.includes('prevHash'));
  });

  it('should handle empty chain', () => {
    const keyPair = generateKeyPair();
    const result = verifyChain([], keyPair.publicKey);
    assert.strictEqual(result.ok, true);
  });

  it('should fail verification with wrong public key', () => {
    const keyPair1 = generateKeyPair();
    const keyPair2 = generateKeyPair();
    const chain = createChain(keyPair1);

    chain.append({ action: 'first' });
    chain.append({ action: 'second' });

    // Verify with wrong key
    const result = verifyChain(chain.entries, keyPair2.publicKey);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.brokenAt, 0);
    assert.ok(result.reason.includes('signature verification failed'));
  });

  it('should have unique nonces for each entry', () => {
    const keyPair = generateKeyPair();
    const chain = createChain(keyPair);

    chain.append({ action: 'first' });
    chain.append({ action: 'second' });
    chain.append({ action: 'third' });

    const nonces = chain.entries.map(e => e.nonce);
    const uniqueNonces = new Set(nonces);
    assert.strictEqual(uniqueNonces.size, 3, 'Each entry should have unique nonce');
  });

  it('should return entry with correct structure from append', () => {
    const keyPair = generateKeyPair();
    const chain = createChain(keyPair);

    const entry = chain.append({ test: 'data' });

    assert.strictEqual(entry.seq, 0);
    assert.ok(entry.timestamp);
    assert.ok(entry.nonce);
    assert.strictEqual(entry.prevHash, GENESIS_PREV_HASH);
    assert.deepStrictEqual(entry.payload, { test: 'data' });
    assert.ok(entry.hash);
    assert.ok(entry.sig);
  });
});
