// TEST-ONLY. Do not import this from src/ or bin/.
//
// An independent reimplementation of the sealing primitives of manifest v2
// (docs/PAP-SEALED.md), written against node:crypto and nothing else. It
// exists for two reasons:
//
//   1. src/publish/seal.js no longer exports anything that encrypts under a
//      caller-supplied key with the fixed zero nonce (the single-use sealer is
//      the only way in). Tests and make-vectors.mjs still need to build
//      hostile bundles by hand: a re-addressed swap, a split key, a weak KDF,
//      a decompression bomb. They get the low-level pieces from here.
//   2. Because it shares no code with seal.js, a test that builds a bundle
//      here and opens it with the production reader (or the reverse) checks
//      the construction against the spec twice, not against itself.
//
// This file sits outside test/ on purpose: every .js under test/ is run by
// `node --test`, and this is a library, not a test. It enforces NO safety
// limits (no PBKDF2 floor, no single-use rule). That is its job, and the
// reason it must never ship in a bundle path.

import crypto from 'node:crypto';

export const OUTER_DOMAIN = Buffer.from('lotor/pap/v2/outer', 'utf8');
const NUL = Buffer.from([0]);
const ZERO_NONCE = Buffer.alloc(12);

const sha256 = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

export function generateContentKey() {
  return crypto.randomBytes(32);
}

export function keyCommitment(cek) {
  return sha256(Buffer.from('lotor/pap/v2/key-commit', 'utf8'), NUL, cek);
}

export function bodyKey(cek) {
  return Buffer.from(crypto.hkdfSync('sha256', cek, Buffer.alloc(0), 'lotor/pap/v2/body', 32));
}

/** AES-256-GCM with the fixed zero nonce. Callers must use each key once. */
export function aeadSeal(key, plaintext, aad) {
  const c = crypto.createCipheriv('aes-256-gcm', key, ZERO_NONCE);
  if (aad) c.setAAD(aad);
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}

export function aeadOpen(key, sealed, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, ZERO_NONCE);
  if (aad) d.setAAD(aad);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  try {
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  } catch {
    return null;
  }
}

export function x25519RawPublic(keyObj) {
  return keyObj.export({ format: 'der', type: 'spki' }).subarray(-32);
}

function x25519PublicFromRaw(raw) {
  return crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), raw]),
    format: 'der',
    type: 'spki',
  });
}

/** Wrap a content key to one recipient under an ephemeral key. */
export function x25519Wrap(cek, ephPrivateKey, ephPubRaw, recipientPubRaw) {
  const shared = crypto.diffieHellman({ privateKey: ephPrivateKey, publicKey: x25519PublicFromRaw(recipientPubRaw) });
  const kek = Buffer.from(crypto.hkdfSync(
    'sha256', shared, Buffer.concat([ephPubRaw, recipientPubRaw]), 'lotor/pap/v2/x25519-wrap', 32));
  return aeadSeal(kek, cek, null);
}

/** Wrap a content key under a passphrase. No iteration floor here. */
export function passphraseWrap(cek, passphrase, salt, iterations) {
  const kek = crypto.pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, iterations, 32, 'sha256');
  return aeadSeal(kek, cek, null);
}

export function innerMessage(headerBytes, spineRaw, memoirUrlBytes) {
  return Buffer.concat([
    Buffer.from('lotor/pap/v2/inner', 'utf8'), NUL, sha256(headerBytes), sha256(spineRaw), sha256(memoirUrlBytes),
  ]);
}

/** The bytes the v2 outer signature covers. */
export function outerMessage(manifestBytes) {
  return Buffer.concat([OUTER_DOMAIN, NUL, manifestBytes]);
}

/** Sign a v2 manifest the way a conforming writer does. */
export function signOuter(manifestBytes, signingKey) {
  return crypto.sign(null, outerMessage(manifestBytes), signingKey);
}
