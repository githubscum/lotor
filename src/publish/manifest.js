/**
 * PAP manifest — binary layout, no crypto here.
 *
 * Encodes and decodes the on-disk (and in-QR) manifest structure. The
 * signature layer lives one level up in pack.js.
 *
 * The layout is deliberately fixed and version-tagged so a stranger with
 * the spec can reimplement the reader. Every integer is big-endian; every
 * length field is followed by exactly that many bytes.
 *
 * v1 layout, in order:
 *   version           u8   = 0x01
 *   chainHeadHash     32B  SHA-256 of the operator's Lotor chain head
 *   chainPubkeyFp     32B  raw Ed25519 public key (the chain's signing key)
 *   seq               u32  chain sequence number this bundle was minted at
 *   timestamp         u64  epoch milliseconds
 *   memoirUrlLen      u16  bytes of memoir_url that follow (0 = absent)
 *   memoirUrl         Nu8  UTF-8, must be exactly memoirUrlLen bytes
 *   spineLen          u16  bytes of brotli-compressed spine that follow
 *   spineCompressed   Nu8  brotli output
 *
 * Fixed header cost: 1 + 32 + 32 + 4 + 8 + 2 = 79 bytes.
 * Plus 2-byte spineLen tag = 81 bytes of overhead.
 * Signature adds 64 bytes on top.
 *
 * The QR v40 binary EC-L payload cap is 2953 bytes. So the useful budget
 * for (memoirUrl + compressedSpine) is 2953 - 81 - 64 = 2808 bytes.
 *
 * Ported from projects/spinoff/pap-prototype/src/manifest.js (WO-PAP-01,
 * built 2026-08-07, 13/13 tests green) with a CJS-to-ESM conversion only.
 * The byte layout is spec-frozen in BOOT-SPEC.md; layout changes bump the
 * version byte, never reinterpret v1.
 */

const VERSION = 0x01;
const CHAIN_HEAD_HASH_LEN = 32;
const CHAIN_PUBKEY_FP_LEN = 32;
const HEADER_FIXED_LEN = 1 + CHAIN_HEAD_HASH_LEN + CHAIN_PUBKEY_FP_LEN + 4 + 8 + 2;
const SPINE_LEN_TAG_BYTES = 2;
const SIG_LEN = 64;
const QR_V40_BINARY_ECL_CAPACITY = 2953;
const USEFUL_PAYLOAD_BUDGET = QR_V40_BINARY_ECL_CAPACITY - HEADER_FIXED_LEN - SPINE_LEN_TAG_BYTES - SIG_LEN;

/**
 * Encode a v1 manifest into bytes. Does NOT sign.
 * Throws with a helpful message when the input violates the layout.
 *
 * @param {Object} m
 * @param {Buffer} m.chainHeadHash - exactly 32 bytes
 * @param {Buffer} m.chainPubkeyFp - exactly 32 bytes
 * @param {number} m.seq - non-negative integer, fits in u32
 * @param {number} m.timestamp - epoch ms, fits in safe integer
 * @param {string} m.memoirUrl - UTF-8 string, may be empty
 * @param {Buffer} m.spineCompressed - brotli output, arbitrary length
 * @returns {Buffer}
 */
function encodeManifest(m) {
  requireBufferOfLength(m.chainHeadHash, CHAIN_HEAD_HASH_LEN, 'chainHeadHash');
  requireBufferOfLength(m.chainPubkeyFp, CHAIN_PUBKEY_FP_LEN, 'chainPubkeyFp');
  requireU32(m.seq, 'seq');
  requireSafeInteger(m.timestamp, 'timestamp');
  requireBuffer(m.spineCompressed, 'spineCompressed');

  const memoirUrlBytes = Buffer.from(m.memoirUrl || '', 'utf8');
  if (memoirUrlBytes.length > 0xFFFF) {
    throw new Error(`memoirUrl too long: ${memoirUrlBytes.length} bytes, max 65535`);
  }
  if (m.spineCompressed.length > 0xFFFF) {
    throw new Error(`spineCompressed too long: ${m.spineCompressed.length} bytes, max 65535`);
  }

  const totalLen =
    HEADER_FIXED_LEN +
    memoirUrlBytes.length +
    SPINE_LEN_TAG_BYTES +
    m.spineCompressed.length;

  const out = Buffer.allocUnsafe(totalLen);
  let off = 0;
  out.writeUInt8(VERSION, off); off += 1;
  m.chainHeadHash.copy(out, off); off += CHAIN_HEAD_HASH_LEN;
  m.chainPubkeyFp.copy(out, off); off += CHAIN_PUBKEY_FP_LEN;
  out.writeUInt32BE(m.seq, off); off += 4;
  writeUInt64BE(out, BigInt(m.timestamp), off); off += 8;
  out.writeUInt16BE(memoirUrlBytes.length, off); off += 2;
  memoirUrlBytes.copy(out, off); off += memoirUrlBytes.length;
  out.writeUInt16BE(m.spineCompressed.length, off); off += 2;
  m.spineCompressed.copy(out, off); off += m.spineCompressed.length;
  if (off !== totalLen) {
    throw new Error(`encoder wrote ${off} bytes but allocated ${totalLen}; encoder bug`);
  }
  return out;
}

