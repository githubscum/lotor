/**
 * PAP seal: the crypto under a sealed (v2) bundle. No layout here; that is
 * manifest.js. No signing of the outer bundle here; that is pack.js.
 *
 * Construction (spec: docs/PAP-SEALED.md), published primitives only:
 *   - content key (CEK): 32 random bytes, fresh per bundle
 *   - key commitment: SHA-256("lotor/pap/v2/key-commit" 0x00 || CEK), public.
 *     AES-GCM is not key-committing, so a separate commitment makes every
 *     recipient check the CEK it unwrapped against one public value. It is
 *     defence in depth (forging two keys that open one GCM body to different
 *     plaintexts is far from free against random keys, but it is not a
 *     property GCM promises) plus the verifiable reveal: a published CEK is
 *     checked against this value by anyone.
 *   - body: AES-256-GCM under HKDF-SHA256(CEK, info "lotor/pap/v2/body"),
 *     12-byte zero nonce, header bytes as associated data
 *   - X25519 recipient: one ephemeral X25519 key per bundle; per recipient
 *     KEK = HKDF-SHA256(X25519(eph, recipient), salt eph || recipient,
 *     info "lotor/pap/v2/x25519-wrap"); wrapped = AES-256-GCM(KEK, CEK), 48 B
 *   - passphrase: KEK = PBKDF2-HMAC-SHA256(passphrase, salt16, iterations);
 *     wrapped = AES-256-GCM(KEK, CEK), 48 B
 *
 * Why a zero nonce is safe: every key it is used with is used exactly once.
 * The body key comes from a fresh CEK, each X25519 KEK from a fresh ephemeral
 * key, each passphrase KEK from a fresh salt. Same reasoning, same shape as
 * age's file-key wrapping. AES-256-GCM (not XChaCha20-Poly1305) because it is
 * in both node:crypto and WebCrypto, so the offline reader needs no AEAD
 * library.
 *
 * That reasoning only holds if no caller can pick the key. So nothing here is
 * exported that encrypts under a caller-supplied key. The only way in is
 * createSealer(): it makes the CEK, the ephemeral key and every KEK inside its
 * own closure, hands back the public stanzas, and its encryptBody() runs once.
 * A second call throws. The decrypt side (aeadOpen, openBody, x25519Unwrap) is
 * exported because opening under a key you hold is not the hazard.
 *
 * WO-CARTRIDGE-SEAL, 2026-10-26; amended the same day after the wringer review.
 * Queued for a signing sitting: src/publish is core (src/grant/core-paths.js
 * CORE_DIRS).
 */

import crypto from 'node:crypto';
import { PASSPHRASE_SALT_LEN } from './manifest.js';

const CEK_LEN = 32;
const GCM_TAG_LEN = 16;
const ZERO_NONCE = Buffer.alloc(12);
const NUL = Buffer.from([0]);

const DOMAIN_KEY_COMMIT = Buffer.from('lotor/pap/v2/key-commit', 'utf8');
const DOMAIN_BODY = 'lotor/pap/v2/body';
const DOMAIN_X25519_WRAP = 'lotor/pap/v2/x25519-wrap';
const DOMAIN_INNER = Buffer.from('lotor/pap/v2/inner', 'utf8');
const DOMAIN_OUTER = Buffer.from('lotor/pap/v2/outer', 'utf8');

const DEFAULT_PBKDF2_ITERATIONS = 600000;
// Seal-time floor. PBKDF2 is not memory-hard (the price of WebCrypto support,
// KNOWN-LIMITS 45); below this count a stolen QR is cheap to attack. The count
// is carried in the bundle, so older or other writers are still readable.
const MIN_PBKDF2_ITERATIONS = 100000;
const MAX_PBKDF2_ITERATIONS = 10000000;

// SPKI / PKCS8 DER prefixes for X25519, per RFC 8410 (OID 1.3.101.110).
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function papError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Re-throw anything a key parser raised as a coded PAP_BAD_KEY. */
function badKey(e, what) {
  if (e && e.code === 'PAP_BAD_KEY') return e;
  return papError('PAP_BAD_KEY', `${what}: ${e && e.message ? e.message : String(e)}`);
}

