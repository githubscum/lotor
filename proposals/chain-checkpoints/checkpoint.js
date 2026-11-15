import crypto from 'node:crypto';
import { leafHash, verifyInclusion, verifyConsistency } from './merkle.js';

/**
 * src/chain/checkpoint.js
 *
 * Signed checkpoints for the receipt chain, in the published formats, not a
 * new one:
 *
 *   - C2SP signed-note (c2sp.org/signed-note): note text, a blank line, then
 *     signature lines "<U+2014> <key name> base64(keyID4 || signature)".
 *     Ed25519, signature type 0x01, key ID = SHA-256(name || 0x0A || 0x01 ||
 *     pubkey32)[:4].
 *   - C2SP tlog-checkpoint (c2sp.org/tlog-checkpoint): note text is exactly
 *     three lines, origin, tree size, base64 RFC 6962 root. No extension
 *     lines are written (the spec does not recommend them).
 *
 * The signature-line marker is U+2014, which this repository otherwise bans
 * from its text. It is built with String.fromCharCode below so that the ban
 * stays checkable by a byte grep and the spec stays exact.
 *
 * Leaves are the chain's own entry hashes (32 raw bytes each, the SHA-256 of
 * the canonical entry). The entry hash already commits to seq, timestamp,
 * nonce, prevHash and payload, so a verifier needs no JSON canonicalisation
 * to check a proof, and a cartridge can cite a receipt by its hash alone.
 *
 * Everything here is pure: no file I/O, no clock. A stranger needs only a
 * proof object and the chain's raw 32-byte Ed25519 public key.
 */

const SIGNATURE_MARK = String.fromCharCode(0x2014);
const NL = String.fromCharCode(10);
const SIG_TYPE_ED25519 = 0x01;
const ORIGIN_PREFIX = 'lotor.local/chain/';

/** SPKI DER prefix for a raw Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function rawPublicKey(key) {
  if (Buffer.isBuffer(key) && key.length === 32) return key;
  const obj = crypto.createPublicKey(key);
  return obj.export({ format: 'der', type: 'spki' }).subarray(-32);
}

function publicKeyObject(raw32) {
  return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw32]), format: 'der', type: 'spki' });
}

/** The log origin (and key name) for a chain key: fixed, derived, offline. */
function originFor(publicKey) {
  const raw = rawPublicKey(publicKey);
  return ORIGIN_PREFIX + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function keyId(name, raw32) {
  return crypto.createHash('sha256')
    .update(Buffer.from(name, 'utf8'))
    .update(Buffer.from([0x0a, SIG_TYPE_ED25519]))
    .update(raw32)
    .digest()
    .subarray(0, 4);
}

/** C2SP verifier key string: name+hex(keyID)+base64(0x01 || pubkey). */
function vkey(name, publicKey) {
  const raw = rawPublicKey(publicKey);
  return `${name}+${keyId(name, raw).toString('hex')}+${Buffer.concat([Buffer.from([SIG_TYPE_ED25519]), raw]).toString('base64')}`;
}

/** Parse a C2SP vkey into { name, keyId, publicKeyRaw }. Throws on anything else. */
function parseVkey(s) {
  const parts = String(s).split('+');
  if (parts.length !== 3) throw new Error('vkey must have three +-separated parts');
  const [name, idHex, b64] = parts;
  const material = decodeCanonicalBase64(b64);
  if (material === null || material.length !== 33 || material[0] !== SIG_TYPE_ED25519) {
    throw new Error('vkey is not an Ed25519 (type 0x01) key');
  }
  const raw = material.subarray(1);
  if (keyId(name, raw).toString('hex') !== idHex) throw new Error('vkey key ID does not match its name and key');
  return { name, keyId: Buffer.from(idHex, 'hex'), publicKeyRaw: Buffer.from(raw) };
}

function decodeCanonicalBase64(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s, 'base64');
  return buf.toString('base64') === s ? buf : null;
}

function isValidKeyName(name) {
  return typeof name === 'string' && name.length > 0 && !/[\s+]/u.test(name);
}

/**
 * Sign note text (which must end in a newline) as a C2SP signed note.
 * @param {string} text
 * @param {string} name - key name
 * @param {crypto.KeyObject|string} privateKey - Ed25519 private key
 * @param {crypto.KeyObject|string|Buffer} publicKey - matching public key
 */
