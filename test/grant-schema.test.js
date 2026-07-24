/**
 * test/grant-schema.test.js
 *
 * Tests for staging-grant/grant-schema.js
 * Covers:
 *   - canonical form of a grant and a grant-use entry
 *   - canonicalize() is stable across key-order variation
 *   - canonicalize() detects single-byte changes
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  canonicalizeGrant,
  canonicalizeGrantUse,
  signGrant,
  verifyGrantSignature
} from '../src/grant/grant-schema.js';
import { generateKeyPair } from '../src/chain/index.js';

describe('grant-schema: canonicalizeGrant', () => {
  it('produces a non-empty string', () => {
    const g = {
      type: 'delegation-grant',
      grantId: 'g-1',
      sessionId: 's-1',
      paths: ['a.js', 'b.js'],
      tools: ['Edit', 'Write'],
      maxActions: 5,
      issuedAt: 1000,
      expiresAt: 2000,
      nonce: 'abcd'
    };
    const c = canonicalizeGrant(g);
    assert.ok(typeof c === 'string' && c.length > 0, 'canonical must be a non-empty string');
  });

  it('is stable across key order at the top level', () => {
    const g1 = {
      type: 'delegation-grant',
      grantId: 'g-1',
      sessionId: 's-1',
      paths: ['a.js'],
      tools: ['Edit'],
      maxActions: 1,
      issuedAt: 1,
      expiresAt: 2,
      nonce: 'n'
    };
    const g2 = {
      nonce: 'n',
      expiresAt: 2,
      issuedAt: 1,
      maxActions: 1,
      tools: ['Edit'],
      paths: ['a.js'],
      sessionId: 's-1',
      grantId: 'g-1',
      type: 'delegation-grant'
    };
    assert.strictEqual(canonicalizeGrant(g1), canonicalizeGrant(g2),
      'different key order at top level must produce identical canonical form');
  });

  it('is stable across nested key order', () => {
    const g1 = { a: 1, b: { c: 2, d: 3 } };
    const g2 = { b: { d: 3, c: 2 }, a: 1 };
    assert.strictEqual(canonicalizeGrant(g1), canonicalizeGrant(g2));
  });

  it('preserves array order (does not sort arrays)', () => {
    const g1 = { paths: ['z', 'a', 'm'] };
    const g2 = { paths: ['m', 'z', 'a'] };
    assert.notStrictEqual(canonicalizeGrant(g1), canonicalizeGrant(g2),
      'paths[] order must be preserved (it is the authorized enumeration)');
  });

  it('detects a one-byte change anywhere', () => {
    const g = {
      type: 'delegation-grant',
      grantId: 'g-1',
      sessionId: 's-1',
      paths: ['a.js', 'b.js'],
      tools: ['Edit'],
      maxActions: 5,
      issuedAt: 1000,
      expiresAt: 2000,
      nonce: 'abcd'
    };
    const c0 = canonicalizeGrant(g);
    // mutate maxActions by 1
    const mutated = { ...g, maxActions: g.maxActions + 1 };
    assert.notStrictEqual(c0, canonicalizeGrant(mutated),
      'changing maxActions by 1 must change the canonical bytes');
    // mutate one path
    const mutated2 = { ...g, paths: ['a.js', 'B.js'] };
    assert.notStrictEqual(c0, canonicalizeGrant(mutated2),
      'changing one path must change the canonical bytes');
    // mutate one byte of a string field
    const mutated3 = { ...g, grantId: 'g-1!' };
    assert.notStrictEqual(c0, canonicalizeGrant(mutated3),
      'changing one byte of grantId must change the canonical bytes');
  });
});

describe('grant-schema: signGrant + verifyGrantSignature', () => {
  it('a grant with the right key verifies; mutating one byte invalidates signature', () => {
    const kp = generateKeyPair();
    const g = {
      type: 'delegation-grant',
      grantId: 'g-1',
      sessionId: 's-1',
      paths: ['a.js'],
      tools: ['Edit'],
      maxActions: 1,
      issuedAt: 1,
      expiresAt: 2,
      nonce: 'n1'
    };
    const signed = signGrant(g, kp.privateKey);
    // signed is a NEW object — the original g is untouched and unsigned
    assert.ok(signed.signature, 'signed grant must carry a signature');
    assert.strictEqual(signed.grantId, g.grantId, 'fields must round-trip');

    const ok = verifyGrantSignature(signed, kp.publicKey);
    assert.strictEqual(ok, true, 'signature over unchanged grant must verify');

    // Mutate one byte: bump maxActions
    const tampered = { ...signed, maxActions: signed.maxActions + 1 };
    const okTamper = verifyGrantSignature(tampered, kp.publicKey);
    assert.strictEqual(okTamper, false, 'one-byte change must invalidate signature');
  });

  it('a grant signed by the wrong key does not verify', () => {
    const issuer = generateKeyPair();
    const attacker = generateKeyPair();
    const g = {
      type: 'delegation-grant',
      grantId: 'g-2',
      sessionId: 's-2',
      paths: ['a.js'],
      tools: ['Edit'],
      maxActions: 1,
      issuedAt: 1,
      expiresAt: 2,
      nonce: 'n2'
    };
    const signed = signGrant(g, issuer.privateKey);
    // Verify with the attacker's public key — must fail
    const ok = verifyGrantSignature(signed, attacker.publicKey);
    assert.strictEqual(ok, false, 'wrong key must not verify');
  });
});

describe('grant-schema: canonicalizeGrantUse', () => {
  it('produces a deterministic string for grant-use entries', () => {
    const use1 = {
      type: 'grant-use',
      grantId: 'g-1',
      useIndex: 1,
      path: 'a.js',
      tool: 'Edit',
      timestamp: 1234
    };
    const use2 = {
      timestamp: 1234,
      tool: 'Edit',
      path: 'a.js',
      useIndex: 1,
      grantId: 'g-1',
      type: 'grant-use'
    };
    assert.strictEqual(canonicalizeGrantUse(use1), canonicalizeGrantUse(use2));
  });
});
