#!/usr/bin/env node
/**
 * bin/tokens.js
 *
 * The authorization ledger: what is still permitted, right now.
 *
 * WHY THIS EXISTS
 *   `npm run receipts` answers what happened. Nothing answered what is still
 *   PERMITTED. Those are different questions and the second one is the one with
 *   a live blast radius.
 *
 *   Approval token files are deleted when consumed, so every file remaining in
 *   <LOTOR_HOME>/pending-approvals/ is by construction unspent. On 2026-07-25
 *   eleven had silently accumulated, two of them authorizing consequential
 *   actions (registering a Windows scheduled task, opening a GitHub PR with a
 *   full body). Each would have fired the moment its exact command string was
 *   next attempted. The pile was cleared, and one was back within forty
 *   minutes.
 *
 *   WHY IT ACCUMULATES, which is the part worth understanding: a signature
 *   burned by a one-character retry does not evaporate. The token stays on
 *   disk, valid, waiting for its exact command to be attempted again. Limits 16
 *   and 27 compound into a bank of live authorizations nobody is tracking.
 *
 * WHAT CHANGED TONIGHT, AND IT MATTERS HERE
 *   The freshness window shipped this session (limit 16) means a token older
 *   than 60 minutes no longer verifies. So most of what accumulates is now
 *   inert rather than live. This tool reports both, separately, because
 *   "unspent" and "still dangerous" stopped being the same thing and treating
 *   them as one would overstate the risk exactly the way the retcon's first
 *   version did.
 *
 * WHY --clear NEEDS NO SIGNATURE
 *   Deleting a token only ever reduces capability. Same reasoning as
 *   KNOWN-LIMITS 19 for grants: removing an authorization cannot escalate
 *   anything, so requiring approval to do it would be friction with no security
 *   value. It fails safe in the direction it fails.
 *
 * USAGE
 *   node bin/tokens.js
 *   node bin/tokens.js --clear          # delete every spent or expired token
 *   node bin/tokens.js --clear --all    # delete every token, live ones too
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveHome } from '../src/home.js';

// Must match APPROVAL_MAX_AGE_MS in src/gate/index.js. Duplicated rather than
// imported because importing the gate to read a constant would make this
// read-only tool depend on the non-delegable core; if the two drift, this tool
// reports slightly wrong ages and the gate remains correct, which is the safe
// direction for a duplicate to fail in.
const MAX_AGE_MS = 60 * 60 * 1000;

function zoneAbbr(d) {
  const jan = new Date(d.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(d.getFullYear(), 6, 1).getTimezoneOffset();
  return d.getTimezoneOffset() < Math.max(jan, jul) ? 'CDT' : 'CST';
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = m / 60;
  return h < 48 ? `${h.toFixed(1)}h ago` : `${(h / 24).toFixed(1)}d ago`;
}

function truncate(s, n) {
  if (!s) return '(no command recorded)';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1) + '…';
}

const home = resolveHome();
const dir = path.join(home, 'pending-approvals');
const nonceLog = path.join(home, 'keys', 'approval-nonces.log');

if (!fs.existsSync(dir)) {
  process.stdout.write(`no pending-approvals directory at ${dir}\n`);
  process.exit(0);
}

// A nonce present here has been spent. Absence is what makes a token live, so a
// missing or unreadable log must NOT be read as "nothing spent" — it is read as
// unknown, and the output says so rather than quietly reporting every token as
// live.
let spent = new Set();
let nonceLogReadable = false;
try {
  const raw = fs.readFileSync(nonceLog, 'utf8');
  spent = new Set(raw.split('\n').map(l => l.trim()).filter(Boolean));
  nonceLogReadable = true;
} catch (e) {
  nonceLogReadable = false;
}

const now = Date.now();
const tokens = fs.readdirSync(dir)
  .filter(f => f.endsWith('.json'))
  .map(f => {
    const full = path.join(dir, f);
    let t = null;
    try { t = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { /* malformed */ }
    let req = null;
    try { req = t?.request ? JSON.parse(t.request) : null; } catch (e) { /* not JSON */ }
    const age = t?.timestamp ? now - Number(t.timestamp) : null;
    return {
      file: f,
      full,
      malformed: !t,
      nonce: t?.nonce || null,
      timestamp: t?.timestamp || null,
      age,
      expired: age !== null ? age > MAX_AGE_MS : false,
      isSpent: t?.nonce ? spent.has(t.nonce) : false,
      action: req?.action || '?',
      detail: req?.params?.command || req?.params?.file_path || req?.params?.url || req?.params?.path || null
    };
  })
  .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

