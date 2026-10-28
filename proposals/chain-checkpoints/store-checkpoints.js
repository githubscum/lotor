import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyRange, GENESIS_PREV_HASH } from '../chain/index.js';
import {
  leafHash,
  rootFromLeafHashes,
  inclusionPath,
  verifyInclusion,
  consistencyProof,
  frontierAppend,
  frontierRoot,
  popcount
} from '../chain/merkle.js';
import { signCheckpoint, verifyCheckpoint, verifyInclusionProof, verifyConsistencyProof } from '../chain/checkpoint.js';
import { withLock } from './lock.js';

/**
 * src/store/checkpoints.js
 *
 * Chain segments, signed checkpoints and inclusion proofs (WO-CARTRIDGE-SEAL
 * part B). chain.jsonl is never rewritten: every checkpoint lives in a
 * sidecar, receipts/checkpoints.jsonl, one JSON record per line:
 *
 *   { v: 1, size, offset, lastHash, lastPath: [hex], frontier: [hex],
 *     segmentRoot, note }
 *
 *   size        entries covered (seq 0 .. size-1); a multiple of the segment
 *               size, except a checkpoint sealed at the head on demand
 *               ({ atHead: true }), after which the next segment seal fills
 *               up to the next multiple again
 *   offset      byte offset in chain.jsonl just past entry size-1's newline
 *   lastHash    entry size-1's hash; prevHash of entry `size` must equal it
 *   lastPath    RFC 9162 inclusion path of lastHash at index size-1. For the
 *               last leaf this is the frontier of size-1, reversed.
 *   frontier    the compact range of the tree at `size`: enough to extend it
 *               without reading the entries before `size`
 *   segmentRoot MTH of the leaves this record's segment added (informational:
 *               it is signed only through the cumulative root)
 *   note        the C2SP tlog-checkpoint signed note for (origin, size, root)
 *
 * Only `note` is signed. Everything else is a cache that the readers below
 * check against the signed root before using it (frontier folds to the root;
 * lastHash is proven into it by lastPath), so a tampered sidecar fails closed
 * instead of being trusted.
 *
 * Locking: each segment is sealed under its own withLock() acquisition, never
 * a whole migration under one, because the lock is considered stale after 30
 * s (src/store/lock.js) and appends give up after 5 s (KNOWN-LIMITS 7). One
 * segment of 1024 entries verifies in about 80 ms (measured 2026-10-26).
 *
 * Signing uses the chain key (KNOWN-LIMITS 8 and 48 apply unchanged): a
 * checkpoint shows that the key holder committed to a history. It catches a
 * later rewrite only for someone who kept an earlier checkpoint, because the
 * same key can sign a fresh set for a rewritten chain.
 */

/** Entries per sealed segment. Power of two: see proposals/chain-checkpoints.md for the measurement. */
const SEGMENT_SIZE = 1024;

const SIDECAR_NAME = 'checkpoints.jsonl';
const RECORD_VERSION = 1;
const HEX64 = /^[0-9a-f]{64}$/;

function sidecarPath(baseDir) {
  return path.join(baseDir, 'receipts', SIDECAR_NAME);
}

function chainPath(baseDir) {
  return path.join(baseDir, 'receipts', 'chain.jsonl');
}

function toPublicKeyObject(publicKey) {
  return crypto.createPublicKey(publicKey);
}

function hexes(list) {
  return list.map((b) => b.toString('hex'));
}

function buffers(list, what) {
  if (!Array.isArray(list)) throw new Error(`${what} is not a list`);
  return list.map((h) => {
    if (typeof h !== 'string' || !HEX64.test(h)) throw new Error(`${what} holds a value that is not a 64-hex hash`);
    return Buffer.from(h, 'hex');
  });
}

/**
 * Read the sidecar. A missing file is no checkpoints. A line that does not
 * parse is an error, not a skip: silently dropping a checkpoint would let a
 * reader start from an older one without knowing.
 */