function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function keyCommitment(cek) {
  return sha256(DOMAIN_KEY_COMMIT, NUL, cek);
}

function commitmentMatches(cek, commit) {
  const mine = keyCommitment(cek);
  return commit.length === mine.length && crypto.timingSafeEqual(mine, commit);
}

function bodyKey(cek) {
  return Buffer.from(crypto.hkdfSync('sha256', cek, Buffer.alloc(0), DOMAIN_BODY, 32));
}

/**
 * Module-private on purpose. AES-GCM with the fixed zero nonce is safe only
 * for a key that is used once, and this function cannot know that.
 */
function aeadSeal(key, plaintext, aad) {
  const c = crypto.createCipheriv('aes-256-gcm', key, ZERO_NONCE);
  if (aad) c.setAAD(aad);
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([body, c.getAuthTag()]);
}

/** Returns the plaintext, or null when authentication fails. */
function aeadOpen(key, sealed, aad) {
  if (sealed.length < GCM_TAG_LEN) return null;
  const d = crypto.createDecipheriv('aes-256-gcm', key, ZERO_NONCE);
  if (aad) d.setAAD(aad);
  d.setAuthTag(sealed.subarray(sealed.length - GCM_TAG_LEN));
  try {
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - GCM_TAG_LEN)), d.final()]);
  } catch {
    return null;
  }
}

/** Decrypt the sealed body under a content key. Null when it does not authenticate. */
function openBody(cek, ciphertext, headerBytes) {
  return aeadOpen(bodyKey(cek), ciphertext, headerBytes);
}

// ---------- X25519 ----------

function x25519PublicFromRaw(raw32) {
  if (!Buffer.isBuffer(raw32) || raw32.length !== 32) throw papError('PAP_BAD_KEY', 'X25519 public key must be 32 bytes');
  try {
    return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw32]), format: 'der', type: 'spki' });
  } catch (e) {
    throw badKey(e, 'X25519 public key rejected');
  }
}

function x25519PrivateFromRaw(raw32) {
  if (!Buffer.isBuffer(raw32) || raw32.length !== 32) throw papError('PAP_BAD_KEY', 'X25519 private key must be 32 bytes');
  try {
    return crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, raw32]), format: 'der', type: 'pkcs8' });
  } catch (e) {
    throw badKey(e, 'X25519 private key rejected');
  }
}

function x25519RawPublic(keyObj) {
  const pub = keyObj.type === 'private' ? crypto.createPublicKey(keyObj) : keyObj;
  return pub.export({ format: 'der', type: 'spki' }).subarray(-32);
}

function generateRecipientKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    publicKey,
    privateKey,
    publicKeyRaw: x25519RawPublic(publicKey),
    privateKeyRaw: privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32),
  };
}

/** Accepts a 32-byte Buffer, 64 hex chars, or an SPKI PEM string. */
function parseRecipientPublicKey(input) {
  try {
    if (Buffer.isBuffer(input)) return x25519RawPublic(x25519PublicFromRaw(input));
    const s = String(input).trim();
    if (/^[0-9a-f]{64}$/i.test(s)) return x25519RawPublic(x25519PublicFromRaw(Buffer.from(s, 'hex')));
    const k = crypto.createPublicKey(s);
    if (k.asymmetricKeyType !== 'x25519') throw papError('PAP_BAD_KEY', `recipient key is ${k.asymmetricKeyType}, expected x25519`);
    return x25519RawPublic(k);
  } catch (e) {
    throw badKey(e, 'recipient public key is not usable');
  }
}

/** Accepts a KeyObject, a 32-byte Buffer, 64 hex chars, or a PKCS8 PEM string. */
function parseRecipientPrivateKey(input) {
  try {
    let k;
    if (input && typeof input === 'object' && input.type === 'private') k = input;
    else if (Buffer.isBuffer(input)) k = x25519PrivateFromRaw(input);
    else {
      const s = String(input).trim();
      k = /^[0-9a-f]{64}$/i.test(s) ? x25519PrivateFromRaw(Buffer.from(s, 'hex')) : crypto.createPrivateKey(s);
    }
    if (k.asymmetricKeyType !== 'x25519') throw papError('PAP_BAD_KEY', `recipient key is ${k.asymmetricKeyType}, expected x25519`);
    return k;
  } catch (e) {
    throw badKey(e, 'recipient private key is not usable');
  }
}