const live = tokens.filter(t => !t.isSpent && !t.expired && !t.malformed);
const expired = tokens.filter(t => !t.isSpent && t.expired && !t.malformed);
const spentFiles = tokens.filter(t => t.isSpent);
const malformed = tokens.filter(t => t.malformed);

const args = process.argv.slice(2);

if (args.includes('--clear')) {
  const all = args.includes('--all');
  const doomed = all ? tokens : [...spentFiles, ...expired, ...malformed];
  let n = 0;
  for (const t of doomed) {
    try { fs.unlinkSync(t.full); n += 1; } catch (e) { /* best effort */ }
  }
  process.stdout.write(`deleted ${n} token file(s)${all ? ' (including live ones)' : ''}\n`);
  if (!all && live.length > 0) {
    process.stdout.write(`kept ${live.length} live token(s); use --clear --all to remove those too\n`);
  }
  process.exit(0);
}

const w = s => process.stdout.write(s + '\n');
const d = new Date(now);

w('');
// LOCAL time, not UTC. The first run printed `toISOString()` — which is UTC —
// and labelled it CDT, so it read five hours off. A timestamp that is wrong
// while wearing the right label is worse than an unlabelled one, because
// nothing about it invites a second look.
const p2 = n => String(n).padStart(2, '0');
const localStamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
                   `${p2(d.getHours())}:${p2(d.getMinutes())}`;
w(`AUTHORIZATION LEDGER   ${localStamp} ${zoneAbbr(d)}`);
w(`${home}`);
w('='.repeat(66));
w('');

if (!nonceLogReadable) {
  w('  WARNING: the nonce log could not be read, so spent tokens cannot be');
  w('  distinguished from live ones. Everything below is reported as if');
  w('  unspent, which OVERSTATES what is permitted. Read it as an upper bound.');
  w('');
}

w(`  live       ${String(live.length).padStart(3)}   unspent and within the freshness window`);
w(`  expired    ${String(expired.length).padStart(3)}   unspent but past 60 min, so no longer verify`);
w(`  spent      ${String(spentFiles.length).padStart(3)}   nonce already recorded`);
if (malformed.length) w(`  malformed  ${String(malformed.length).padStart(3)}`);
w('');

if (live.length === 0) {
  w('  Nothing is currently authorized. Clean.');
  w('');
} else {
  w('  LIVE — these will fire the moment their exact command is attempted again');
  w('');
  for (const t of live) {
    w(`    ${t.file.replace('.json', '')}  ${t.action}   ${t.age !== null ? ago(t.age) : 'no timestamp'}`);
    w(`      ${truncate(t.detail, 60)}`);
  }
  w('');
}

if (expired.length > 0) {
  w(`  EXPIRED — inert since the freshness window shipped (limit 16). Safe to clear.`);
  w('');
  for (const t of expired.slice(0, 6)) {
    w(`    ${t.file.replace('.json', '')}  ${t.action}   ${ago(t.age)}   ${truncate(t.detail, 44)}`);
  }
  if (expired.length > 6) w(`    ...and ${expired.length - 6} more`);
  w('');
}

if (live.length + expired.length > 0) {
  w('  node bin/tokens.js --clear        removes spent and expired');
  w('  node bin/tokens.js --clear --all  removes live ones too');
  w('');
}

w('  A token here is unspent by construction: consuming one deletes its file.');
w('  They accumulate because a signature burned by a one-character retry does');
w('  not evaporate, it banks. What this does NOT tell you is whether anything');
w('  ever used one -- that is the receipt chain, not this.');
w('');