function readCheckpointRecords(baseDir) {
  const file = sidecarPath(baseDir);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      throw new Error(`lotor: ${SIDECAR_NAME} line ${i + 1} is not valid JSON`);
    }
    if (rec === null || typeof rec !== 'object' || rec.v !== RECORD_VERSION) {
      throw new Error(`lotor: ${SIDECAR_NAME} line ${i + 1} is not a v${RECORD_VERSION} checkpoint record`);
    }
    records.push(rec);
  }
  for (let i = 1; i < records.length; i++) {
    if (!(records[i].size > records[i - 1].size)) {
      throw new Error(`lotor: ${SIDECAR_NAME} sizes do not increase at record ${i + 1}`);
    }
  }
  return records;
}

/**
 * Read complete entry lines from chain.jsonl starting at a byte offset.
 * Stops after maxEntries entries, or at the last complete line (a torn tail
 * with no newline is left for later). Blank lines are skipped, as loadChain
 * skips them. A line that does not parse is an error here, where loadChain
 * would drop it: a checkpoint must never cover a line nobody could read.
 *
 * @returns {{ entries: Array<{ entry: Object, end: number }>, fileSize: number }}
 */
function readEntriesFrom(baseDir, offset, maxEntries = Infinity) {
  const file = chainPath(baseDir);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (offset !== 0) throw new Error(`lotor: chain.jsonl is missing but a checkpoint covers it up to byte ${offset}`);
      return { entries: [], fileSize: 0 };
    }
    throw err;
  }
  try {
    const fileSize = fs.fstatSync(fd).size;
    if (offset > fileSize) {
      throw new Error(`lotor: chain.jsonl is ${fileSize} bytes but a checkpoint covers it up to byte ${offset} (truncated)`);
    }
    const entries = [];
    const CHUNK = 1024 * 1024;
    let pos = offset;
    let carry = Buffer.alloc(0);
    let carryStart = offset;
    while (pos < fileSize && entries.length < maxEntries) {
      const len = Math.min(CHUNK, fileSize - pos);
      const buf = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const n = fs.readSync(fd, buf, got, len - got, pos + got);
        if (n === 0) throw new Error('lotor: chain file shrank while it was being read');
        got += n;
      }
      pos += len;
      const data = carry.length ? Buffer.concat([carry, buf]) : buf;
      let lineStart = 0;
      for (;;) {
        if (entries.length >= maxEntries) break;
        const nl = data.indexOf(0x0a, lineStart);
        if (nl < 0) break;
        const line = data.toString('utf8', lineStart, nl);
        const end = carryStart + nl + 1;
        if (line.trim() !== '') {
          let entry;
          try {
            entry = JSON.parse(line);
          } catch {
            throw new Error(`lotor: chain.jsonl has an unparseable line ending at byte ${end}`);
          }
          entries.push({ entry, end });
        }
        lineStart = nl + 1;
      }
      carry = data.subarray(lineStart);
      carryStart += lineStart;
    }
    return { entries, fileSize };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Check a record's caches against its own signed note. Returns the state a
 * reader may extend from, or throws with the reason.
 */
function trustedStateFrom(record, publicKey) {
  const cp = verifyCheckpoint(record.note, publicKey);
  if (!cp.ok) throw new Error(`checkpoint at size ${record.size}: ${cp.reason}`);
  if (cp.size !== record.size) throw new Error(`checkpoint record says size ${record.size} but its note signs size ${cp.size}`);
  if (!Number.isSafeInteger(record.offset) || record.offset < 0) throw new Error(`checkpoint at size ${cp.size} has no usable byte offset`);
  const frontier = buffers(record.frontier, `checkpoint ${cp.size} frontier`);
  if (frontier.length !== popcount(cp.size) || !frontierRoot(frontier).equals(cp.root)) {
    throw new Error(`checkpoint at size ${cp.size}: cached frontier does not fold to the signed root`);
  }
  let lastHash = GENESIS_PREV_HASH;
  if (cp.size > 0) {
    if (typeof record.lastHash !== 'string' || !HEX64.test(record.lastHash)) {
      throw new Error(`checkpoint at size ${cp.size} has no usable lastHash`);
    }
    const lastPath = buffers(record.lastPath, `checkpoint ${cp.size} lastPath`);
    if (!verifyInclusion(cp.size - 1, cp.size, leafHash(Buffer.from(record.lastHash, 'hex')), lastPath, cp.root)) {
      throw new Error(`checkpoint at size ${cp.size}: lastHash is not leaf ${cp.size - 1} of the signed tree`);
    }
    lastHash = record.lastHash;
  }
  return { size: cp.size, root: cp.root, frontier, offset: record.offset, lastHash, note: record.note };
}

