/**
 * PAP reader: verify and open a PAP bundle with WebCrypto. No DOM, no network.
 *
 * This is the verify path. The page (view.js) only renders what these
 * functions return, so anything that displays "verified" takes it from here
 * and from nowhere else. A cartridge-style view later sits on the same calls.
 *
 * An implementation of the layouts in src/publish/manifest.js (v1) and
 * docs/PAP-SEALED.md (v2), written separately from the node code so the two
 * check each other against the shared vectors in test-data/pap-vectors/.
 *
 * deps: { subtle, brotliDecode(Uint8Array) -> Uint8Array,
 *         ed25519Fallback?: { verifyAsync(sig, msg, pub) } }
 * Every function is async and either returns a result or throws an Error
 * with a .code, the same codes pack.js uses.
 */

export const QR_CAP = 2953;
// Cap on a decoded spine, as in src/publish/pack.js (MAX_SPINE_RAW_BYTES). The
// vendored decoder has no output limit, so this is checked after the decode;
// what bounds the decode itself is refusing any bundle over QR_CAP up front.
export const MAX_SPINE_RAW_BYTES = 4 * 1024 * 1024;
const SIG_LEN = 64;
const V1 = 0x01;
const V2 = 0x02;
const V2_FIXED = 1 + 32 + 32 + 4 + 8 + 32 + 1 + 1;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false });
const ZERO_NONCE = new Uint8Array(12);

