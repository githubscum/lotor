/**
 * staging-grant/grant-schema.js
 *
 * Canonical form of a delegation grant and a grant-use entry, plus
 * Ed25519 sign and verify over that canonical form.
 *
 * Conventions are taken from src/chain/index.js so the existing chain
 * verifier can validate grant entries unchanged:
 *   - JSON.stringify with a replacer that sorts object keys at every level
 *   - arrays preserved in their original order (the design depends on this
 *     for `paths` being the explicit enumeration it claims to be)
 *   - the signature covers the canonical UTF-8 bytes of the grant object
 *     with the `signature` field itself stripped
 */

import crypto from 'node:crypto';

const GRANT_TYPE = 'delegation-grant';
const USE_TYPE = 'grant-use';

/**
 * Stable key-ordering replacer, identical in spirit to
 * src/chain/index.js's sortKeysReplacer. Sorts object keys at every level.
 * Arrays are left in original order on purpose.
 */
function sortKeysReplacer(_key, value) {
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
 * Canonicalize a grant (or grant-use) into a stable byte string.
 * Arrays are preserved in original order; object keys are sorted.
 */
function canonicalizeGrant(obj) {
  return JSON.stringify(obj, sortKeysReplacer);
}

function canonicalizeGrantUse(obj) {
  return JSON.stringify(obj, sortKeysReplacer);
}

/**
 * Sign a grant. Returns a NEW object — the input is not mutated.
 * The signature is over the canonical bytes of the grant with the
 * `signature` field itself excluded (so the verifier can recompute
 * the same bytes from the signed object minus the signature).
 */
function signGrant(grant, privateKey) {
  if (!grant || typeof grant !== 'object') {
    throw new TypeError('signGrant: grant must be an object');
  }
  if (!privateKey) {
    throw new TypeError('signGrant: privateKey is required');
  }
  // Defensive copy, drop any caller-supplied signature field
  const { signature: _drop, ...rest } = grant;
  const canonical = canonicalizeGrant(rest);
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey);
  return { ...rest, signature: sig.toString('hex') };
}

/**
 * Verify a grant's signature. Recomputes the canonical bytes from the
 * grant minus its `signature` field, and checks the signature over those
 * bytes with the given public key.
 */
function verifyGrantSignature(grant, publicKey) {
  if (!grant || typeof grant !== 'object') return false;
  if (!publicKey) return false;
  if (typeof grant.signature !== 'string' || grant.signature.length === 0) return false;
  const { signature, ...rest } = grant;
  const canonical = canonicalizeGrant(rest);
  let sigBuf;
  try {
    sigBuf = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  let ok;
  try {
    ok = crypto.verify(null, Buffer.from(canonical, 'utf8'), publicKey, sigBuf);
  } catch {
    return false;
  }
  return !!ok;
}

/**
 * Compute a stable 32-hex-char identifier for a grant, taken from the
 * first 16 bytes of the SHA-256 of its canonical bytes (with `signature`
 * stripped). Useful for naming files.
 */
function grantFingerprint(grant) {
  const { signature: _drop, ...rest } = grant;
  return crypto.createHash('sha256').update(canonicalizeGrant(rest)).digest('hex').slice(0, 32);
}

export {
  GRANT_TYPE,
  USE_TYPE,
  sortKeysReplacer,
  canonicalizeGrant,
  canonicalizeGrantUse,
  signGrant,
  verifyGrantSignature,
  grantFingerprint
};
