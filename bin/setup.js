#!/usr/bin/env node
/**
 * bin/setup.js
 *
 * Guided first-run for Lotor.
 * Ensures the chain (log-integrity) key exists, then walks the owner through
 * setting the approval passphrase (the human-signature gate).
 *
 * Must be run from a real terminal for the passphrase step: init() enforces a
 * TTY so a model process cannot pipe a passphrase in. The already-set-up path
 * does NOT prompt and works without a TTY.
 *
 * Usage:
 *   node bin/setup.js        (or: npm run setup)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveHome } from '../src/home.js';
import { createStore } from '../src/store/index.js';
import { init, getPaths, loadApprovalPubkey } from '../src/gate/sign.js';

const LINE = '═'.repeat(60);
const THIN = '─'.repeat(60);

/**
 * Compute a short fingerprint for the chain public key (PEM), or 'present'.
 */
function chainKeyFingerprint(home) {
  const pubFile = path.join(home, 'keys', 'chain.pub');
  if (!fs.existsSync(pubFile)) {
    return 'absent';
  }
  try {
    const pem = fs.readFileSync(pubFile, 'utf8');
    return crypto.createHash('sha256').update(pem).digest('hex').slice(0, 16);
  } catch (e) {
    return 'present';
  }
}

/**
 * Build the status panel string.
 */
function renderPanel(home, title) {
  const receiptsFile = path.join(home, 'receipts', 'chain.jsonl');

  // Load the chain to count entries and check integrity.
  const store = createStore(home);
  store.reload();
  const receiptCount = store.entries.length;
  const verifyResult = store.verify();
  const integrity = verifyResult.ok ? 'intact' : 'broken';

  const chainFp = chainKeyFingerprint(home);

  let approvalFp = 'not set';
  try {
    approvalFp = loadApprovalPubkey(home).fp;
  } catch (e) {
    approvalFp = 'not set';
  }

  const lines = [];
  lines.push(LINE);
  lines.push(title);
  lines.push(LINE);
  lines.push(`Lotor home:        ${home}`);
  lines.push(`Receipts file:     ${receiptsFile}`);
  lines.push(`Chain key:         ${chainFp}`);
  lines.push(`Approval key:      ${approvalFp}`);
  lines.push(`Receipts in chain: ${receiptCount}`);
  lines.push(`Chain integrity:   ${integrity}`);
  lines.push(`Gate status:       ACTIVE`);
  lines.push(THIN);
  lines.push('You can check status anytime:');
  lines.push('  - the lotor_status MCP tool inside Claude');
  lines.push('  - npm run receipts in a terminal');
  lines.push(LINE);
  return lines.join('\n');
}

async function main() {
  const home = resolveHome();

  // Detect whether the chain key already existed before we touch the store.
  const chainPubFile = path.join(home, 'keys', 'chain.pub');
  const chainExistedBefore = fs.existsSync(chainPubFile);

  // Ensure the store + chain key + receipts dir exist.
  createStore(home);

  if (chainExistedBefore) {
    console.log('Chain key: already present.');
  } else {
    console.log('Chain key: created (log-integrity key, no passphrase).');
  }

  const { APPROVAL_PUB_KEY } = getPaths(home);
  const approvalExists = fs.existsSync(APPROVAL_PUB_KEY);

  if (approvalExists) {
    console.log('');
    console.log(renderPanel(home, 'LOTOR IS ALREADY SET UP'));
    process.exit(0);
  }

  // No approval key yet. Explain, then run the passphrase flow.
  console.log('');
  console.log('Next: set your approval passphrase.');
  console.log('This is your approval key. It signs any data that leaves the system.');
  console.log('The private key is never written to disk. It is derived from your');
  console.log('passphrase each time you approve, so only you can sign.');
  console.log('');

  await init(home);

  console.log('');
  console.log(renderPanel(home, 'LOTOR IS LIVE'));
}

main().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