/**
 * Derive the key-encryption key for one stanza. Both keys are validated as
 * X25519 first, so a failure of the Diffie-Hellman itself can only be a
 * degenerate (low-order) peer key: OpenSSL refuses to return an all-zero
 * shared secret, and if it ever did, the explicit check below catches it. That
 * one case is PAP_X25519_LOW_ORDER; every other failure is a PAP_BAD_KEY.
 */
function x25519Kek(privateKey, peerRaw, ephPubRaw, recipientPubRaw) {
  if (!privateKey || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'x25519') {
    throw papError('PAP_BAD_KEY', 'recipient key is not an x25519 private key, expected x25519');
  }
  const peer = x25519PublicFromRaw(peerRaw);
  let shared;
  try {
    shared = crypto.diffieHellman({ privateKey, publicKey: peer });
  } catch {
    throw papError('PAP_X25519_LOW_ORDER', 'X25519 refused the peer key (low-order point)');
  }
  // An all-zero shared secret means a low-order peer key. Refuse it rather
  // than derive a key an attacker can predict.
  if (shared.every((b) => b === 0)) throw papError('PAP_X25519_LOW_ORDER', 'X25519 produced an all-zero shared secret');
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephPubRaw, recipientPubRaw]), DOMAIN_X25519_WRAP, 32));
}

/**
 * Returns the CEK, or null when this stanza is not for this key. Null covers
 * exactly two things: the stanza does not authenticate under this key, and a
 * low-order peer key (refused, so it is not a stanza for anyone). Any other
 * failure is a coded PAP_BAD_KEY and is not swallowed.
 */
function x25519Unwrap(wrapped, recipientPrivateKey, ephPubRaw) {
  if (!recipientPrivateKey || recipientPrivateKey.type !== 'private' || recipientPrivateKey.asymmetricKeyType !== 'x25519') {
    throw papError('PAP_BAD_KEY', 'recipient key is not an x25519 private key, expected x25519');
  }
  const recipientPubRaw = x25519RawPublic(recipientPrivateKey);
  let kek;
  try {
    kek = x25519Kek(recipientPrivateKey, ephPubRaw, ephPubRaw, recipientPubRaw);
  } catch (e) {
    if (e && e.code === 'PAP_X25519_LOW_ORDER') return null;
    throw badKey(e, 'cannot unwrap with this key');
  }
  return aeadOpen(kek, wrapped, null);
}

// ---------- passphrase ----------

function passphraseKek(passphrase, salt, iterations) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw new Error('passphrase must be a non-empty string');
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_PBKDF2_ITERATIONS) {
    throw papError('PAP_KDF_BAD_PARAMS', `PBKDF2 iterations must be 1..${MAX_PBKDF2_ITERATIONS}, got ${iterations}`);
  }
  return crypto.pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, iterations, 32, 'sha256');
}

// ---------- sealing (the only way in) ----------

/**
 * Start one seal. Returns the public stanzas and a body encryptor that runs
 * exactly once. The content key, the ephemeral private key and every KEK live
 * and die in this closure.
 *
 * @param {Object} opts
 * @param {Array<Buffer|string>} [opts.to] - X25519 recipient public keys
 * @param {string} [opts.passphrase] - optional passphrase recipient
 * @param {number} [opts.iterations] - PBKDF2 iterations, default 600000,
 *   floor 100000 (PAP_KDF_TOO_WEAK below it)
 * @returns {{ keyCommit: Buffer, ephemeralPub: Buffer|null,
 *             x25519Wrapped: Buffer[], passphrase: {salt, iterations, wrapped}|null,
 *             encryptBody: (plaintext: Buffer, headerBytes: Buffer) => Buffer }}
 */