function fail(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

export function toHex(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function fromHex(s) {
  const t = String(s).trim();
  if (!/^([0-9a-f]{2})*$/i.test(t)) throw fail('PAP_BAD_INPUT', 'not hex');
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(t.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function u16(b, off) { return (b[off] << 8) | b[off + 1]; }
function u32(b, off) { return ((b[off] << 24) >>> 0) + (b[off + 1] << 16) + (b[off + 2] << 8) + b[off + 3]; }
function u64(b, off) {
  const v = u32(b, off) * 2 ** 32 + u32(b, off + 4);
  if (!Number.isSafeInteger(v)) throw fail('PAP_MALFORMED', 'timestamp exceeds safe integer range');
  return v;
}

async function sha256(subtle, ...parts) {
  return new Uint8Array(await subtle.digest('SHA-256', concat(...parts)));
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// ---------- layout ----------

/** Parse without verifying. Throws PAP_MALFORMED on any layout error. */
export function parse(bundle) {
  const b = bundle instanceof Uint8Array ? bundle : new Uint8Array(bundle);
  // A QR holds at most QR_CAP bytes, so a longer input is not a bundle from a
  // QR. Refusing it here, before any decoding, bounds the brotli input.
  if (b.length > QR_CAP) throw fail('PAP_BUNDLE_TOO_LARGE', `bundle is ${b.length} bytes; a QR holds at most ${QR_CAP}`);
  if (b.length < SIG_LEN + 1) throw fail('PAP_MALFORMED', `bundle too short: ${b.length} bytes`);
  const manifest = b.subarray(0, b.length - SIG_LEN);
  const signature = b.subarray(b.length - SIG_LEN);
  const m = manifest;
  const need = (off, n, what) => {
    if (off + n > m.length) throw fail('PAP_MALFORMED', `manifest ends early inside ${what}`);
  };
  const version = m[0];
  if (version === V1) {
    need(0, 79 + 2, 'v1 header');
    const memoirLen = u16(m, 77);
    need(79, memoirLen + 2, 'memoir URL');
    const spineLen = u16(m, 79 + memoirLen);
    if (79 + memoirLen + 2 + spineLen !== m.length) throw fail('PAP_MALFORMED', 'spineLen does not match the bytes that follow');
    return {
      version, sealed: false, manifest, signature,
      chainHeadHash: m.slice(1, 33), chainPubkeyFp: m.slice(33, 65),
      seq: u32(m, 65), timestamp: u64(m, 69),
      memoirUrl: dec.decode(m.subarray(79, 79 + memoirLen)),
      spineCompressed: m.slice(79 + memoirLen + 2),
    };
  }
  if (version === V2) {
    need(0, V2_FIXED + 2, 'v2 header');
    const x25519Count = m[V2_FIXED - 2];
    const passphraseCount = m[V2_FIXED - 1];
    if (passphraseCount > 1) throw fail('PAP_MALFORMED', 'passphraseCount must be 0 or 1');
    if (x25519Count === 0 && passphraseCount === 0) throw fail('PAP_MALFORMED', 'sealed manifest has no recipients');
    let off = V2_FIXED;
    let ephemeralPub = null;
    const stanzas = [];
    if (x25519Count > 0) {
      need(off, 32 + 48 * x25519Count, 'X25519 stanzas');
      ephemeralPub = m.slice(off, off + 32); off += 32;
      for (let i = 0; i < x25519Count; i++) { stanzas.push(m.slice(off, off + 48)); off += 48; }
    }
    let passphrase = null;
    if (passphraseCount === 1) {
      need(off, 16 + 4 + 48, 'passphrase stanza');
      passphrase = { salt: m.slice(off, off + 16), iterations: u32(m, off + 16), wrapped: m.slice(off + 20, off + 68) };
      off += 68;
    }
    const header = m.slice(0, off);
    need(off, 2, 'ciphertextLen');
    const ctLen = u16(m, off); off += 2;
    if (off + ctLen !== m.length) throw fail('PAP_MALFORMED', 'ciphertextLen does not match the bytes that follow');
    return {
      version, sealed: true, manifest, signature, header,
      chainHeadHash: m.slice(1, 33), chainPubkeyFp: m.slice(33, 65),
      seq: u32(m, 65), timestamp: u64(m, 69), keyCommit: m.slice(77, 109),
      ephemeralPub, stanzas, passphrase,
      ciphertext: m.slice(off),
      recipients: { x25519: x25519Count, passphrase: passphraseCount === 1 },
    };
  }
  throw fail('PAP_MALFORMED', `unknown manifest version 0x${version.toString(16)}`);
}

// ---------- crypto ----------

/**
 * WebCrypto Ed25519 where the browser has it, else the pinned noble-ed25519.
 * deps.forceFallback exists so the tests exercise the fallback in node.
 * Any error inside a verifier is a failed verification, never a pass.
 */
async function verifyEd25519(deps, pub, sig, msg) {
  if (!deps.forceFallback) {
    let key = null;
    try {
      key = await deps.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    } catch (err) {
      if (err && err.name !== 'NotSupportedError') return { ok: false, via: 'WebCrypto' };
    }
    if (key) {
      try {
        return { ok: await deps.subtle.verify({ name: 'Ed25519' }, key, sig, msg), via: 'WebCrypto' };
      } catch {
        return { ok: false, via: 'WebCrypto' };
      }
    }
  }
  if (!deps.ed25519Fallback) throw fail('PAP_NO_ED25519', 'this browser has no Ed25519 in WebCrypto and no fallback was loaded');
  try {
    return { ok: (await deps.ed25519Fallback.verifyAsync(sig, msg, pub)) === true, via: 'noble-ed25519 fallback' };
  } catch {
    return { ok: false, via: 'noble-ed25519 fallback' };
  }
}

/** brotli with PAP error codes and the 4 MiB output cap (checked after the decode). */
function inflate(deps, compressed) {
  let out;
  try {
    out = deps.brotliDecode(compressed);
  } catch (err) {
    throw fail('PAP_DECOMPRESS_FAILED', 'spine is not valid brotli');
  }
  if (out.length > MAX_SPINE_RAW_BYTES) {
    throw fail('PAP_SPINE_TOO_LARGE', `spine decompresses past the ${MAX_SPINE_RAW_BYTES}-byte cap`);
  }
  return out;
}

/** A content key is 32 bytes or 64 hex characters (surrounding whitespace is ignored). */
function parseContentKey(input) {
  if (input instanceof Uint8Array && input.length === 32) return input;
  if (typeof input === 'string' && /^[0-9a-f]{64}$/i.test(input.trim())) return fromHex(input);
  throw fail('PAP_BAD_CONTENT_KEY', 'a content key is 64 hex characters');
}

async function aesGcmOpen(subtle, keyBytes, sealed, aad) {
  const key = await subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const params = { name: 'AES-GCM', iv: ZERO_NONCE, tagLength: 128 };
  if (aad) params.additionalData = aad;
  try {
    return new Uint8Array(await subtle.decrypt(params, key, sealed));
  } catch {
    return null;
  }
}

async function hkdf(subtle, ikm, salt, info) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, key, 256));
}

const X25519_PKCS8_PREFIX = fromHex('302e020100300506032b656e04220420');

function base64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Accepts 64 hex chars (raw X25519 secret) or a PKCS8 PEM. */
export async function importRecipientKey(subtle, input) {
  const s = String(input).trim();
  let pkcs8;
  if (/^[0-9a-f]{64}$/i.test(s)) pkcs8 = concat(X25519_PKCS8_PREFIX, fromHex(s));
  else if (s.includes('BEGIN PRIVATE KEY')) {
    const body = s.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    pkcs8 = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  } else throw fail('PAP_BAD_KEY', 'a recipient key is 64 hex characters or a PKCS8 PEM');
  let priv;
  try {
    priv = await subtle.importKey('pkcs8', pkcs8, { name: 'X25519' }, true, ['deriveBits']);
  } catch (err) {
    if (err && err.name === 'NotSupportedError') throw fail('PAP_NO_X25519', 'this browser has no X25519 in WebCrypto; open the bundle with pap-boot instead');
    throw fail('PAP_BAD_KEY', 'that is not an X25519 private key');
  }
  const jwk = await subtle.exportKey('jwk', priv);
  return { priv, pubRaw: base64urlToBytes(jwk.x) };
}

async function unwrapX25519(subtle, recipient, ephemeralPub, wrapped) {
  const eph = await subtle.importKey('raw', ephemeralPub, { name: 'X25519' }, false, []);
  let shared;
  try {
    shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: eph }, recipient.priv, 256));
  } catch {
    return null;
  }
  if (shared.every((x) => x === 0)) return null;
  const kek = await hkdf(subtle, shared, concat(ephemeralPub, recipient.pubRaw), 'lotor/pap/v2/x25519-wrap');
  return aesGcmOpen(subtle, kek, wrapped, null);
}

