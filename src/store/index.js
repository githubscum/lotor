import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createChain, verifyChain, generateKeyPair } from '../chain/index.js';

/**
 * src/store/index.js
 *
 * Persistence layer for the receipt chain.
 *
 * v1 simplification: The chain-signing key is stored locally unencrypted.
 * This key signs the CHAIN (integrity of the log). It is NOT the approval/gate
 * key — that one is Isaac's passphrase-derived key and arrives in WO-B4.
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
     * @param {Object} payload - The receipt payload (e.g., ReceiptSummary)
     * @returns {Object} The created chain entry
     */
    appendReceipt(payload) {
      const entry = chain.append(payload);
      appendEntry(entry, baseDir);
      return entry;
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
