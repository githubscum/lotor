import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createChain, verifyChain, generateKeyPair, GENESIS_PREV_HASH } from '../chain/index.js';
import { withLock } from './lock.js';

/**
 * src/store/index.js
 *
 * Persistence layer for the receipt chain.
 *
 * v1 simplification: The chain-signing key is stored locally unencrypted.
 * This key signs the CHAIN (integrity of the log). It is NOT the approval/gate
 * key. That one is the owner's passphrase-derived key.
 * The distinction: chain key = log integrity; approval key = authorization gate.
 *
 * Append cost (2026-10-22, tail-only append). An append needs only the
 * previous entry's hash and the next seq. Until this date every append got
 * them by reading and parsing the WHOLE chain twice: once in createStore()
 * (to build store.entries) and once under the lock. Cost grew with chain
 * length (eval E5: ~6 ms at 0 entries, ~93 ms median at 30k). Now an append
 * on a well-formed chain reads only the end of the file under the lock
 * (readChainTail), and store.entries is loaded on first access. Anything that
 * is not a well-formed tail falls back to the full-read path, unchanged.
 *
 * The bytes written are the same as before EXCEPT in one class of file: one
 * where the number of parseable lines is not tail.seq + 1, because an entry
 * line before the last was lost or added (overwritten with garbage, deleted,
 * or duplicated, by hand or by disk damage). There the old path took
 * seq = parseable count, which reuses or skips a seq already on disk, and the
 * fast path takes tail.seq + 1. prevHash is the same on both paths. Such a
 * chain already fails verifyChain at the gap (prevHash link), before and after
 * the append. A chain written only by this store never falls in that class,
 * including after a torn-tail glue. See test/store-tail-append.test.js,
 * "the one documented divergence".
 */

const DEFAULT_BASE_DIR = '.';

/** Bytes read per step when scanning backwards from EOF for the last line. */
const TAIL_CHUNK_BYTES = 64 * 1024;

/** A chain entry hash: SHA-256, lowercase hex. */
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Ensure directory exists.
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Load or create the chain signing keypair.
 * On first use, generates Ed25519 keypair and writes to keys/chain.pub and keys/chain.key.
 * @param {string} baseDir - Base directory for keys (default: '.')
 * @returns {Object} { publicKey: KeyObject, privateKey: KeyObject }
 */
function loadOrCreateKeyPair(baseDir = DEFAULT_BASE_DIR) {
  const keysDir = path.join(baseDir, 'keys');
  const pubKeyFile = path.join(keysDir, 'chain.pub');
  const privKeyFile = path.join(keysDir, 'chain.key');

  ensureDir(keysDir);

  // Fast path: keys already on disk. Skip the lock; this is the common case
  // and must stay cheap.
  if (fs.existsSync(pubKeyFile) && fs.existsSync(privKeyFile)) {
    const publicKeyPem = fs.readFileSync(pubKeyFile, 'utf-8');
    const privateKeyPem = fs.readFileSync(privKeyFile, 'utf-8');
    return {
      publicKey: publicKeyPem,
      privateKey: privateKeyPem
    };
  }

  // Slow path: keys missing. Take the chain lock so two processes starting
  // against a fresh home cannot each generate a different keypair (the last
  // writer would win and orphan every receipt signed by the earlier process).
  return withLock(baseDir, () => {
    // Double-checked re-read: another process may have created the keys
    // while we were waiting on the lock. If so, use those.
    if (fs.existsSync(pubKeyFile) && fs.existsSync(privKeyFile)) {
      const publicKeyPem = fs.readFileSync(pubKeyFile, 'utf-8');
      const privateKeyPem = fs.readFileSync(privKeyFile, 'utf-8');
      return {
        publicKey: publicKeyPem,
        privateKey: privateKeyPem
      };
    }

    // Generate new keypair
    const keyPair = generateKeyPair();

    // Write keys (PEM format)
    fs.writeFileSync(pubKeyFile, keyPair.publicKey, { mode: 0o644 });
    fs.writeFileSync(privKeyFile, keyPair.privateKey, { mode: 0o600 });

    return keyPair;
  });
}

