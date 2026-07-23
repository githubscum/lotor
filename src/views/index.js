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
 * Count policy-warn receipts in the chain, grouped by ruleId.
 * @param {Array} entries - Chain entries
 * @returns {Object} { total: number, byRule: Map<string, number> }
 */
function countPolicyWarnings(entries) {
  let total = 0;
  const byRule = new Map();
  for (const entry of entries) {
    const payload = entry.payload;
    if (payload?.type !== 'policy-warn') continue;
    total++;
    const ruleId = payload.ruleId || 'unknown';
    byRule.set(ruleId, (byRule.get(ruleId) || 0) + 1);
  }
  return { total, byRule };
}

/**
 * Count egress-event receipts in the chain, grouped by ruleId.
 * @param {Array} entries - Chain entries
 * @returns {Object} { total: number, byRule: Map<string, number> }
 */
function countEgressEvents(entries) {
  let total = 0;
  const byRule = new Map();
  for (const entry of entries) {
    const payload = entry.payload;
    if (payload?.type !== 'egress-event') continue;
    total++;
    const ruleId = payload.ruleId || 'unknown';
    byRule.set(ruleId, (byRule.get(ruleId) || 0) + 1);
  }
  return { total, byRule };
}

/**
 * Find sessions that were opened and never closed.
 *
 * A `session-open` receipt is written by the SessionStart hook; a session
 * receipt (payload carrying `session`) is written by SessionEnd. A session id
 * with the former and not the latter did not end cleanly: force-kill, crash,
 * OOM, power loss. That gap is the evidence KNOWN-LIMITS 14 was written about,
 * and it only means anything if something reads it, which is this.
 *
 * @param {Array} entries - Chain entries
 * @returns {Object} { opened, closed, unclosed: Array<{sessionId, source, timestamp}> }
 */
function findUnclosedSessions(entries) {
  const opens = new Map();
  const closed = new Set();

  for (const entry of entries) {
    const payload = entry.payload;
    if (payload?.type === 'session-open') {
      const id = payload.sessionId || null;
      // Keep the earliest open for an id; later ones are resume/clear/compact.
      if (!opens.has(id)) {
        opens.set(id, {
          sessionId: id,
          source: payload.source,
          cwd: payload.cwd,
          timestamp: payload.timestamp,
          seq: entry.seq
        });
      }
    } else if (payload?.session?.id) {
      closed.add(payload.session.id);
    }
  }

  const unclosed = [];
  for (const [id, info] of opens) {
    if (!closed.has(id)) unclosed.push(info);
  }

  return { opened: opens.size, closed: closed.size, unclosed };
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
  if (session?.subsession !== undefined) {
    lines.push(`Subsession:  ${session.subsession}`);
  }
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
 * @param {string} baseDir - Base directory for the chain public key (default: '.')
 * @returns {string} Rendered summary
 */
function renderMorningAfter(entries, baseDir = '.') {
  const lines = [];

  lines.push('═'.repeat(60));
  lines.push('MORNING-AFTER SUMMARY');
  lines.push('═'.repeat(60));
  lines.push(`Total chain entries:   ${entries.length}`);
  lines.push('');

  // Session count: total receipts carrying a session payload, and the number
  // of distinct session ids among them. With subsessions one session can
  // produce several receipts, so a single number is misleading.
  const sessionEntries = entries.filter(e => e.payload?.session);
  const distinctSessionIds = new Set(
    sessionEntries.map(e => e.payload?.session?.id)
  );
  lines.push(`Session receipts:      ${sessionEntries.length}`);
  lines.push(`Distinct sessions:     ${distinctSessionIds.size}`);
  lines.push('');

  // Sessions opened at SessionStart and never closed at SessionEnd. Loud on
  // purpose: this is the one number that says "the log is not the whole story".
  const openness = findUnclosedSessions(entries);
  lines.push('─'.repeat(60));
  lines.push('SESSION OPENS');
  lines.push('─'.repeat(60));
  lines.push(`  Opened:              ${openness.opened}`);
  lines.push(`  Closed cleanly:      ${openness.closed}`);
  if (openness.unclosed.length > 0) {
    lines.push(`  *** UNCLOSED:        ${openness.unclosed.length} ***`);
    for (const s of openness.unclosed.slice(-5)) {
      const ts = s.timestamp ? new Date(s.timestamp).toISOString() : 'unknown time';
      lines.push(`    ! ${s.sessionId || 'unknown id'} opened ${ts} (${s.source || 'unknown source'})`);
    }
    lines.push('    A session opened and never closed did not end cleanly.');
    lines.push('    Its activity after the last captured tool call is unknown.');
  } else {
    lines.push('  Unclosed:            0');
  }
  if (openness.opened === 0) {
    lines.push('  Note: no session-open receipts. If the SessionStart hook is not');
    lines.push('        registered, absence of a receipt means UNKNOWN, not nothing.');
  }
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

  // Policy warnings
  const policyWarns = countPolicyWarnings(entries);
  lines.push('─'.repeat(60));
  lines.push('POLICY WARNINGS');
  lines.push('─'.repeat(60));
  lines.push(`  Total:               ${policyWarns.total}`);
  if (policyWarns.total > 0) {
    const ruleIds = Array.from(policyWarns.byRule.keys()).sort();
    for (const ruleId of ruleIds) {
      const n = policyWarns.byRule.get(ruleId);
      if (n > 0) {
        lines.push(`    ${ruleId.padEnd(20)} ${n}`);
      }
    }
  }
  lines.push('');

  // Egress events captured by the PostToolUse hook. These are live
  // attestations, not transcript reconstructions, but they are still
  // NOT wire-level (see KNOWN-LIMITS item 2).
  const egressEvents = countEgressEvents(entries);
  lines.push('─'.repeat(60));
  lines.push('EGRESS EVENTS');
  lines.push('─'.repeat(60));
  lines.push(`  Total:               ${egressEvents.total}`);
  if (egressEvents.total > 0) {
    const ruleIds = Array.from(egressEvents.byRule.keys()).sort();
    for (const ruleId of ruleIds) {
      const n = egressEvents.byRule.get(ruleId);
      if (n > 0) {
        lines.push(`    ${ruleId.padEnd(20)} ${n}`);
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
    const keysDir = path.join(baseDir, 'keys');
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
  findUnclosedSessions,
  countGatedActions,
  countPolicyWarnings,
  countEgressEvents,
  renderSessionReceipt,
  renderMorningAfter
};