function createSealer({ to = [], passphrase, iterations } = {}) {
  const recipients = to.map(parseRecipientPublicKey);
  const hasPassphrase = passphrase !== undefined && passphrase !== null;
  if (recipients.length === 0 && !hasPassphrase) {
    throw new Error('seal needs at least one recipient (seal.to) or a passphrase');
  }
  if (new Set(recipients.map((k) => k.toString('hex'))).size !== recipients.length) {
    throw new Error('seal.to lists the same recipient twice');
  }
  let rounds = null;
  if (hasPassphrase) {
    rounds = iterations === undefined ? DEFAULT_PBKDF2_ITERATIONS : iterations;
    if (Number.isInteger(rounds) && rounds < MIN_PBKDF2_ITERATIONS) {
      throw papError('PAP_KDF_TOO_WEAK',
        `PBKDF2 iterations ${rounds} is below the floor of ${MIN_PBKDF2_ITERATIONS}; the count is public in the bundle and a QR can be attacked offline`);
    }
  }

  const cek = crypto.randomBytes(CEK_LEN);
  let ephemeralPub = null;
  let x25519Wrapped = [];
  if (recipients.length > 0) {
    const eph = crypto.generateKeyPairSync('x25519');
    ephemeralPub = x25519RawPublic(eph.publicKey);
    x25519Wrapped = recipients.map((r, i) => {
      try {
        return aeadSeal(x25519Kek(eph.privateKey, r, ephemeralPub, r), cek, null);
      } catch (e) {
        if (e && e.code === 'PAP_X25519_LOW_ORDER') throw papError('PAP_BAD_KEY', `recipient key ${i} is a low-order point and cannot be sealed to`);
        throw e;
      }
    });
  }
  let passphraseStanza = null;
  if (hasPassphrase) {
    const salt = crypto.randomBytes(PASSPHRASE_SALT_LEN);
    const kek = passphraseKek(passphrase, salt, rounds);
    passphraseStanza = { salt, iterations: rounds, wrapped: aeadSeal(kek, cek, null) };
  }

  const keyCommit = keyCommitment(cek);
  const bodyEncryptionKey = bodyKey(cek);
  let used = false;
  return Object.freeze({
    keyCommit,
    ephemeralPub,
    x25519Wrapped,
    passphrase: passphraseStanza,
    encryptBody(plaintext, headerBytes) {
      if (used) {
        throw papError('PAP_SEALER_REUSED', 'this sealer already encrypted a body; the zero nonce is safe only once per key');
      }
      used = true;
      return aeadSeal(bodyEncryptionKey, plaintext, headerBytes);
    },
  });
}

// ---------- signed messages ----------

/**
 * The bytes the inner signature covers. Signing these with the chain key
 * binds the plaintext spine and memoir URL to the exact header they were
 * sealed under: signer, chain head, seq, timestamp, key commitment, and every
 * recipient stanza. Re-encrypting or re-addressing the same plaintext changes
 * the header, so the inner signature no longer verifies.
 */
function innerMessage(headerBytes, spineRaw, memoirUrlBytes) {
  return Buffer.concat([DOMAIN_INNER, NUL, sha256(headerBytes), sha256(spineRaw), sha256(memoirUrlBytes)]);
}

/**
 * The bytes the v2 OUTER signature covers: a domain string, a NUL, then the
 * whole manifest. v1 signs the bare manifest and stays that way; the domain
 * string keeps a v2 signature from ever being valid as anything else, and is
 * free now and impossible to add once the format is frozen.
 */
function outerMessage(manifestBytes) {
  return Buffer.concat([DOMAIN_OUTER, NUL, manifestBytes]);
}

export {
  CEK_LEN,
  GCM_TAG_LEN,
  DEFAULT_PBKDF2_ITERATIONS,
  MIN_PBKDF2_ITERATIONS,
  MAX_PBKDF2_ITERATIONS,
  createSealer,
  commitmentMatches,
  aeadOpen,
  openBody,
  x25519RawPublic,
  generateRecipientKeypair,
  parseRecipientPublicKey,
  parseRecipientPrivateKey,
  x25519Unwrap,
  passphraseKek,
  innerMessage,
  outerMessage,
};