/**
 * Decode a v1 manifest from bytes. Returns the parsed fields plus the raw
 * bytes that were the manifest (needed for signature verification).
 *
 * @param {Buffer} bytes
 * @returns {Object} { version, chainHeadHash, chainPubkeyFp, seq, timestamp,
 *                     memoirUrl, spineCompressed, manifestLen }
 */
function decodeManifest(bytes) {
  requireBuffer(bytes, 'manifest bytes');
  if (bytes.length < HEADER_FIXED_LEN + SPINE_LEN_TAG_BYTES) {
    throw new Error(
      `manifest too short: ${bytes.length} bytes, need at least ${HEADER_FIXED_LEN + SPINE_LEN_TAG_BYTES}`,
    );
  }
  let off = 0;
  const version = bytes.readUInt8(off); off += 1;
  if (version !== VERSION) {
    throw new Error(`unknown manifest version: 0x${version.toString(16)}, expected 0x${VERSION.toString(16)}`);
  }
  const chainHeadHash = Buffer.from(bytes.subarray(off, off + CHAIN_HEAD_HASH_LEN)); off += CHAIN_HEAD_HASH_LEN;
  const chainPubkeyFp = Buffer.from(bytes.subarray(off, off + CHAIN_PUBKEY_FP_LEN)); off += CHAIN_PUBKEY_FP_LEN;
  const seq = bytes.readUInt32BE(off); off += 4;
  const timestampBig = readUInt64BE(bytes, off); off += 8;
  const timestamp = Number(timestampBig);
  if (!Number.isSafeInteger(timestamp)) {
    throw new Error(`timestamp ${timestampBig} exceeds safe integer range`);
  }
  const memoirUrlLen = bytes.readUInt16BE(off); off += 2;
  if (off + memoirUrlLen + SPINE_LEN_TAG_BYTES > bytes.length) {
    throw new Error(`memoirUrl claims ${memoirUrlLen} bytes but manifest ends early`);
  }
  const memoirUrl = bytes.subarray(off, off + memoirUrlLen).toString('utf8'); off += memoirUrlLen;
  const spineLen = bytes.readUInt16BE(off); off += 2;
  if (off + spineLen !== bytes.length) {
    throw new Error(`spineLen ${spineLen} does not match trailing bytes ${bytes.length - off}`);
  }
  const spineCompressed = Buffer.from(bytes.subarray(off, off + spineLen)); off += spineLen;

  return {
    version,
    chainHeadHash,
    chainPubkeyFp,
    seq,
    timestamp,
    memoirUrl,
    spineCompressed,
    manifestLen: bytes.length,
  };
}

// ---------- internal helpers ----------

function requireBuffer(b, name) {
  if (!Buffer.isBuffer(b)) throw new TypeError(`${name} must be a Buffer, got ${typeof b}`);
}
function requireBufferOfLength(b, len, name) {
  requireBuffer(b, name);
  if (b.length !== len) throw new Error(`${name} must be exactly ${len} bytes, got ${b.length}`);
}
function requireU32(n, name) {
  if (!Number.isInteger(n) || n < 0 || n > 0xFFFFFFFF) {
    throw new Error(`${name} must be a u32 (0..4294967295), got ${n}`);
  }
}
function requireSafeInteger(n, name) {
  if (!Number.isInteger(n) || n < 0 || !Number.isSafeInteger(n)) {
    throw new Error(`${name} must be a non-negative safe integer, got ${n}`);
  }
}
function writeUInt64BE(buf, valueBig, offset) {
  // Do NOT apply `& 0xFFFFFFFF` after Number() — that returns a signed
  // int32, which breaks writeUInt32BE for any lo word >= 2^31. Mask on
  // the BigInt side, where the mask stays unsigned.
  const hi = Number((valueBig >> 32n) & 0xFFFFFFFFn);
  const lo = Number(valueBig & 0xFFFFFFFFn);
  buf.writeUInt32BE(hi, offset);
  buf.writeUInt32BE(lo, offset + 4);
}
function readUInt64BE(buf, offset) {
  const hi = BigInt(buf.readUInt32BE(offset));
  const lo = BigInt(buf.readUInt32BE(offset + 4));
  return (hi << 32n) | lo;
}

export {
  VERSION,
  HEADER_FIXED_LEN,
  SPINE_LEN_TAG_BYTES,
  SIG_LEN,
  QR_V40_BINARY_ECL_CAPACITY,
  USEFUL_PAYLOAD_BUDGET,
  encodeManifest,
  decodeManifest,
};