async function unwrapPassphrase(subtle, passphrase, p) {
  if (p.iterations < 1 || p.iterations > 10000000) throw fail('PAP_MALFORMED', `PBKDF2 iterations out of range: ${p.iterations}`);
  const key = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const kek = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: p.salt, iterations: p.iterations }, key, 256));
  return aesGcmOpen(subtle, kek, p.wrapped, null);
}

// ---------- public API ----------

/**
 * Verify the outer signature. Needs no key. Never throws for a bad bundle:
 * returns { ok: false, code, reason } so a view can show why.
 */
export async function verify(bundle, deps) {
  let p;
  try {
    p = parse(bundle);
  } catch (err) {
    return { ok: false, code: err.code || 'PAP_MALFORMED', reason: err.message, bytes: bundle.length, cap: QR_CAP };
  }
  // v2 signs a domain string and the manifest (docs/PAP-SEALED.md); v1 signs the bare manifest.
  const signed = p.sealed ? concat(enc.encode('lotor/pap/v2/outer'), new Uint8Array([0]), p.manifest) : p.manifest;
  const v = await verifyEd25519(deps, p.chainPubkeyFp, p.signature, signed);
  const facts = {
    bytes: bundle.length,
    cap: QR_CAP,
    version: p.version,
    sealed: p.sealed,
    signerFingerprint: toHex(p.chainPubkeyFp),
    chainHead: toHex(p.chainHeadHash),
    seq: p.seq,
    timestamp: p.timestamp,
    recipients: p.sealed ? p.recipients : null,
    verifiedVia: v.via,
  };
  if (!v.ok) {
    return { ok: false, code: 'PAP_SIGNATURE_INVALID', reason: 'signature does not verify under the key this bundle carries: altered after signing, or not signed by that key', ...facts };
  }
  // The page never has a key of its own to supply, so a pass is always
  // self-consistency with the fingerprint the bundle carries. Comparing that
  // fingerprint with one you trust is the reader's job, not a check made here.
  return { ok: true, trust: 'self-consistent', ...facts };
}

