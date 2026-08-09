/**
 * PAP pack — spine in, signed bundle bytes out. And back.
 *
 * This layer wraps three things around the manifest:
 *   1. brotli compression of the raw spine (measured, not assumed)
 *   2. Ed25519 signature over the manifest bytes
 *   3. budget enforcement against the QR v40 binary EC-L cap (2953 bytes)
 *
 * The signature covers exactly the manifest bytes — everything a reader
 * needs to verify authorship and integrity is inside the manifest. The
 * signature is appended after and is not itself signed (obviously).
 *
 * On-wire layout: manifestBytes || signatureBytes (64B).
 * Total = manifestBytes.length + 64. That is the number you compare to
 * the QR budget.
 *
 * Nothing in this file talks to Lotor's chain directly. A caller supplies
 * the Ed25519 signing key, chain head hash, chain pubkey fingerprint,
 * seq, and timestamp. bin/pap-export.js does the chain-state wiring; this
 * module stays testable with synthetic keys.
 *
 * Ported from projects/spinoff/pap-prototype/src/pack.js (WO-PAP-01,
 * built 2026-08-07, 13/13 tests green) with a CJS-to-ESM conversion only.
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {
  encodeManifest,
  decodeManifest,
  SIG_LEN,
  QR_V40_BINARY_ECL_CAPACITY,
} from './manifest.js';

const BROTLI_QUALITY_MAX = 11;

/**
 * @param {Object} inputs
 * @param {string} inputs.spine - the raw text spine to publish
 * @param {Buffer} inputs.chainHeadHash - 32 bytes
 * @param {Buffer} inputs.chainPubkeyFp - 32 bytes (raw Ed25519 public key)
 * @param {number} inputs.seq - u32
 * @param {number} inputs.timestamp - epoch ms
 * @param {string} [inputs.memoirUrl] - optional
 * @param {crypto.KeyObject|string} inputs.signingKey - Ed25519 private key
 * @returns {{ bundle: Buffer, manifestLen: number, sigLen: number,
 *             spineRawLen: number, spineCompressedLen: number,
 *             totalLen: number, budget: number, headroom: number,
 *             compressionRatio: number }}
 */
function pack(inputs) {
  if (typeof inputs.spine !== 'string' || inputs.spine.length === 0) {
    throw new Error('spine must be a non-empty string');
  }
  const spineRaw = Buffer.from(inputs.spine, 'utf8');
  const spineCompressed = brotliCompressMax(spineRaw);

  const manifestBytes = encodeManifest({
    chainHeadHash: inputs.chainHeadHash,
    chainPubkeyFp: inputs.chainPubkeyFp,
    seq: inputs.seq,
    timestamp: inputs.timestamp,
    memoirUrl: inputs.memoirUrl || '',
    spineCompressed,
  });

  const signature = crypto.sign(null, manifestBytes, inputs.signingKey);
  if (signature.length !== SIG_LEN) {
    throw new Error(`unexpected Ed25519 signature length: ${signature.length}, expected ${SIG_LEN}`);
  }

  const bundle = Buffer.concat([manifestBytes, signature]);
  const totalLen = bundle.length;
  const budget = QR_V40_BINARY_ECL_CAPACITY;
  const headroom = budget - totalLen;

  if (totalLen > budget) {
    const err = new Error(budgetMessage(spineRaw.length, spineCompressed.length, manifestBytes.length, totalLen, budget));
    err.code = 'PAP_BUDGET_EXCEEDED';
    err.spineRawLen = spineRaw.length;
    err.spineCompressedLen = spineCompressed.length;
    err.totalLen = totalLen;
    err.budget = budget;
    throw err;
  }

  return {
    bundle,
    manifestLen: manifestBytes.length,
    sigLen: signature.length,
    spineRawLen: spineRaw.length,
    spineCompressedLen: spineCompressed.length,
    totalLen,
    budget,
    headroom,
    compressionRatio: spineRaw.length / spineCompressed.length,
  };
}

/**
 * Reverse pack(). Verifies the signature against the supplied public key,
 * decompresses the spine, and returns the parsed manifest fields.
 *
 * @param {Object} inputs
 * @param {Buffer} inputs.bundle - manifestBytes || sig
 * @param {crypto.KeyObject} [inputs.verifyKey] - optional; if absent, uses
 *   the chainPubkeyFp inside the manifest as the raw Ed25519 public key.
 *   Passing an explicit key covers the case where the reader wants to
 *   confirm the bundle was signed by a specific known key rather than
 *   trusting the manifest's own claim.
 * @returns {{ manifest: Object, spine: string, spineRawLen: number,
 *             spineCompressedLen: number }}
 */
function unpack(inputs) {
  if (!Buffer.isBuffer(inputs.bundle)) throw new TypeError('bundle must be a Buffer');
  if (inputs.bundle.length < SIG_LEN + 1) {
    throw new Error(`bundle too short: ${inputs.bundle.length} bytes`);
  }
  const manifestBytes = inputs.bundle.subarray(0, inputs.bundle.length - SIG_LEN);
  const signature = inputs.bundle.subarray(inputs.bundle.length - SIG_LEN);
  const manifest = decodeManifest(Buffer.from(manifestBytes));

  const verifyKey = inputs.verifyKey || rawEd25519PublicKeyToKeyObject(manifest.chainPubkeyFp);
  const ok = crypto.verify(null, manifestBytes, verifyKey, signature);
  if (!ok) {
    const err = new Error('signature verification failed: bundle has been altered or was signed by a different key');
    err.code = 'PAP_SIGNATURE_INVALID';
    throw err;
  }

  const spineRaw = zlib.brotliDecompressSync(manifest.spineCompressed);
  const spine = spineRaw.toString('utf8');

  return {
    manifest,
    spine,
    spineRawLen: spineRaw.length,
    spineCompressedLen: manifest.spineCompressed.length,
  };
}

/**
 * Convenience: emit a fresh Ed25519 keypair. Not used in prod (the caller
 * supplies keys) but tests need it.
 */
function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyRaw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { publicKey, privateKey, publicKeyRaw };
}

// ---------- internal ----------

function brotliCompressMax(buf) {
  return zlib.brotliCompressSync(buf, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY_MAX,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    },
  });
}

function rawEd25519PublicKeyToKeyObject(raw32) {
  // SPKI DER prefix for Ed25519, per RFC 8410:
  //   SEQ(32) [ SEQ(6) [ OID(3) 1.3.101.112 ] BITSTR(34) [0x00 || pubkey32] ]
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    raw32,
  ]);
  return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

function budgetMessage(spineRaw, spineCompressed, manifestLen, totalLen, budget) {
  const excess = totalLen - budget;
  const spineOverBy = Math.ceil(excess * (spineRaw / spineCompressed));
  return (
    `PAP budget exceeded: bundle is ${totalLen} bytes, QR v40 binary EC-L cap is ${budget} bytes (${excess} bytes over).\n` +
    `  raw spine: ${spineRaw} bytes\n` +
    `  brotli compressed: ${spineCompressed} bytes (ratio ${(spineRaw / spineCompressed).toFixed(2)}x)\n` +
    `  manifest total: ${manifestLen} bytes\n` +
    `  signature: 64 bytes\n` +
    `Shrink the spine by roughly ${spineOverBy} raw bytes to fit, ` +
    `or split into multiple QRs.`
  );
}

export {
  pack,
  unpack,
  generateKeypair,
};