const GENESIS_STATE = Object.freeze({ size: 0, root: null, frontier: [], offset: 0, lastHash: GENESIS_PREV_HASH, note: null });

/**
 * Walk entries forward from a trusted state: verify them as a chain range,
 * extend the tree, and check every later checkpoint record against the tree
 * this walk computes. Read-only.
 */
function walkFrom(state, items, laterRecords, publicKeyObj, publicKey) {
  const entries = items.map((x) => x.entry);
  const range = verifyRange(entries, publicKeyObj, { startSeq: state.size, prevHash: state.lastHash });
  if (!range.ok) return range;

  let frontier = state.frontier;
  let size = state.size;
  let ri = 0;
  let segmentLeaves = [];
  for (let i = 0; i < items.length; i++) {
    const leaf = leafHash(Buffer.from(entries[i].hash, 'hex'));
    frontier = frontierAppend(frontier, size, leaf);
    size++;
    segmentLeaves.push(leaf);
    while (ri < laterRecords.length && laterRecords[ri].size === size) {
      const rec = laterRecords[ri];
      const cp = verifyCheckpoint(rec.note, publicKey);
      if (!cp.ok) return { ok: false, brokenAt: size - 1, reason: `checkpoint at size ${size}: ${cp.reason}` };
      if (cp.size !== size) return { ok: false, brokenAt: size - 1, reason: `checkpoint record at size ${size} signs size ${cp.size}` };
      if (!frontierRoot(frontier).equals(cp.root)) {
        return { ok: false, brokenAt: size - 1, reason: `entries 0..${size - 1} do not hash to the root the size-${size} checkpoint signs` };
      }
      if (rec.offset !== items[i].end || rec.lastHash !== entries[i].hash) {
        return { ok: false, brokenAt: size - 1, reason: `checkpoint record at size ${size} has a stale offset or lastHash` };
      }
      if (rec.segmentRoot !== rootFromLeafHashes(segmentLeaves).toString('hex')) {
        return { ok: false, brokenAt: size - 1, reason: `checkpoint record at size ${size} has a segmentRoot its entries do not produce` };
      }
      segmentLeaves = [];
      ri++;
    }
  }
  if (ri < laterRecords.length) {
    return { ok: false, brokenAt: size, reason: `a checkpoint covers ${laterRecords[ri].size} entries but the chain has ${size} (truncated or rewritten)` };
  }
  return { ok: true, size };
}

/**
 * Seal every complete segment not yet sealed. Never rewrites chain.jsonl;
 * appends records to the sidecar. On a chain with no sidecar this is the
 * migration: the first checkpoint covers seq 0 .. segmentSize-1 of the file
 * as it already is.
 *
 * Refuses (throws) when the entries to be sealed do not verify, or when the
 * last record does not check out against its own signature: it never signs
 * over a history it could not verify.
 *
 * options.atHead: after the complete segments, also seal whatever is left
 *   at the head (a partial segment), so the newest receipt can be proven now
 *   rather than after the segment fills. A prediction signed before its
 *   outcome needs this.
 *
 * @returns {{ sealed: number, size: number }} checkpoints written, and the
 *   size the newest checkpoint covers
 */
function sealCheckpoints(baseDir, keyPair, options = {}) {
  const segmentSize = options.segmentSize === undefined ? SEGMENT_SIZE : options.segmentSize;
  if (!Number.isSafeInteger(segmentSize) || segmentSize < 1) throw new Error(`segmentSize must be a positive integer, got ${segmentSize}`);
  const maxSegments = options.maxSegments === undefined ? Infinity : options.maxSegments;
  const publicKeyObj = toPublicKeyObject(keyPair.publicKey);
  let sealed = 0;
  let size = null;
  const step = (atHead) => {
    const rec = withLock(baseDir, () => sealOneSegment(baseDir, keyPair, publicKeyObj, segmentSize, atHead));
    if (rec === null) return false;
    sealed++;
    size = rec.size;
    return true;
  };
  while (sealed < maxSegments && step(false)) { /* one segment per lock */ }
  if (options.atHead === true && sealed < maxSegments) step(true);
  if (size === null) {
    const records = readCheckpointRecords(baseDir);
    size = records.length ? records[records.length - 1].size : 0;
  }
  return { sealed, size };
}

