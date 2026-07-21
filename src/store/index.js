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

const RECEIPTS_DIR = 'receipts';
const CHAIN_FILE = path.join(RECEIPTS_DIR, 'chain.jsonl');
const KEYS_DIR = 'keys';
const PUB_KEY_FILE = path.join(KEYS_DIR, 'chain.pub');
const PRIV_KEY_FILE = path.join(KEYS_DIR, 'chain.key');

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
 * @returns {Object} { publicKey: KeyObject, privateKey: KeyObject }
 */
function loadOrCreateKeyPair() {
  ensureDir(KEYS_DIR);

  if (fs.existsSync(PUB_KEY_FILE) && fs.existsSync(PRIV_KEY_FILE)) {
    const publicKeyPem = fs.readFileSync(PUB_KEY_FILE, 'utf-8');
    const privateKeyPem = fs.readFileSync(PRIV_KEY_FILE, 'utf-8');
    return {
      publicKey: publicKeyPem,
      privateKey: privateKeyPem
    };
  }

  // Generate new keypair
  const keyPair = generateKeyPair();

  // Write keys (PEM format)
  fs.writeFileSync(PUB_KEY_FILE, keyPair.publicKey, { mode: 0o644 });
  fs.writeFileSync(PRIV_KEY_FILE, keyPair.privateKey, { mode: 0o600 });

  return keyPair;
}

/**
 * Load the full chain from disk as an array of entries.
 * @returns {Array} Array of chain entries (empty if no chain exists yet)
 */
function loadChain() {
  ensureDir(RECEIPTS_DIR);

  if (!fs.existsSync(CHAIN_FILE)) {
    return [];
  }

  const content = fs.readFileSync(CHAIN_FILE, 'utf-8');
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
 */
function appendEntry(entry) {
  ensureDir(RECEIPTS_DIR);

  const line = JSON.stringify(entry);
  fs.appendFileSync(CHAIN_FILE, line + '\n');
}

/**
 * Store interface: manages chain persistence and key management.
 */
function createStore() {
  const keyPair = loadOrCreateKeyPair();
  const existingEntries = loadChain();

  // Create chain instance with correct starting sequence number
  // If there are existing entries, start from that count so NEW entries continue the sequence
  const chain = createChain(keyPair, existingEntries.length);

  // Populate chain with existing entries if any
  if (existingEntries.length > 0) {
    // The chain entries are already signed; we just load them in
    // The seq for NEW entries is already set via the startSeq parameter
    for (const entry of existingEntries) {
      chain.entries.push(entry);
    }
  }

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
      appendEntry(entry);
      return entry;
    },

    /**
     * Reload the chain from disk.
     * @returns {Array} Current chain entries
     */
    reload() {
      const entries = loadChain();
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
