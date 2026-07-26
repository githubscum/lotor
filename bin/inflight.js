#!/usr/bin/env node
/**
 * bin/inflight.js
 *
 * What is running right now.
 *
 * WHY THIS EXISTS
 *   Everything else in this repo looks backward. `query_receipts` lists what
 *   finished. `retcon` reconstructs a window that has already passed. A
 *   `session-open` entry says a session STARTED and says nothing about whether
 *   it is still going.
 *
 *   Isaac's framing, 2026-07-26: that gap is the difference between reading
 *   history and herding. You cannot move a pack you cannot see.
 *
 * THE DISCRIMINATOR, which was found the hard way
 *   An open with no close means two opposite things, and the retcon's first
 *   version reported them as one number: 116 sessions, presented as work missing
 *   from the record, implying a 9% capture rate. The real figure was 12. The
 *   other 109 were sessions that opened and never did anything, where
 *   `SessionEnd` correctly appended nothing under limit 5's no-change guard.
 *
 *   The transcript separates them, and it also separates alive from stalled:
 *
 *     ALIVE    transcript modified recently -> work is happening now
 *     STALLED  transcript exists, untouched for a while -> started, then stopped
 *     INERT    no transcript at all -> opened and never did anything, not a gap
 *
 *   A hung session must read as HUNG rather than as silence. That is the whole
 *   point of the middle row.
 *
 * WHAT THIS IS NOT
 *   Not proof. A transcript's mtime says bytes were written, not that useful
 *   work is happening, and a session doing a long single tool call looks stalled
 *   while being perfectly healthy. Treat STALLED as "go look", never as "it is
 *   broken".
 *
 * USAGE
 *   node bin/inflight.js
 *   node bin/inflight.js --stale-after 15    # minutes before alive becomes stalled
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveHome } from '../src/home.js';

const args = process.argv.slice(2);
function flagNum(name, dflt) {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : dflt;
}

const STALE_AFTER_MS = flagNum('--stale-after', 10) * 60 * 1000;

function zoneAbbr(d) {
  const jan = new Date(d.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(d.getFullYear(), 6, 1).getTimezoneOffset();
  return d.getTimezoneOffset() < Math.max(jan, jul) ? 'CDT' : 'CST';
}
function localStamp(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())} ${zoneAbbr(d)}`;
}
function dur(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 90) return `${m}m`;
  const h = m / 60;
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
}
function shortCwd(c) {
  if (!c) return '?';
  return c.replace(/^.*[\\/]/, '') || c;
}

const home = resolveHome();
const chainFile = path.join(home, 'receipts', 'chain.jsonl');
if (!fs.existsSync(chainFile)) {
  process.stdout.write(`no chain at ${chainFile}\n`);
  process.exit(0);
}

const entries = fs.readFileSync(chainFile, 'utf-8')
  .split('\n').map(l => l.trim()).filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean);

// Build open/closed state. Later opens for the same id overwrite earlier ones,
// which is correct: SessionStart fires again on resume and compact, and the
// most recent open is the one describing the session's current life.
const open = new Map();
const closed = new Set();

for (const e of entries) {
  const p = e.payload || {};
  if (p.type === 'session-open' && p.sessionId) {
    open.set(p.sessionId, {
      at: p.timestamp || e.timestamp,
      source: p.source || '?',
      cwd: p.cwd || null,
      transcriptPath: p.transcriptPath || null
    });
  } else if (p.session) {
    const id = p.session.sessionId || p.session.id;
    if (id) closed.add(id);
  }
}

const now = Date.now();
const rows = [];
for (const [id, o] of open) {
  if (closed.has(id)) continue;

  let bytes = 0;
  let mtime = 0;
  try {
    if (o.transcriptPath) {
      const st = fs.statSync(o.transcriptPath);
      bytes = st.size;
      mtime = st.mtimeMs;
    }
  } catch { /* absent transcript stays at zero */ }

  // 2 KB rather than 0: a transcript can exist with only a header in it, which
  // is a session that opened a file and still did nothing.
  let state;
  if (bytes <= 2048) state = 'INERT';
  else if (now - mtime <= STALE_AFTER_MS) state = 'ALIVE';
  else state = 'STALLED';

  rows.push({ id, ...o, bytes, mtime, state, openFor: now - (o.at || now) });
}

const alive = rows.filter(r => r.state === 'ALIVE').sort((a, b) => b.mtime - a.mtime);
const stalled = rows.filter(r => r.state === 'STALLED').sort((a, b) => b.mtime - a.mtime);
const inert = rows.filter(r => r.state === 'INERT');

const w = s => process.stdout.write(s + '\n');

w('');
w(`IN FLIGHT   ${localStamp(now)}`);
w('='.repeat(66));
w('');
w(`  alive     ${String(alive.length).padStart(3)}   transcript written within ${STALE_AFTER_MS / 60000}m`);
w(`  stalled   ${String(stalled.length).padStart(3)}   did work, then went quiet`);
w(`  inert     ${String(inert.length).padStart(3)}   opened and never did anything (not a gap)`);
w('');

if (alive.length > 0) {
  w('  ALIVE');
  for (const r of alive) {
    w(`    ${r.id.slice(0, 8)}  ${shortCwd(r.cwd).padEnd(18)} open ${dur(r.openFor).padStart(5)}  ` +
      `last write ${dur(now - r.mtime).padStart(4)} ago  ${(r.bytes / 1024).toFixed(0)}kb`);
  }
  w('');
}

if (stalled.length > 0) {
  w('  STALLED  — went quiet after doing work. Go look; not proof of a problem.');
  for (const r of stalled.slice(0, 12)) {
    w(`    ${r.id.slice(0, 8)}  ${shortCwd(r.cwd).padEnd(18)} open ${dur(r.openFor).padStart(5)}  ` +
      `quiet ${dur(now - r.mtime).padStart(5)}  ${(r.bytes / 1024).toFixed(0)}kb`);
  }
  if (stalled.length > 12) w(`    ...and ${stalled.length - 12} more`);
  w('');
}

if (inert.length > 0) {
  const byCwd = new Map();
  for (const r of inert) {
    const k = shortCwd(r.cwd);
    byCwd.set(k, (byCwd.get(k) || 0) + 1);
  }
  w('  INERT  — opened, wrote no transcript. SessionEnd correctly recorded');
  w('           nothing for these, so they are not missing work.');
  for (const [k, n] of [...byCwd].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    w(`    ${String(n).padStart(4)}x  ${k}`);
  }
  w('');
}

w('  A transcript mtime says bytes were written, not that useful work is');
w('  happening. A session inside one long tool call looks stalled while being');
w('  perfectly healthy. Read STALLED as "go look", never as "it is broken".');
w('');
