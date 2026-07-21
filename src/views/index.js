/**
 * src/views/index.js
 *
 * Session-receipt + morning-after render utilities.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadChain } from '../store/index.js';
import { verifyChain } from '../chain/index.js';
import crypto from 'node:crypto';

/**
 * Load the chain entries from disk.
 * @param {string} baseDir - Base directory
 * @returns {Array} Chain entries
 */
function loadReceiptChain(baseDir = '.') {
  return loadChain(baseDir);
}

/**
 * Find the latest session receipt in the chain.
 * @param {Array} entries - Chain entries
 * @returns {Object|null} The latest session receipt payload or null
 */
function findLatestSessionReceipt(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const payload = entries[i].payload;
    if (payload?.session) {
      return { entry: entries[i], payload };
    }
  }
  return null;
}

/**
 * Count gated action receipts in the chain.
 * @param {Array} entries - Chain entries
 * @returns {Object} Counts by decision type
 */
function countGatedActions(entries) {
  let approved = 0;
  let denied = 0;
  const actions = [];

  for (const entry of entries) {
    const payload = entry.payload;
    if (payload?.type === 'gated-action') {
      actions.push({
        seq: entry.seq,
        decision: payload.decision,
        action: payload.action,
        reason: payload.reason,
        timestamp: payload.timestamp
      });
      if (payload.decision === 'approved') {
        approved++;
      } else if (payload.decision === 'denied') {
        denied++;
      }
    }
  }

  return { approved, denied, total: approved + denied, actions };
}

/**
 * Render a session receipt in human-readable form.
 * @param {Object} receiptPayload - The session receipt payload
 * @returns {string} Rendered view
 */