function sealOneSegment(baseDir, keyPair, publicKeyObj, segmentSize, atHead) {
  const records = readCheckpointRecords(baseDir);
  const state = records.length ? trustedStateFrom(records[records.length - 1], keyPair.publicKey) : GENESIS_STATE;
  // Segments end on multiples of segmentSize, so a head checkpoint taken on
  // demand does not shift the boundaries of the ones after it.
  const want = (Math.floor(state.size / segmentSize) + 1) * segmentSize - state.size;
  const { entries: items } = readEntriesFrom(baseDir, state.offset, want);
  if (items.length === 0 || (items.length < want && !atHead)) return null;

  const entries = items.map((x) => x.entry);
  const range = verifyRange(entries, publicKeyObj, { startSeq: state.size, prevHash: state.lastHash });
  if (!range.ok) throw new Error(`lotor: refusing to seal: ${range.reason}`);

  let frontier = state.frontier;
  let size = state.size;
  let lastPath = [];
  const segmentLeaves = [];
  for (const e of entries) {
    const leaf = leafHash(Buffer.from(e.hash, 'hex'));
    lastPath = frontier.slice().reverse();
    frontier = frontierAppend(frontier, size, leaf);
    size++;
    segmentLeaves.push(leaf);
  }
  const root = frontierRoot(frontier);
  const note = signCheckpoint({ size, root }, keyPair.privateKey, keyPair.publicKey);
  const record = {
    v: RECORD_VERSION,
    size,
    offset: items[items.length - 1].end,
    lastHash: entries[entries.length - 1].hash,
    lastPath: hexes(lastPath),
    frontier: hexes(frontier),
    segmentRoot: rootFromLeafHashes(segmentLeaves).toString('hex'),
    note
  };
  const file = sidecarPath(baseDir);
  if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  return record;
}

/**
 * Verify starting from a trusted checkpoint instead of genesis. Read-only.
 *
 * options.trusted: a checkpoint note the caller already trusts (one they kept,
 *   or one a cartridge carried). The sidecar must hold a record for the same
 *   size with the same signed root, or the result is a fork. Omitted: the
 *   newest sidecar record is the starting point.
 *
 * Reads only the entries after the starting checkpoint. With no checkpoint at
 * all it reads from genesis, which is the full verify.
 *
 * @returns {{ ok: true, mode, from, size } | { ok: false, reason, brokenAt? }}
 */