/**
 * Load the full chain from disk as an array of entries.
 * @param {string} baseDir - Base directory for receipts (default: '.')
 * @returns {Array} Array of chain entries (empty if no chain exists yet)
 */
function loadChain(baseDir = DEFAULT_BASE_DIR) {
  const receiptsDir = path.join(baseDir, 'receipts');
  const chainFile = path.join(receiptsDir, 'chain.jsonl');

  ensureDir(receiptsDir);

  if (!fs.existsSync(chainFile)) {
    return [];
  }

  const content = fs.readFileSync(chainFile, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());

  return lines.map(line => {
    try {
      return JSON.parse(line);
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

/** Space, tab, LF, CR: the bytes a blank line may consist of. */
function isBlankByte(b) {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
}

/** Read exactly buf.length bytes at position `pos`. */
function readFullyAt(fd, buf, pos) {
  let off = 0;
  while (off < buf.length) {
    const n = fs.readSync(fd, buf, off, buf.length - off, pos + off);
    if (n === 0) {
      throw new Error('lotor: chain file shrank while its tail was being read');
    }
    off += n;
  }
}

/**
 * Read the last entry of the chain WITHOUT reading the whole file.
 *
 * Scans backwards from EOF in TAIL_CHUNK_BYTES windows (doubling) until the
 * window holds the whole last non-blank line, then parses only that line.
 * Splitting on the 0x0A byte is safe for UTF-8: it never occurs inside a
 * multi-byte sequence.
 *
 * Only a well-formed tail is reported as 'ok'. Everything else is an
 * 'anomaly', and the caller must fall back to the full read (loadChain), which
 * is what the store did for every append before this function existed:
 *
 *   - the file does not end in "\n" (a torn line from a crash mid-write, or a
 *     complete last line whose newline is missing): the next append would be
 *     glued onto that line, and only the old path reproduces that exactly;
 *   - the last non-blank line does not parse as JSON;
 *   - it parses, but is not an entry (no non-negative integer seq, or no
 *     64-hex hash).
 *
 * Read-only. Must be called under the chain lock (withLock) when the result
 * feeds an append: building an entry from it and writing it outside the lock
 * is the same race as doing so with loadChain + appendEntry.
 *
 * @param {string} baseDir - Lotor home (the dir that contains receipts/)
 * @returns {{status: 'empty'} | {status: 'ok', tail: Object} | {status: 'anomaly', reason: string}}
 *   'empty' when the file is missing, zero-length, or consists only of blank
 *   bytes (space, tab, CR, LF) AND ends in "\n". A blank-only file with no
 *   trailing newline (e.g. "   ") is an 'anomaly', because the next append
 *   would be glued onto it; the fallback full read handles it exactly as
 *   before (loadChain returns [] for all of these).
 */
function readChainTail(baseDir = DEFAULT_BASE_DIR) {
  const chainFile = path.join(baseDir, 'receipts', 'chain.jsonl');

  let fd;
  try {
    fd = fs.openSync(chainFile, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { status: 'empty' };
    }
    throw err;
  }

  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) {
      return { status: 'empty' };
    }

    let windowSize = Math.min(size, TAIL_CHUNK_BYTES);
    for (;;) {
      const start = size - windowSize;
      const buf = Buffer.allocUnsafe(windowSize);
      readFullyAt(fd, buf, start);

      if (buf[windowSize - 1] !== 0x0a) {
        return { status: 'anomaly', reason: 'no trailing newline (torn or unterminated last line)' };
      }

      // Last non-blank byte in the window.
      let j = windowSize - 1;
      while (j >= 0 && isBlankByte(buf[j])) j--;

      if (j < 0) {
        if (start === 0) {
          return { status: 'empty' };
        }
        windowSize = Math.min(size, windowSize * 2);
        continue;
      }

      // Start of the line that holds byte j.
      const nl = buf.lastIndexOf(0x0a, j);
      if (nl < 0 && start > 0) {
        // The line may begin before this window. Widen and retry.
        windowSize = Math.min(size, windowSize * 2);
        continue;
      }
      const lineStart = nl + 1; // 0 when the line starts the file
      const lineEnd = buf.indexOf(0x0a, j); // exists: the window ends in "\n"
      const line = buf.toString('utf8', lineStart, lineEnd);

      let tail;
      try {
        tail = JSON.parse(line);
      } catch {
        return { status: 'anomaly', reason: 'last line is not valid JSON' };
      }

      if (tail === null || typeof tail !== 'object' || Array.isArray(tail) ||
          !Number.isSafeInteger(tail.seq) || tail.seq < 0 ||
          typeof tail.hash !== 'string' || !HASH_RE.test(tail.hash)) {
        return { status: 'anomaly', reason: 'last line is not a chain entry' };
      }

      return { status: 'ok', tail };
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Append a receipt (chain entry) to the append-only chain file.
 * Creates the chain file if it doesn't exist.
 * @param {Object} entry - The chain entry to append
 * @param {string} baseDir - Base directory for receipts (default: '.')
 */
function appendEntry(entry, baseDir = DEFAULT_BASE_DIR) {
  const receiptsDir = path.join(baseDir, 'receipts');
  const chainFile = path.join(receiptsDir, 'chain.jsonl');

  ensureDir(receiptsDir);

  const line = JSON.stringify(entry);
  // Create the chain with owner-only permissions. Since 2026-07-24 the chain
  // records authorised command strings in plaintext (KNOWN-LIMITS 18); the
  // grant file those are copied from is already 0600 (src/grant/issue.js), and
  // the chain holding the same plaintext must not be looser. `mode` applies
  // only when the file is created, so create it explicitly if absent, then
  // append. A chain that predates this fix keeps its old permissions until a
  // one-time `chmod 600`. See KNOWN-LIMITS 21.
  if (!fs.existsSync(chainFile)) {
    fs.writeFileSync(chainFile, '', { mode: 0o600 });
  }
  fs.appendFileSync(chainFile, line + '\n');
}

/**
 * Store interface: manages chain persistence and key management.
 * @param {string} baseDir - Base directory for data (default: '.')
 */
function createStore(baseDir = DEFAULT_BASE_DIR) {
  const keyPair = loadOrCreateKeyPair(baseDir);

  // loadChain() used to run here and created receipts/ as a side effect.
  // Keep the side effect; drop the full read.
  ensureDir(path.join(baseDir, 'receipts'));

  // The full chain, parsed. null until someone reads store.entries (or calls
  // reload/verify). An append never needs it: it reads only the tail.
  let cached = null;

  function materialize() {
    if (cached === null) {
      cached = loadChain(baseDir);
    }
    return cached;
  }

  /** Replace the cached array's contents in place (callers hold the array). */
  function replaceCached(list) {
    cached.length = 0;
    for (const e of list) {
      cached.push(e);
    }
  }

  /**
   * After a tail-path append (under the lock), bring a materialized cache in
   * line with disk. If the cache already ended at the entry we linked to, the
   * new entry is the only thing missing. Otherwise another process appended
   * since the cache was built: re-read, still under the lock, so the cache is
   * exactly the disk view, as it was before this change.
   */
  function syncCacheAfterTailAppend(entry) {
    if (cached === null) {
      return; // nobody has looked; first access reads disk, append included
    }
    const lastHash = cached.length > 0 ? cached[cached.length - 1].hash : GENESIS_PREV_HASH;
    if (cached.length === entry.seq && lastHash === entry.prevHash) {
      cached.push(entry);
      return;
    }
    const disk = loadChain(baseDir);
    if (disk.length > 0 && disk[disk.length - 1].hash === entry.hash) {
      disk[disk.length - 1] = entry; // same object the caller got back
    }
    replaceCached(disk);
  }

  /**
   * The single append path. Runs entirely under the chain lock.
   *
   * withChain=true: full read, buildPayload(current) sees every entry. This
   *   is the pre-2026-10-22 path, byte for byte.
   * withChain=false: tail-only. buildPayload() gets no arguments. If the tail
   *   is not well formed (readChainTail 'anomaly') this falls back to the
   *   full-read path above, so torn and unterminated tails are handled
   *   exactly as before.
   */
  function lockedAppend(buildPayload, withChain) {
    return withLock(baseDir, () => {
      let current = null; // full chain, only on the full-read path
      let prev = null;    // tail entry to link to; null means genesis

      if (withChain) {
        current = loadChain(baseDir);
      } else {
        const t = readChainTail(baseDir);
        if (t.status === 'ok') {
          prev = t.tail;
        } else if (t.status === 'anomaly') {
          current = loadChain(baseDir);
        }
        // 'empty': prev stays null, seq 0, genesis prevHash. loadChain
        // returns [] for the same file, so this matches the old path.
      }

      const payload = withChain ? buildPayload(current) : buildPayload();
      if (payload == null) {
        return null;
      }

      if (current !== null) {
        const fullChain = createChain(keyPair, current.length, current);
        const entry = fullChain.append(payload);
        appendEntry(entry, baseDir);
        if (cached !== null) {
          replaceCached(fullChain.entries);
        }
        return entry;
      }

      // seq: on a chain written only by this store, every entry's seq equals
      // the number of parseable entries before it, so tail.seq + 1 is exactly
      // what loadChain(...).length would give. If a line before the tail was
      // lost or added (see the module comment) the two differ, and this path
      // does NOT fall back: detecting it needs the parseable-line count, which
      // is the full read this path exists to avoid (no O(1) signal in the tail
      // carries it). tail.seq + 1 is also the safer of the two values: the
      // count reuses or skips a seq already on disk. The chain is already
      // broken at the gap either way (verifyChain fails on prevHash there).
      const seq = prev ? prev.seq + 1 : 0;
      const entry = createChain(keyPair, seq, prev ? [prev] : []).append(payload);
      appendEntry(entry, baseDir);
      syncCacheAfterTailAppend(entry);
      return entry;
    });
  }

  return {
    /**
     * The full chain as parsed from disk. Loaded on first access, then kept
     * in line with disk by this store's own appends (array identity is
     * preserved, as before).
     */
    get entries() {
      return materialize();
    },

    keyPair,

    /**
     * Append a receipt payload to the chain.
     *
     * Concurrency-safe: the chain tail is re-read from disk INSIDE the lock,
     * so two processes appending at the same time cannot compute the same seq
     * or the same prevHash. Locking only the write would not be enough.
     *
     * Reads only the tail of the chain file (see readChainTail), so the cost
     * does not grow with the chain.
     *
     * @param {Object} payload - The receipt payload (e.g., ReceiptSummary)
     * @returns {Object} The created chain entry
     */
    appendReceipt(payload) {
      return lockedAppend(() => payload, false);
    },

    /**
     * Atomic check-then-append under the chain lock.
     *
     * The subsession decision reads the chain (which subsessions already exist
     * for a session id) and then appends. Doing that outside the lock is a
     * TOCTOU race: two `SessionEnd` firings for the same session could both
     * observe "no receipt yet" and both append `subsession 0`. The whole
     * read-decide-append sequence runs under withLock so the view buildPayload
     * sees is the same view the append lands on.
     *
     * A caller that only needs the lock, not the chain (for example a step
     * receipt whose payload must be built inside the critical section), passes
     * { withChain: false }: buildPayload is then called with no arguments and
     * the append reads only the tail, so its cost does not grow with the chain.
     *
     * @param {Function} buildPayload - Called inside the lock with the current
     *   chain entries (or with nothing, when withChain is false). Return the
     *   receipt payload to append, or null/undefined to skip.
     * @param {Object} [options]
     * @param {boolean} [options.withChain=true] - false: do not read the chain.
     * @returns {Object|null} The created chain entry, or null if nothing was
     *   appended.
     */
    appendReceiptGuarded(buildPayload, options) {
      const withChain = !(options && options.withChain === false);
      return lockedAppend(buildPayload, withChain);
    },

    /**
     * Reload the chain from disk.
     * @returns {Array} Current chain entries
     */
    reload() {
      const entries = loadChain(baseDir);
      if (cached === null) {
        cached = entries;
      } else {
        replaceCached(entries);
      }
      return cached;
    },

    /**
     * Verify the entire chain integrity.
     * @returns {Object} { ok, brokenAt?, reason? }
     */
    verify() {
      // Import public key from PEM for verification
      const publicKey = crypto.createPublicKey(keyPair.publicKey);
      return verifyChain(materialize(), publicKey);
    }
  };
}

export {
  createStore,
  loadChain,
  readChainTail,
  appendEntry,
  loadOrCreateKeyPair
};