function signNote(text, name, privateKey, publicKey) {
  if (typeof text !== 'string' || !text.endsWith(NL)) throw new Error('note text must end in a newline');
  if (!isValidKeyName(name)) throw new Error(`invalid key name: ${name}`);
  const raw = rawPublicKey(publicKey);
  const sig = crypto.sign(null, Buffer.from(text, 'utf8'), privateKey);
  const blob = Buffer.concat([keyId(name, raw), sig]).toString('base64');
  return `${text}${NL}${SIGNATURE_MARK} ${name} ${blob}${NL}`;
}

/**
 * Split a signed note into its text and signature lines. Returns null for
 * anything that is not a well-formed note.
 */
function parseNote(note) {
  if (typeof note !== 'string' || !note.endsWith(NL)) return null;
  for (let i = 0; i < note.length; i++) {
    const c = note.charCodeAt(i);
    if (c < 0x20 && c !== 0x0a) return null;
  }
  const sep = note.lastIndexOf(NL + NL);
  if (sep < 0) return null;
  const text = note.slice(0, sep + 1);
  const sigLines = note.slice(sep + 2).split(NL);
  sigLines.pop(); // the note ends in a newline, so the last split part is ''
  if (sigLines.length === 0) return null;
  const signatures = [];
  for (const line of sigLines) {
    const prefix = SIGNATURE_MARK + ' ';
    if (!line.startsWith(prefix)) return null;
    const rest = line.slice(prefix.length);
    const space = rest.lastIndexOf(' ');
    if (space <= 0) return null;
    const name = rest.slice(0, space);
    const blob = decodeCanonicalBase64(rest.slice(space + 1));
    if (!isValidKeyName(name) || blob === null || blob.length < 5) return null;
    signatures.push({ name, keyId: blob.subarray(0, 4), signature: blob.subarray(4) });
  }
  return { text, signatures };
}

/**
 * Verify a signed note against one known Ed25519 key. Per the spec, signatures
 * from unknown keys are ignored, a known key whose signature fails rejects the
 * note, and a note with no verified known signature is rejected.
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
function verifyNote(note, name, publicKey) {
  const parsed = parseNote(note);
  if (parsed === null) return { ok: false, reason: 'not a well-formed signed note' };
  let raw;
  try {
    raw = rawPublicKey(publicKey);
  } catch (e) {
    return { ok: false, reason: 'unusable public key' };
  }
  const id = keyId(name, raw);
  const keyObj = publicKeyObject(raw);
  let verified = false;
  for (const s of parsed.signatures) {
    if (s.name !== name || !s.keyId.equals(id)) continue;
    const ok = s.signature.length === 64 &&
      crypto.verify(null, Buffer.from(parsed.text, 'utf8'), keyObj, s.signature);
    if (!ok) return { ok: false, reason: `signature by ${name} does not verify` };
    verified = true;
  }
  if (!verified) return { ok: false, reason: `no signature by ${name} (key ${id.toString('hex')})` };
  return { ok: true, text: parsed.text };
}

/** Checkpoint note text (unsigned) for a tree. */
function checkpointText(origin, size, root) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error(`tree size must be a non-negative safe integer, got ${size}`);
  if (!Buffer.isBuffer(root) || root.length !== 32) throw new Error('root must be 32 bytes');
  return `${origin}${NL}${size}${NL}${root.toString('base64')}${NL}`;
}

/** Parse verified checkpoint text into { origin, size, root }. Null if malformed. */
function parseCheckpointText(text) {
  const lines = text.split(NL);
  lines.pop();
  if (lines.length < 3) return null;
  const [origin, sizeStr, rootB64, ...extensions] = lines;
  if (!origin || !/^(0|[1-9][0-9]*)$/.test(sizeStr)) return null;
  const size = Number(sizeStr);
  if (!Number.isSafeInteger(size)) return null;
  const root = decodeCanonicalBase64(rootB64);
  if (root === null || root.length !== 32) return null;
  if (extensions.some((l) => l.length === 0)) return null;
  return { origin, size, root, extensions };
}

