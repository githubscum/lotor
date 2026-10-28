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
 * @param {number} [startSeq=0] - Starting sequence number (for resuming from persisted chain)
 * @param {Array} [priorEntries=[]] - Existing entries to seed the chain (for resuming)
 * @returns {Object} chain with append() and entries
 */
function createChain(keyPair, startSeq = 0, priorEntries = []) {
  const entries = priorEntries.slice(); // Copy to avoid mutating the input
  let seq = startSeq;

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
    // Null prototype. On a plain object, assigning the key "__proto__" sets
    // the prototype instead of creating a property, so an own "__proto__"
    // key in a payload (a model id from a transcript, say) was dropped from
    // the canonical form and could be edited without breaking verification.
    // Every other key canonicalises exactly as before.
    const sorted = Object.create(null);
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

  return verifyRange(entries, publicKey, { startSeq: 0, prevHash: GENESIS_PREV_HASH });
}

/**
 * Verify a contiguous range of entries: the first carries seq startSeq and
 * links to prevHash (the hash of entry startSeq - 1, or the genesis constant
 * when startSeq is 0). Same checks, same order and same reasons as a full
 * verifyChain; entry numbers in brokenAt and in the reasons are absolute seqs,
 * so from startSeq 0 the result is exactly what verifyChain returned before
 * this function existed. A caller that already trusts the chain up to
 * startSeq (a verified checkpoint, src/store/checkpoints.js) verifies only
 * what came after it.
 * @param {Array} entries - Array of entry objects, in seq order
 * @param {crypto.KeyObject} publicKey - Ed25519 public key
 * @param {Object} [from] - { startSeq = 0, prevHash = GENESIS_PREV_HASH }
 * @returns {Object} { ok: boolean, brokenAt?: number, reason?: string }
 */
function verifyRange(entries, publicKey, from = {}) {
  const startSeq = from.startSeq === undefined ? 0 : from.startSeq;
  const startPrevHash = from.prevHash === undefined ? GENESIS_PREV_HASH : from.prevHash;
  if (!Number.isSafeInteger(startSeq) || startSeq < 0) {
    throw new Error(`verifyRange: startSeq must be a non-negative safe integer, got ${startSeq}`);
  }
  if (!entries || entries.length === 0) {
    return { ok: true };
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const at = startSeq + i;

    // Verify hash recomputation
    const expectedHash = computeHash(entry);
    if (expectedHash !== entry.hash) {
      return {
        ok: false,
        brokenAt: at,
        reason: `hash mismatch at entry ${at}: expected ${expectedHash}, got ${entry.hash}`
      };
    }

    // Verify signature
    const sigBuf = Buffer.from(entry.sig, 'hex');
    const hashBuf = Buffer.from(entry.hash, 'hex');
    const sigOk = crypto.verify(null, hashBuf, publicKey, sigBuf);

    if (!sigOk) {
      return {
        ok: false,
        brokenAt: at,
        reason: `signature verification failed at entry ${at}`
      };
    }

    // Verify seq continuity. Entry i of a range that starts at startSeq must
    // carry seq startSeq + i (seq i for a full chain from genesis). The hash
    // covers seq, so a wrong seq can only be signed in at write time; this is
    // where it is caught.
    if (!Number.isSafeInteger(entry.seq) || entry.seq !== at) {
      return {
        ok: false,
        brokenAt: at,
        reason: `seq discontinuity at entry ${at}: expected ${at}, got ${JSON.stringify(entry.seq)}`
      };
    }

    // Verify prevHash linkage
    if (at === 0) {
      // Genesis entry: prevHash must be genesis constant
      if (entry.prevHash !== GENESIS_PREV_HASH) {
        return {
          ok: false,
          brokenAt: at,
          reason: `genesis entry prevHash mismatch at entry ${at}: expected ${GENESIS_PREV_HASH}, got ${entry.prevHash}`
        };
      }
    } else {
      const expectedPrev = i > 0 ? entries[i - 1].hash : startPrevHash;
      if (entry.prevHash !== expectedPrev) {
        return {
          ok: false,
          brokenAt: at,
          reason: `prevHash link broken at entry ${at}: expected ${expectedPrev}, got ${entry.prevHash}`
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
  verifyRange,
  generateKeyPair,
  GENESIS_PREV_HASH
};
