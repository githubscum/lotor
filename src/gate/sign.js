/**
 * src/gate/sign.js
 *
 * Owner's approval signer for gated actions.
 * Private key is NEVER written to disk; derived from passphrase at sign time.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BASE_DIR = '.';

const PBKDF2_ITER = 600_000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';
const SALT = Buffer.from('agent-receipts-approval-salt-v1-2026-07-21', 'utf8');

/**
 * Get paths based on base directory.
 * @param {string} baseDir - Base directory (default: '.')
 * @returns {Object} { KEYS_DIR, APPROVAL_PUB_KEY, NONCE_LOG }
 */
function getPaths(baseDir = DEFAULT_BASE_DIR) {
  const KEYS_DIR = path.join(baseDir, 'keys');
  const APPROVAL_PUB_KEY = path.join(KEYS_DIR, 'approval.pub');
  const NONCE_LOG = path.join(KEYS_DIR, 'approval-nonces.log');
  return { KEYS_DIR, APPROVAL_PUB_KEY, NONCE_LOG };
}

/**
 * Prompt for passphrase at TTY (raw mode, no echo).
 * Refuses to run without TTY so a model process can't pipe a passphrase in.
 */
async function promptPassphrase(confirm = false) {
  if (!process.stdin.isTTY) {
    console.error('error: not a TTY. signer must be run from a terminal, not a piped process.');
    process.exit(2);
  }
  process.stderr.write('passphrase: ');
  const pass1 = await readLineSilent();
  if (confirm) {
    process.stderr.write('confirm:    ');
    const pass2 = await readLineSilent();
    if (pass1 !== pass2) {
      console.error('error: passphrases do not match.');
      process.exit(2);
    }
  }
  return pass1;
}