function renderSessionReceipt(receiptPayload) {
  if (!receiptPayload) {
    return 'No session receipt found.';
  }

  const { session, ran, touched, failed, cost, sent, counts } = receiptPayload;
  const lines = [];

  lines.push('═'.repeat(60));
  lines.push('SESSION RECEIPT');
  lines.push('═'.repeat(60));
  lines.push(`Session ID: ${session?.id || 'unknown'}`);
  lines.push(`Model:      ${session?.model || 'unknown'}`);
  lines.push(`Version:    ${session?.version || 'unknown'}`);
  lines.push(`Started:    ${session?.startedAt || 'unknown'}`);
  lines.push(`Ended:      ${session?.endedAt || 'unknown'}`);
  lines.push('');

  lines.push('─'.repeat(60));
  lines.push('TOOLS RAN');
  lines.push('─'.repeat(60));
  if (ran?.length > 0) {
    for (const tool of ran) {
      lines.push(`  • ${tool.tool} (id: ${tool.id})`);
    }
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  lines.push('─'.repeat(60));
  lines.push('FILES TOUCHED');
  lines.push('─'.repeat(60));
  if (touched?.length > 0) {
    for (const file of touched) {
      lines.push(`  • ${file.path} (via: ${file.via})`);
    }
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  lines.push('─'.repeat(60));
  lines.push('OUTBOUND ACTIVITY');
  lines.push('─'.repeat(60));
  if (sent?.items?.length > 0) {
    for (const item of sent.items) {
      lines.push(`  • ${item.tool}: ${item.target}`);
    }
  } else {
    lines.push('  (none captured)');
  }
  lines.push(`  Note: ${sent?.captureNote || 'self-attested; outbound capture limited'}`);
  lines.push('');

  lines.push('─'.repeat(60));
  lines.push('COST');
  lines.push('─'.repeat(60));
  lines.push(`  Input tokens:        ${cost?.inputTokens || 0}`);
  lines.push(`  Output tokens:       ${cost?.outputTokens || 0}`);
  lines.push(`  Cache creation:      ${cost?.cacheCreationTokens || 0}`);
  lines.push(`  Cache read:          ${cost?.cacheReadTokens || 0}`);
  lines.push(`  Note: ${cost?.note || 'tokens only; no USD in source'}`);
  lines.push('');

  // Failures are shown loudly
  lines.push('─'.repeat(60));
  lines.push('FAILURES');
  lines.push('─'.repeat(60));
  if (failed?.length > 0) {
    lines.push('*** ATTENTION: TOOL FAILURES DETECTED ***');
    for (const fail of failed) {
      lines.push(`  ✗ ${fail.tool} (id: ${fail.id})`);
      lines.push(`    Error digest: ${fail.errorDigest}`);
    }
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  lines.push('─'.repeat(60));
  lines.push('COUNTS');
  lines.push('─'.repeat(60));
  lines.push(`  Assistant turns:     ${counts?.turns || 0}`);
  lines.push(`  Tool calls:          ${counts?.toolCalls || 0}`);
  lines.push(`  Failures:            ${counts?.failures || 0}`);
  lines.push('');
  lines.push('═'.repeat(60));

  return lines.join('\n');
}

/**
 * Render a morning-after summary of all receipts.
 * @param {Array} entries - Chain entries
 * @returns {string} Rendered summary
 */
function renderMorningAfter(entries) {
  const lines = [];

  lines.push('═'.repeat(60));
  lines.push('MORNING-AFTER SUMMARY');
  lines.push('═'.repeat(60));
  lines.push(`Total chain entries:   ${entries.length}`);
  lines.push('');

  // Session count
  const sessionCount = entries.filter(e => e.payload?.session).length;
  lines.push(`Session receipts:      ${sessionCount}`);
  lines.push('');

  // Gated action summary
  const gated = countGatedActions(entries);
  lines.push('─'.repeat(60));
  lines.push('GATED ACTION DECISIONS');
  lines.push('─'.repeat(60));
  lines.push(`  Approved:            ${gated.approved}`);
  lines.push(`  Denied:              ${gated.denied}`);
  lines.push(`  Total:               ${gated.total}`);
  lines.push('');

  if (gated.actions.length > 0) {
    lines.push('  Recent decisions:');
    // Show last 5 actions
    const recent = gated.actions.slice(-5);
    for (const action of recent) {
      const ts = new Date(action.timestamp).toISOString();
      const status = action.decision === 'approved' ? '✓' : '✗';
      lines.push(`    [${status}] ${action.action} (${action.decision}) at ${ts}`);
      if (action.reason) {
        lines.push(`        reason: ${action.reason}`);
      }
    }
  }
  lines.push('');

  // Chain integrity
  lines.push('─'.repeat(60));
  lines.push('CHAIN INTEGRITY');
  lines.push('─'.repeat(60));

  // Get public key for verification
  let verifyResult = { ok: false, reason: 'no public key available' };
  try {
    const keysDir = path.join('.', 'keys');
    const pubKeyFile = path.join(keysDir, 'chain.pub');
    if (fs.existsSync(pubKeyFile)) {
      const publicKeyPem = fs.readFileSync(pubKeyFile, 'utf-8');
      const publicKey = crypto.createPublicKey(publicKeyPem);
      verifyResult = verifyChain(entries, publicKey);
    }
  } catch (e) {
    verifyResult = { ok: false, reason: e.message };
  }

  if (verifyResult.ok) {
    lines.push('  Status: ✓ Chain intact');
    lines.push(`  All ${entries.length} entries verified`);
  } else {
    lines.push('  Status: ✗ Chain BROKEN');
    lines.push(`  Reason: ${verifyResult.reason}`);
    if (verifyResult.brokenAt !== undefined) {
      lines.push(`  Broken at entry: ${verifyResult.brokenAt}`);
    }
  }
  lines.push('');
  lines.push('═'.repeat(60));

  return lines.join('\n');
}

export {
  loadReceiptChain,
  findLatestSessionReceipt,
  countGatedActions,
  renderSessionReceipt,
  renderMorningAfter
};