function verifyIncremental(baseDir, publicKey, options = {}) {
  const publicKeyObj = toPublicKeyObject(publicKey);
  let records;
  try {
    records = readCheckpointRecords(baseDir);
  } catch (e) {
    return { ok: false, reason: e.message };
  }

  let startIndex = records.length - 1;
  if (options.trusted !== undefined) {
    const t = verifyCheckpoint(options.trusted, publicKey);
    if (!t.ok) return { ok: false, reason: `trusted checkpoint: ${t.reason}` };
    startIndex = records.findIndex((r) => r.size === t.size);
    if (startIndex < 0) return { ok: false, reason: `no sealed checkpoint at size ${t.size}: this chain does not contain the checkpoint you trust` };
    const mine = verifyCheckpoint(records[startIndex].note, publicKey);
    if (!mine.ok || !mine.root.equals(t.root)) {
      return { ok: false, reason: `fork: the size-${t.size} checkpoint on disk does not sign the root you trust` };
    }
  }

  let state = GENESIS_STATE;
  if (startIndex >= 0) {
    try {
      state = trustedStateFrom(records[startIndex], publicKey);
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }
  let items;
  try {
    ({ entries: items } = readEntriesFrom(baseDir, state.offset));
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  const result = walkFrom(state, items, records.slice(startIndex + 1), publicKeyObj, publicKey);
  if (!result.ok) return result;
  return { ok: true, mode: startIndex >= 0 ? 'incremental' : 'full', from: state.size, size: result.size };
}

/**
 * Full verify of the chain AND every checkpoint, from genesis. Read-only.
 * The plain chain verify (store.verify) is unchanged and still available.
 */
function verifySealed(baseDir, publicKey) {
  const publicKeyObj = toPublicKeyObject(publicKey);
  let records;
  let items;
  try {
    records = readCheckpointRecords(baseDir);
    ({ entries: items } = readEntriesFrom(baseDir, 0));
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  const result = walkFrom(GENESIS_STATE, items, records, publicKeyObj, publicKey);
  if (!result.ok) return result;
  return { ok: true, mode: 'full', from: 0, size: result.size, checkpoints: records.length };
}

function recordForSize(records, size) {
  if (records.length === 0) throw new Error('lotor: no sealed checkpoint yet; run seal first');
  if (size === undefined) return records[records.length - 1];
  const rec = records.find((r) => r.size === size);
  if (!rec) throw new Error(`lotor: no sealed checkpoint at size ${size}`);
  return rec;
}

function leafHashesUpTo(baseDir, size) {
  const { entries: items } = readEntriesFrom(baseDir, 0, size);
  if (items.length < size) throw new Error(`lotor: chain has ${items.length} entries, checkpoint needs ${size}`);
  return items.map((x) => x.entry);
}

/**
 * Inclusion proof for the entry at `seq` against a sealed checkpoint (the
 * newest by default, or options.size). Reads the entries the checkpoint
 * covers. The proof is checked before it is returned, so a chain that no
 * longer matches its checkpoint throws here instead of handing out a proof
 * that will fail somewhere else.
 *
 * @returns {{ leaf, index, size, path: string[], checkpoint: string }}
 */
function proveInclusion(baseDir, publicKey, seq, options = {}) {
  const rec = recordForSize(readCheckpointRecords(baseDir), options.size);
  if (!Number.isSafeInteger(seq) || seq < 0 || seq >= rec.size) {
    throw new Error(`lotor: seq ${seq} is not covered by the size-${rec.size} checkpoint (it covers 0..${rec.size - 1}); seal first`);
  }
  const entries = leafHashesUpTo(baseDir, rec.size);
  const leaves = entries.map((e) => leafHash(Buffer.from(e.hash, 'hex')));
  const proof = {
    leaf: entries[seq].hash,
    index: seq,
    size: rec.size,
    path: hexes(inclusionPath(seq, leaves)),
    checkpoint: rec.note
  };
  const check = verifyInclusionProof(proof, publicKey);
  if (!check.ok) throw new Error(`lotor: chain does not match its own checkpoint: ${check.reason}`);
  return proof;
}

/**
 * Consistency proof that the checkpoint at options.to (newest by default)
 * extends the one at `fromSize`. Checked before it is returned.
 *
 * @returns {{ from: string, to: string, path: string[] }}
 */
function proveConsistency(baseDir, publicKey, fromSize, options = {}) {
  const records = readCheckpointRecords(baseDir);
  const a = recordForSize(records, fromSize);
  const b = recordForSize(records, options.to);
  if (a.size > b.size) throw new Error(`lotor: checkpoint ${a.size} is newer than ${b.size}`);
  const entries = leafHashesUpTo(baseDir, b.size);
  const leaves = entries.map((e) => leafHash(Buffer.from(e.hash, 'hex')));
  const proof = { from: a.note, to: b.note, path: hexes(consistencyProof(a.size, leaves)) };
  const check = verifyConsistencyProof(proof, publicKey);
  if (!check.ok) throw new Error(`lotor: checkpoints are not consistent: ${check.reason}`);
  return proof;
}

export {
  SEGMENT_SIZE,
  SIDECAR_NAME,
  readCheckpointRecords,
  readEntriesFrom,
  sealCheckpoints,
  verifyIncremental,
  verifySealed,
  proveInclusion,
  proveConsistency
};