/** Sign a checkpoint for a chain key. Key name = origin, per the spec. */
function signCheckpoint({ size, root }, privateKey, publicKey) {
  const origin = originFor(publicKey);
  return signNote(checkpointText(origin, size, root), origin, privateKey, publicKey);
}

/**
 * Verify a checkpoint against a chain public key.
 * @returns {{ ok: true, origin, size, root } | { ok: false, reason }}
 */
function verifyCheckpoint(note, publicKey) {
  let origin;
  try {
    origin = originFor(publicKey);
  } catch (e) {
    return { ok: false, reason: 'unusable public key' };
  }
  const v = verifyNote(note, origin, publicKey);
  if (!v.ok) return v;
  const cp = parseCheckpointText(v.text);
  if (cp === null) return { ok: false, reason: 'checkpoint text is malformed' };
  if (cp.origin !== origin) return { ok: false, reason: `checkpoint origin ${cp.origin} is not this chain (${origin})` };
  if (cp.extensions.length !== 0) return { ok: false, reason: 'checkpoint carries extension lines; Lotor writes none' };
  return { ok: true, origin: cp.origin, size: cp.size, root: cp.root };
}

const HEX64 = /^[0-9a-f]{64}$/;

function hexList(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const h of list) {
    if (typeof h !== 'string' || !HEX64.test(h)) return null;
    out.push(Buffer.from(h, 'hex'));
  }
  return out;
}

/**
 * Verify an inclusion proof as produced by the store's proveInclusion():
 *   { leaf: <entry hash hex>, index: <seq>, size, path: [hex...], checkpoint: <signed note> }
 * Needs only the proof and the chain's public key.
 * @returns {{ ok: true, index, size, root } | { ok: false, reason }}
 */
function verifyInclusionProof(proof, publicKey) {
  if (proof === null || typeof proof !== 'object') return { ok: false, reason: 'proof is not an object' };
  const cp = verifyCheckpoint(proof.checkpoint, publicKey);
  if (!cp.ok) return { ok: false, reason: `checkpoint: ${cp.reason}` };
  if (proof.size !== cp.size) return { ok: false, reason: `proof is for tree size ${proof.size}, checkpoint is size ${cp.size}` };
  if (typeof proof.leaf !== 'string' || !HEX64.test(proof.leaf)) return { ok: false, reason: 'leaf must be a 64-hex entry hash' };
  const path = hexList(proof.path);
  if (path === null) return { ok: false, reason: 'path must be a list of 64-hex hashes' };
  const ok = verifyInclusion(proof.index, cp.size, leafHash(Buffer.from(proof.leaf, 'hex')), path, cp.root);
  if (!ok) return { ok: false, reason: `entry ${proof.leaf} is not at index ${proof.index} of the tree this checkpoint signs` };
  return { ok: true, index: proof.index, size: cp.size, root: cp.root };
}

/**
 * Verify that a newer checkpoint extends an older one:
 *   { from: <signed note>, to: <signed note>, path: [hex...] }
 * @returns {{ ok: true, from, to } | { ok: false, reason }}
 */
function verifyConsistencyProof(proof, publicKey) {
  if (proof === null || typeof proof !== 'object') return { ok: false, reason: 'proof is not an object' };
  const a = verifyCheckpoint(proof.from, publicKey);
  if (!a.ok) return { ok: false, reason: `older checkpoint: ${a.reason}` };
  const b = verifyCheckpoint(proof.to, publicKey);
  if (!b.ok) return { ok: false, reason: `newer checkpoint: ${b.reason}` };
  const path = hexList(proof.path);
  if (path === null) return { ok: false, reason: 'path must be a list of 64-hex hashes' };
  if (!verifyConsistency(a.size, b.size, a.root, b.root, path)) {
    return { ok: false, reason: `the size-${b.size} tree does not extend the size-${a.size} tree` };
  }
  return { ok: true, from: a.size, to: b.size };
}

export {
  SIGNATURE_MARK,
  originFor,
  keyId,
  vkey,
  parseVkey,
  signNote,
  parseNote,
  verifyNote,
  checkpointText,
  parseCheckpointText,
  signCheckpoint,
  verifyCheckpoint,
  verifyInclusionProof,
  verifyConsistencyProof,
  rawPublicKey
};
