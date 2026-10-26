/**
 * PAP seal: the crypto under a sealed (v2) bundle. No layout here; that is
 * manifest.js. No signing of the outer bundle here; that is pack.js.
 *
 * Construction (spec: docs/PAP-SEALED.md), published primitives only:
 *   - content key (CEK): 32 random bytes, fresh per bundle
 *   - key commitment: SHA-256("lotor/pap/v2/key-commit" 0x00 || CEK), public.
 *     AES-GCM is not key-committing, so without this an author could wrap a
 *     different CEK to each recipient and show each one a different plaintext
 *     under one valid signature (the multi-key or "invisible salamanders"
 *     attack). Every recipient checks the CEK it unwrapped against the one
 *     public commitment, so everyone who opens the bundle reads the same bytes.
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
 * WO-CARTRIDGE-SEAL, 2026-10-26. Queued for a signing sitting: src/publish is
 * core (src/grant/core-paths.js CORE_DIRS).
 */

import crypto from 'node:crypto';

const CEK_LEN = 32;
const GCM_TAG_LEN = 16;
const ZERO_NONCE = Buffer.alloc(12);
const NUL = Buffer.from([0]);

const DOMAIN_KEY_COMMIT = Buffer.from('lotor/pap/v2/key-commit', 'utf8');
const DOMAIN_BODY = 'lotor/pap/v2/body';
const DOMAIN_X25519_WRAP = 'lotor/pap/v2/x25519-wrap';
const DOMAIN_INNER = Buffer.from('lotor/pap/v2/inner', 'utf8');

const DEFAULT_PBKDF2_ITERATIONS = 600000;
const MAX_PBKDF2_ITERATIONS = 10000000;

// SPKI / PKCS8 DER prefixes for X25519, per RFC 8410 (OID 1.3.101.110).
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function generateContentKey() {
  return crypto.randomBytes(CEK_LEN);
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

// ---------- X25519 ----------

function x25519PublicFromRaw(raw32) {
  if (!Buffer.isBuffer(raw32) || raw32.length !== 32) throw new Error('X25519 public key must be 32 bytes');
  return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw32]), format: 'der', type: 'spki' });
}

function x25519PrivateFromRaw(raw32) {
  if (!Buffer.isBuffer(raw32) || raw32.length !== 32) throw new Error('X25519 private key must be 32 bytes');
  return crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, raw32]), format: 'der', type: 'pkcs8' });
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
  if (Buffer.isBuffer(input)) return x25519RawPublic(x25519PublicFromRaw(input));
  const s = String(input).trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return x25519RawPublic(x25519PublicFromRaw(Buffer.from(s, 'hex')));
  const k = crypto.createPublicKey(s);
  if (k.asymmetricKeyType !== 'x25519') throw new Error(`recipient key is ${k.asymmetricKeyType}, expected x25519`);
  return x25519RawPublic(k);
}

/** Accepts a KeyObject, a 32-byte Buffer, 64 hex chars, or a PKCS8 PEM string. */
function parseRecipientPrivateKey(input) {
  let k;
  if (input && typeof input === 'object' && input.type === 'private') k = input;
  else if (Buffer.isBuffer(input)) k = x25519PrivateFromRaw(input);
  else {
    const s = String(input).trim();
    k = /^[0-9a-f]{64}$/i.test(s) ? x25519PrivateFromRaw(Buffer.from(s, 'hex')) : crypto.createPrivateKey(s);
  }
  if (k.asymmetricKeyType !== 'x25519') throw new Error(`recipient key is ${k.asymmetricKeyType}, expected x25519`);
  return k;
}

function x25519Kek(privateKey, peerRaw, ephPubRaw, recipientPubRaw) {
  const shared = crypto.diffieHellman({ privateKey, publicKey: x25519PublicFromRaw(peerRaw) });
  // An all-zero shared secret means a low-order peer key. Refuse it rather
  // than derive a key an attacker can predict.
  if (shared.every((b) => b === 0)) throw new Error('X25519 produced an all-zero shared secret');
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephPubRaw, recipientPubRaw]), DOMAIN_X25519_WRAP, 32));
}

function x25519Wrap(cek, ephPrivateKey, ephPubRaw, recipientPubRaw) {
  return aeadSeal(x25519Kek(ephPrivateKey, recipientPubRaw, ephPubRaw, recipientPubRaw), cek, null);
}

/** Returns the CEK, or null when this stanza is not for this key. */
function x25519Unwrap(wrapped, recipientPrivateKey, ephPubRaw) {
  const recipientPubRaw = x25519RawPublic(recipientPrivateKey);
  let kek;
  try {
    kek = x25519Kek(recipientPrivateKey, ephPubRaw, ephPubRaw, recipientPubRaw);
  } catch {
    return null;
  }
  return aeadOpen(kek, wrapped, null);
}

// ---------- passphrase ----------

function passphraseKek(passphrase, salt, iterations) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw new Error('passphrase must be a non-empty string');
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_PBKDF2_ITERATIONS) {
    throw new Error(`PBKDF2 iterations must be 1..${MAX_PBKDF2_ITERATIONS}, got ${iterations}`);
  }
  return crypto.pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, iterations, 32, 'sha256');
}

// ---------- inner binding ----------

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

export {
  CEK_LEN,
  GCM_TAG_LEN,
  DEFAULT_PBKDF2_ITERATIONS,
  MAX_PBKDF2_ITERATIONS,
  generateContentKey,
  keyCommitment,
  commitmentMatches,
  bodyKey,
  aeadSeal,
  aeadOpen,
  x25519RawPublic,
  generateRecipientKeypair,
  parseRecipientPublicKey,
  parseRecipientPrivateKey,
  x25519Wrap,
  x25519Unwrap,
  passphraseKek,
  innerMessage,
};
