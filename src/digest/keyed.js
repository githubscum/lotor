/**
 * src/digest/keyed.js
 *
 * Keyed digest (HMAC-SHA256) helper for short texts. A plain SHA-256 of a
 * short text. A tool output like "ok", a yes/no, a 4-digit PIN, a short
 * password, is reversible by dictionary search: hash every candidate,
 * compare. Keying the digest removes that attack; the key never appears
 * in any digest, keyId, or error message.
 *
 * This module is the helper only: it does not change any existing digest
 * call site. Key custody (where the key lives, how it is provisioned and
 * rotated) is deliberately out of scope and an open question for Isaac.
 */

import crypto from 'node:crypto';

export const DIGEST_KEY_MIN_BYTES = 32;

/** Domain separator so a keyId is never the digest of anything caller-side. */
const KEY_ID_DOMAIN = Buffer.from('lotor-digest-key-id\0', 'utf8');

function assertString(text, fnName) {
  if (typeof text !== 'string') {
    throw new TypeError(`${fnName}() expects text as a string`);
  }
}

function requireDigestKey(key) {
  if (!Buffer.isBuffer(key) || key.length < DIGEST_KEY_MIN_BYTES) {
    throw new TypeError(`keyed digest requires a Buffer key of at least ${DIGEST_KEY_MIN_BYTES} bytes`);
  }
  return key;
}

/** First 16 hex chars of SHA-256 over the domain-separated key bytes. */
function keyIdFor(key) {
  const hash = crypto.createHash('sha256');
  hash.update(KEY_ID_DOMAIN);
  hash.update(key);
  return hash.digest('hex').slice(0, 16);
}

/** Constant-time compare of two hex strings via timingSafeEqual, false on length mismatch. */
function timingSafeHexEqual(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string') return false;
  const a = Buffer.from(hexA, 'hex');
  const b = Buffer.from(hexB, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * HMAC-SHA256 of `text` (utf8) under `key`. Returns a frozen record whose
 * digest is not invertible by a plain-hash dictionary over the text space.
 */
export function keyedDigest(text, key) {
  assertString(text, 'keyedDigest');
  const k = requireDigestKey(key);
  return Object.freeze({
    alg: 'hmac-sha256',
    keyId: keyIdFor(k),
    digest: crypto.createHmac('sha256', k).update(text, 'utf8').digest('hex')
  });
}

/** Plain SHA-256 (utf8) as a frozen record. Unsuitable for short texts. */
export function plainDigest(text) {
  assertString(text, 'plainDigest');
  return Object.freeze({
    alg: 'sha256',
    keyId: null,
    digest: crypto.createHash('sha256').update(text, 'utf8').digest('hex')
  });
}

/**
 * Verify `record` against `text` and `key`. True only for a well-formed
 * hmac-sha256 record whose keyId and digest both match under this key,
 * compared with timingSafeEqual on equal-length buffers. Returns false
 * (never throws) on a malformed record, wrong text, or a valid-but-wrong
 * key; throws TypeError only for a key argument that is not an adequately
 * long Buffer.
 */
export function verifyKeyedDigest(record, text, key) {
  const k = requireDigestKey(key);

  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return false;
  }
  if (record.alg !== 'hmac-sha256') {
    return false;
  }
  if (typeof text !== 'string') {
    return false;
  }
  // Canonical spelling only: Buffer.from(x, 'hex') silently stops at the
  // first non-hex character and drops a trailing odd nibble, so a raw
  // timingSafeHexEqual would accept several spellings of one digest.
  // Lowercase is the exact spelling keyedDigest emits.
  if (typeof record.keyId !== 'string' || !/^[0-9a-f]{16}$/.test(record.keyId)) {
    return false;
  }
  if (typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/.test(record.digest)) {
    return false;
  }
  if (!timingSafeHexEqual(record.keyId, keyIdFor(k))) {
    return false;
  }

  const expected = crypto.createHmac('sha256', k).update(text, 'utf8').digest('hex');
  return timingSafeHexEqual(record.digest, expected);
}

/**
 * True when `text`'s utf8 byte length (not character count) is within
 * `threshold`. Pure helper so a later call site can decide when keying
 * is required.
 */
export function isShortText(text, threshold = 64) {
  assertString(text, 'isShortText');
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0) {
    throw new TypeError('isShortText() expects threshold as a non-negative number');
  }
  return Buffer.byteLength(text, 'utf8') <= threshold;
}