/**
 * Verify, then open. opener: {} for v1; for v2 one of { recipientKey,
 * passphrase, contentKey }. Throws coded errors.
 */
export async function open(bundle, opener, deps) {
  const v = await verify(bundle, deps);
  if (!v.ok) throw fail(v.code, v.reason, { verification: v });
  const p = parse(bundle);
  if (!p.sealed) {
    const spine = dec.decode(inflate(deps, p.spineCompressed));
    return { verification: v, spine, memoirUrl: p.memoirUrl };
  }
  const subtle = deps.subtle;
  let cek = null;
  if (opener && opener.contentKey !== undefined && opener.contentKey !== null) {
    cek = parseContentKey(opener.contentKey);
  } else if (!opener || (opener.recipientKey === undefined && opener.passphrase === undefined)) {
    throw fail('PAP_SEALED_NEEDS_KEY', 'verified and sealed; no key given', { verification: v });
  } else {
    if (opener.passphrase !== undefined && p.passphrase) cek = await unwrapPassphrase(subtle, opener.passphrase, p.passphrase);
    if (!cek && opener.recipientKey !== undefined && p.ephemeralPub) {
      const r = await importRecipientKey(subtle, opener.recipientKey);
      for (const w of p.stanzas) {
        cek = await unwrapX25519(subtle, r, p.ephemeralPub, w);
        if (cek) break;
      }
    }
    if (!cek) throw fail('PAP_NOT_A_RECIPIENT', 'this key does not open the bundle (the signature did verify)', { verification: v });
  }
  const commit = await sha256(subtle, enc.encode('lotor/pap/v2/key-commit'), new Uint8Array([0]), cek);
  if (cek.length !== 32 || !equal(commit, p.keyCommit)) {
    throw fail('PAP_KEY_COMMIT_MISMATCH', 'content key does not match the key commitment', { verification: v });
  }
  const bodyKey = await hkdf(subtle, cek, new Uint8Array(0), 'lotor/pap/v2/body');
  const inner = await aesGcmOpen(subtle, bodyKey, p.ciphertext, p.header);
  if (!inner || inner.length < SIG_LEN + 2) throw fail('PAP_DECRYPT_FAILED', 'sealed body failed authentication', { verification: v });
  const innerSig = inner.subarray(0, SIG_LEN);
  const memoirLen = u16(inner, SIG_LEN);
  if (SIG_LEN + 2 + memoirLen > inner.length) throw fail('PAP_DECRYPT_FAILED', 'sealed body is malformed', { verification: v });
  const memoir = inner.subarray(SIG_LEN + 2, SIG_LEN + 2 + memoirLen);
  const spineRaw = inflate(deps, inner.subarray(SIG_LEN + 2 + memoirLen));
  const msg = concat(
    enc.encode('lotor/pap/v2/inner'), new Uint8Array([0]),
    await sha256(subtle, p.header), await sha256(subtle, spineRaw), await sha256(subtle, memoir),
  );
  const iv = await verifyEd25519(deps, p.chainPubkeyFp, innerSig, msg);
  if (!iv.ok) {
    throw fail('PAP_INNER_BINDING_INVALID', 'inner binding failed: re-encrypted, re-addressed, or re-signed by someone else', { verification: v });
  }
  return { verification: v, spine: dec.decode(spineRaw), memoirUrl: dec.decode(memoir), contentKey: toHex(cek) };
}