function readLineSilent() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      if (c === '\n' || c === '\r' || c === '') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stderr.write('\n');
        resolve(input);
      } else if (c === '') {
        process.exit(1);
      } else if (c === '') {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stderr.write('\b \b');
        }
      } else {
        input += c;
        process.stderr.write('*');
      }
    });
  });
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fingerprint(pubkeyBuf) {
  return crypto.createHash('sha256').update(pubkeyBuf).digest('hex').slice(0, 32);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Initialize: generate approval keypair from passphrase.
 * Writes ONLY the public key to keys/approval.pub.
 * @param {string} baseDir - Base directory (default: '.')
 */
async function init(baseDir = DEFAULT_BASE_DIR) {
  const { KEYS_DIR, APPROVAL_PUB_KEY } = getPaths(baseDir);
  ensureDir(KEYS_DIR);

  if (fs.existsSync(APPROVAL_PUB_KEY)) {
    console.error('error: public key already exists at', APPROVAL_PUB_KEY);
    console.error('delete it manually if you really want to re-init.');
    process.exit(2);
  }

  const passphrase = await promptPassphrase(true);
  const seed = crypto.pbkdf2Sync(passphrase, SALT, PBKDF2_ITER, PBKDF2_KEYLEN, PBKDF2_DIGEST);

  // Construct Ed25519 keypair from seed
  const jwkPriv = { crv: 'Ed25519', d: base64url(seed), x: '', kty: 'OKP' };
  const privKeyObj = crypto.createPrivateKey({ key: jwkPriv, format: 'jwk' });
  const pubKeyObj = crypto.createPublicKey(privKeyObj);
  const exportedPub = pubKeyObj.export({ format: 'jwk', type: 'public' });

  const pubB64 = exportedPub.x;
  const fp = fingerprint(Buffer.from(pubB64, 'base64'));

  fs.writeFileSync(APPROVAL_PUB_KEY, `ed25519:${pubB64}:fingerprint:${fp}\n`, { mode: 0o644 });

  console.log('approval keypair generated.');
  console.log('public key written to:', APPROVAL_PUB_KEY);
  console.log('fingerprint:', fp);
  console.log('private key: NOT stored. Derived from your passphrase at signing time.');
}

/**
 * Load the stored approval public key.
 * @param {string} baseDir - Base directory (default: '.')
 */
function loadApprovalPubkey(baseDir = DEFAULT_BASE_DIR) {
  const { APPROVAL_PUB_KEY } = getPaths(baseDir);
  if (!fs.existsSync(APPROVAL_PUB_KEY)) {
    throw new Error('No approval public key found. Run init first.');
  }
  const line = fs.readFileSync(APPROVAL_PUB_KEY, 'utf8').trim();
  const m = line.match(/^ed25519:([A-Za-z0-9_-]+):fingerprint:([a-f0-9]{32})$/);
  if (!m) {
    throw new Error('Approval public key file is malformed');
  }
  return { b64: m[1], fp: m[2] };
}

/**
 * Create approval token for an action request.
 * Returns { request, nonce, timestamp, signature }.
 * @param {Object} actionRequest - The action request { action, params? }
 * @param {string} baseDir - Base directory (default: '.')
 */
async function createApprovalToken(actionRequest, baseDir = DEFAULT_BASE_DIR) {
  const pub = loadApprovalPubkey(baseDir);
  const passphrase = await promptPassphrase(false);
  const seed = crypto.pbkdf2Sync(passphrase, SALT, PBKDF2_ITER, PBKDF2_KEYLEN, PBKDF2_DIGEST);

  // Reconstruct private key and verify it matches stored public key
  const jwkPriv = { crv: 'Ed25519', d: base64url(seed), x: pub.b64, kty: 'OKP' };
  const privKeyObj = crypto.createPrivateKey({ key: jwkPriv, format: 'jwk' });
  const derivedPub = crypto.createPublicKey(privKeyObj).export({ format: 'jwk', type: 'public' });

  if (derivedPub.x !== pub.b64) {
    console.error('error: passphrase does not match the stored public key.');
    process.exit(3);
  }

  // Canonicalize the request for signing
  const canonical = canonicalizeRequest(actionRequest);
  const nonce = crypto.randomBytes(12).toString('base64url');
  const timestamp = Date.now();

  const signData = { request: canonical, nonce, timestamp };
  const signBuf = Buffer.from(JSON.stringify(signData, Object.keys(signData).sort()), 'utf8');

  const sig = crypto.sign(null, signBuf, privKeyObj);

  return {
    request: canonical,
    nonce,
    timestamp,
    signature: sig.toString('hex')
  };
}

/**
 * JSON.stringify replacer that sorts object keys alphabetically at all levels.
 * Used for deterministic canonicalization.
 */
function sortKeysReplacer(key, value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted = {};
    for (const k of Object.keys(value).sort()) {
      sorted[k] = value[k];
    }
    return sorted;
  }
  return value;
}

/**
 * Canonicalize an action request for signing.
 * Sorts keys recursively for deterministic serialization.
 * NOTE: This must include ALL nested keys (not just top-level) for security.
 */
function canonicalizeRequest(actionRequest) {
  const sorted = JSON.stringify(actionRequest, sortKeysReplacer);
  return sorted;
}

/**
 * Check if a nonce has been used before (replay protection).
 * @param {string} nonce - The nonce to check
 * @param {string} baseDir - Base directory (default: '.')
 */
function nonceUsed(nonce, baseDir = DEFAULT_BASE_DIR) {
  const { NONCE_LOG } = getPaths(baseDir);
  if (!fs.existsSync(NONCE_LOG)) return false;
  const lines = fs.readFileSync(NONCE_LOG, 'utf8').split('\n');
  return lines.some((l) => l.trim() === nonce);
}

/**
 * Record a nonce as used.
 * @param {string} nonce - The nonce to record
 * @param {string} baseDir - Base directory (default: '.')
 */
function recordNonce(nonce, baseDir = DEFAULT_BASE_DIR) {
  const { KEYS_DIR, NONCE_LOG } = getPaths(baseDir);
  ensureDir(KEYS_DIR);
  fs.appendFileSync(NONCE_LOG, nonce + '\n', { mode: 0o600 });
}

export {
  init,
  createApprovalToken,
  loadApprovalPubkey,
  canonicalizeRequest,
  sortKeysReplacer,
  nonceUsed,
  recordNonce,
  getPaths,
  SALT,
  PBKDF2_ITER,
  PBKDF2_KEYLEN,
  PBKDF2_DIGEST
};
