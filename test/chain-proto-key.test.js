/**
 * test/chain-proto-key.test.js
 *
 * Found by the PR #70 review fixes (V3-02, review F1), 2026-10-22: the chain
 * canonicaliser rebuilt each object by plain assignment, and assigning the
 * key "__proto__" to a plain object sets its prototype rather than a
 * property. An own "__proto__" key in a payload (JSON.parse makes one, and
 * cost.byModel gets one from a model id a transcript wrote) was therefore
 * left out of the hash: its value could be edited and the chain still
 * verified.
 *
 * FAIL-FIRST: the first test fails on main (the edit verifies); it passes
 * with the null-prototype canonicaliser. The second pins that every entry
 * without such a key hashes exactly as before, so no existing chain moves.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createChain, verifyChain, generateKeyPair, GENESIS_PREV_HASH } from '../src/chain/index.js';

function keys() {
  const kp = generateKeyPair();
  return { publicKey: crypto.createPublicKey(kp.publicKey), privateKey: crypto.createPrivateKey(kp.privateKey) };
}

describe('chain canonical form: an own "__proto__" key is hashed like any other', () => {
  it('editing the value under an own "__proto__" key breaks verification', () => {
    const k = keys();
    const chain = createChain(k);
    chain.append(JSON.parse('{"type":"session","cost":{"byModel":{"__proto__":{"messages":1},"m":{"messages":1}}}}'));
    const stored = JSON.parse(JSON.stringify(chain.entries));
    assert.ok(Object.prototype.hasOwnProperty.call(stored[0].payload.cost.byModel, '__proto__'));
    assert.equal(verifyChain(stored, k.publicKey).ok, true);

    const edited = JSON.parse(JSON.stringify(stored).replace('"__proto__":{"messages":1}', '"__proto__":{"messages":99}'));
    assert.equal(edited[0].payload.cost.byModel.__proto__.messages, 99);
    const res = verifyChain(edited, k.publicKey);
    assert.equal(res.ok, false, 'an edit under "__proto__" must not verify');
    assert.equal(res.brokenAt, 0);
  });

  it('an entry with no "__proto__" key hashes exactly as the previous canonicaliser did', () => {
    // The previous replacer, verbatim, to compute the hash a chain written
    // before this change carries.
    function legacy(key, value) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const sorted = {};
        for (const kk of Object.keys(value).sort()) sorted[kk] = value[kk];
        return sorted;
      }
      return value;
    }
    const k = keys();
    const entry = {
      seq: 0,
      timestamp: 1761130000000,
      nonce: 'ab'.repeat(16),
      prevHash: GENESIS_PREV_HASH,
      payload: { type: 'session', z: 1, a: { y: [3, { d: 1, c: 2 }], b: null }, constructor: 'k', toString: 'v' }
    };
    const { seq, timestamp, nonce, prevHash, payload } = entry;
    entry.hash = crypto.createHash('sha256')
      .update(JSON.stringify({ seq, timestamp, nonce, prevHash, payload }, legacy)).digest('hex');
    entry.sig = crypto.sign(null, Buffer.from(entry.hash, 'hex'), k.privateKey).toString('hex');
    assert.equal(verifyChain([entry], k.publicKey).ok, true, 'an existing chain must still verify');
  });
});
