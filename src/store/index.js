import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createChain, verifyChain, generateKeyPair } from '../chain/index.js';
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
 */

const DEFAULT_BASE_DIR = '.';

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
  fs.appendFileSync(chainFile, line + '\n');
}

/**
 * Store interface: manages chain persistence and key management.
 * @param {string} baseDir - Base directory for data (default: '.')
 */
function createStore(baseDir = DEFAULT_BASE_DIR) {
  const keyPair = loadOrCreateKeyPair(baseDir);
  const existingEntries = loadChain(baseDir);

  // Create chain instance with:
  // - correct starting sequence number (for NEW entries)
  // - prior entries loaded so prevHash links correctly
  const chain = createChain(keyPair, existingEntries.length, existingEntries);

  return {
    entries: chain.entries,
    keyPair,

    /**
     * Append a receipt payload to the chain.
     *
     * Concurrency-safe: the chain tail is re-read from disk INSIDE the lock,
     * so two processes appending at the same time cannot compute the same seq
     * or the same prevHash. Locking only the write would not be enough.
     *
     * @param {Object} payload - The receipt payload (e.g., ReceiptSummary)
     * @returns {Object} The created chain entry
     */
    appendReceipt(payload) {
      return withLock(baseDir, () => {
        // Re-read the tail under the lock: another process may have appended
        // since this store was constructed (or since the last append).
        const current = loadChain(baseDir);
        const freshChain = createChain(keyPair, current.length, current);

        const entry = freshChain.append(payload);
        appendEntry(entry, baseDir);

        // Keep the in-memory view consistent with disk, preserving the array
        // identity the way reload() does.
        this.entries.length = 0;
        for (const e of freshChain.entries) {
          this.entries.push(e);
        }

        return entry;
      });
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
     * @param {Function} buildPayload - Called inside the lock with the current
     *   chain entries. Return the receipt payload to append, or null/undefined
     *   to skip.
     * @returns {Object|null} The created chain entry, or null if nothing was
     *   appended.
     */
    appendReceiptGuarded(buildPayload) {
      return withLock(baseDir, () => {
        const current = loadChain(baseDir);

        const payload = buildPayload(current);
        if (payload == null) {
          return null;
        }

        const freshChain = createChain(keyPair, current.length, current);
        const entry = freshChain.append(payload);
        appendEntry(entry, baseDir);

        this.entries.length = 0;
        for (const e of freshChain.entries) {
          this.entries.push(e);
        }

        return entry;
      });
    },

    /**
     * Reload the chain from disk.
     * @returns {Array} Current chain entries
     */
    reload() {
      const entries = loadChain(baseDir);
      this.entries.length = 0;
      for (const entry of entries) {
        this.entries.push(entry);
      }
      return this.entries;
    },

    /**
     * Verify the entire chain integrity.
     * @returns {Object} { ok, brokenAt?, reason? }
     */
    verify() {
      // Import public key from PEM for verification
      const publicKey = crypto.createPublicKey(keyPair.publicKey);
      return verifyChain(this.entries, publicKey);
    }
  };
}

export {
  createStore,
  loadChain,
  appendEntry,
  loadOrCreateKeyPair
};
