import crypto from 'node:crypto';

/**
 * src/chain/index.js
 *
 * Ed25519 signed hash chain (the AIP spine).
 * Pattern ported from brain's tools/sign.mjs + verify.mjs (node:crypto, zero deps)
 */

const GENESIS_PREV_HASH = '0'.repeat(64);

/**
 * Create a new signed hash chain.
 * @param {Object} keyPair - { publicKey: KeyObject, privateKey: KeyObject } from node:crypto
 * @returns {Object} chain with append() and entries
 */
function createChain(keyPair) {
  const entries = [];
  let seq = 0;

  return {
    entries,
    append(payload) {
      const prevEntry = entries.length > 0 ? entries[entries.length - 1] : null;
      const prevHash = prevEntry ? prevEntry.hash : GENESIS_PREV_HASH;

      const timestamp = Date.now();
      const nonce = crypto.randomBytes(16).toString('hex');

      const entry = {
        seq,
        timestamp,
        nonce,
        prevHash,
        payload
      };

      // Compute hash over canonicalized entry (excluding hash and sig fields)
      entry.hash = computeHash(entry);

      // Sign the hash
      entry.sig = crypto.sign(null, Buffer.from(entry.hash, 'hex'), keyPair.privateKey).toString('hex');

      entries.push(entry);
      seq++;

      return entry;
    }
  };
}

/**
 * Compute SHA-256 hash of canonicalized entry data
 * Canonical form: deterministic JSON with all keys sorted recursively.
 */
function computeHash(entry) {
  const data = {
    seq: entry.seq,
    timestamp: entry.timestamp,
    nonce: entry.nonce,
    prevHash: entry.prevHash,
    payload: entry.payload
  };

  // Stable key ordering: sort keys alphabetically at all levels
  const canonical = JSON.stringify(data, sortKeysReplacer);

  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * JSON.stringify replacer that sorts object keys alphabetically.
 */
function sortKeysReplacer(key, value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted = {};
    for (const k of Object.keys(value).sort()) {
      sorted[k] = value[k];
    }
    return sorted;
  }
  return value;
}

/**
 * Verify a chain of entries.
 * @param {Array} entries - Array of entry objects
 * @param {crypto.KeyObject} publicKey - Ed25519 public key
 * @returns {Object} { ok: boolean, brokenAt?: number, reason?: string }
 */
function verifyChain(entries, publicKey) {
  if (!entries || entries.length === 0) {
    return { ok: true };
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // Verify hash recomputation
    const expectedHash = computeHash(entry);
    if (expectedHash !== entry.hash) {
      return {
        ok: false,
        brokenAt: i,
        reason: `hash mismatch at entry ${i}: expected ${expectedHash}, got ${entry.hash}`
      };
    }

    // Verify signature
    const sigBuf = Buffer.from(entry.sig, 'hex');
    const hashBuf = Buffer.from(entry.hash, 'hex');
    const sigOk = crypto.verify(null, hashBuf, publicKey, sigBuf);

    if (!sigOk) {
      return {
        ok: false,
        brokenAt: i,
        reason: `signature verification failed at entry ${i}`
      };
    }

    // Verify prevHash linkage
    if (i === 0) {
      // Genesis entry: prevHash must be genesis constant
      if (entry.prevHash !== GENESIS_PREV_HASH) {
        return {
          ok: false,
          brokenAt: i,
          reason: `genesis entry prevHash mismatch at entry ${i}: expected ${GENESIS_PREV_HASH}, got ${entry.prevHash}`
        };
      }
    } else {
      const prevEntry = entries[i - 1];
      if (entry.prevHash !== prevEntry.hash) {
        return {
          ok: false,
          brokenAt: i,
          reason: `prevHash link broken at entry ${i}: expected ${prevEntry.hash}, got ${entry.prevHash}`
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Generate an Ed25519 keypair for chain signing.
 * @returns {Object} { publicKey: KeyObject, privateKey: KeyObject }
 */
function generateKeyPair() {
  return crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
}

export {
  createChain,
  verifyChain,
  generateKeyPair,
  GENESIS_PREV_HASH
};
