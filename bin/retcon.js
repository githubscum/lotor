#!/usr/bin/env node
/**
 * bin/retcon.js
 *
 * The bearing. What was declared, what actually happened, and the angle
 * between them.
 *
 * WHY "RETCON" AND NOT "DEBRIEF"
 *   Isaac's word, and it is the better one. A debrief reports what happened. A
 *   retcon RECONSTRUCTS how something was actually accomplished and reconciles
 *   that against what was declared. The reconciliation is the product; the
 *   report is a by-product.
 *
 * THE COMPASS, INSTANTIATED
 *   A compass with one input is a paperweight. It needs a fixed reference that
 *   does not move and a current heading, and the only thing it reports is the
 *   angle between them.
 *
 *     intention  = the signed charter        (forward, declared)
 *     record     = the receipt chain         (backward, unarguable)
 *     bearing    = this view                 (the deviation, and the finding)
 *
 *   Until now Lotor had only the record half. `verify_chain` proves the record
 *   is intact. `query_receipts` lists what happened. Neither asks WAS THIS WHAT
 *   WE SAID WE WOULD DO.
 *
 * IT PRESENTS. IT DOES NOT DETECT.
 *   Receipts carry which named tools ran and a digest of their parameters. They
 *   carry no intent, ever (confirmed by reading the parser, 2026-07-22). A
 *   charter's items are commands; a plan's purpose is prose. Those are not
 *   mechanically comparable, so this puts them side by side and lets a human
 *   read the angle.
 *
 *   That is the same call as the duty statement: a person is the instrument
 *   until a comparator exists. Claiming otherwise would be the kind of
 *   overreach KNOWN-LIMITS exists to prevent.
 *
 * TWO MODES
 *   Charter mode  — declared items vs what ran. The real thing.
 *   Window mode   — no charter, just reconstruct a period. Useful before
 *                   charters are in use, and it is the "what is in flight"
 *                   view.
 *
 * USAGE
 *   node bin/retcon.js --since 12h
 *   node bin/retcon.js --since 2026-07-25
 *   node bin/retcon.js --charter <id>
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveHome } from '../src/home.js';
import {
  canonicalizeItem,
  verifyCharter,
  completion,
  loadCharters
} from '../src/charter/index.js';

function die(msg) {
  process.stderr.write(`lotor retcon: ${msg}\n`);
  process.exit(1);
}

function zoneAbbr(d) {
  // Isaac runs his day on US Central and reads these over coffee. An
  // unlabelled timestamp in a morning brief is a small tax paid every day.
  const jan = new Date(d.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(d.getFullYear(), 6, 1).getTimezoneOffset();
  return d.getTimezoneOffset() < Math.max(jan, jul) ? 'CDT' : 'CST';
}

function stamp(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())} ${zoneAbbr(d)}`;
}

function parseSince(arg) {
  if (!arg) return Date.now() - 24 * 3600 * 1000;
  const rel = /^(\d+)\s*([hdm])$/i.exec(arg.trim());
  if (rel) {
    const n = Number(rel[1]);
    const mult = { h: 3600e3, d: 86400e3, m: 60e3 }[rel[2].toLowerCase()];
    return Date.now() - n * mult;
  }
  const t = Date.parse(arg);
  if (Number.isNaN(t)) die(`could not read --since ${JSON.stringify(arg)}; try 12h, 3d, or 2026-07-25`);
  return t;
}

function readChain(home) {
  const f = path.join(home, 'receipts', 'chain.jsonl');
  if (!fs.existsSync(f)) die(`no chain at ${f}`);
  return fs.readFileSync(f, 'utf-8')
    .split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function detailOf(action) {
  const p = action?.params || {};
  return p.command || p.file_path || p.url || p.path || '';
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** Fold the chain into the few facts a human actually reads. */
function reconstruct(entries, sinceMs) {
  const inWindow = entries.filter(e => (e.timestamp || 0) >= sinceMs);

  const out = {
    from: sinceMs,
    to: Date.now(),
    entries: inWindow.length,
    sessions: new Map(),      // sessionId -> { model, toolCalls, touched }
    opens: 0,                 // open EVENTS (includes compaction re-opens)
    openedIds: new Set(),     // distinct sessions
    unclosedOpens: new Set(),
    openDetail: new Map(),    // sessionId -> { at, source, cwd }
    denied: [],
    approved: [],
    grantUses: 0,
    deniedByRule: new Map(),
    actionsSeen: new Map()    // canonical action -> count
  };

  for (const e of inWindow) {
    const p = e.payload || {};

    if (p.type === 'session-open') {
      // Count DISTINCT sessions, not open events. SessionStart fires on
      // startup, resume, clear AND compact, so one long session emits many
      // opens with the same id. Counting events made a single busy session
      // look like a hundred crashed ones on the first real run of this view.
      out.opens += 1;
      if (p.sessionId) {
        out.openedIds.add(p.sessionId);
        out.unclosedOpens.add(p.sessionId);
        // Keep the detail so --unclosed can answer WHAT never closed, not just
        // how many. `source` distinguishes a fresh start from a resume or a
        // compaction, and `cwd` usually identifies which job it was.
        out.openDetail.set(p.sessionId, {
          at: p.timestamp || e.timestamp,
          source: p.source || '?',
          cwd: p.cwd || '?',
          transcriptPath: p.transcriptPath || null
        });
      }
      continue;
    }
    if (p.session) {
      const id = p.session.sessionId || p.session.id;
      if (id) {
        out.unclosedOpens.delete(id);
        out.sessions.set(id, {
          model: p.session.model || 'unknown',
          toolCalls: p.counts?.toolCalls ?? 0,
          touched: Array.isArray(p.touched) ? p.touched.length : 0
        });
      }
      continue;
    }
    if (p.type === 'gated-action') {
      const rec = {
        at: p.timestamp || e.timestamp,
        action: p.action,
        reason: p.reason || '',
        detail: detailOf(p.action)
      };
      if (p.decision === 'approved') {
        out.approved.push(rec);
      } else {
        out.denied.push(rec);
        // Denials only. The first run bucketed approvals in here too, because
        // an approved entry has no `reason` and fell through to the default,
        // producing a phantom "35x denied" line that was really the approvals
        // counted twice.
        const key = (p.reason || 'unspecified').slice(0, 48);
        out.deniedByRule.set(key, (out.deniedByRule.get(key) || 0) + 1);
      }

      try {
        const c = canonicalizeItem(p.action);
        out.actionsSeen.set(c, (out.actionsSeen.get(c) || 0) + 1);
      } catch { /* not a shape we can canonicalize; skip */ }
      continue;
    }
    if (p.type === 'grant-use') out.grantUses += 1;
  }

  return out;
}

function printWindow(r) {
  const w = s => process.stdout.write(s + '\n');

  w('');
  w(`RETCON  ${stamp(r.from)}  ->  ${stamp(r.to)}`);
  w('='.repeat(64));
  w('');
  w(`  chain entries in window   ${r.entries}`);
  w(`  distinct sessions opened  ${r.openedIds.size}   (${r.opens} open events, incl. compaction re-opens)`);
  w(`  sessions closed           ${r.sessions.size}`);
  if (r.unclosedOpens.size > 0) {
    // AN OPEN WITH NO CLOSE MEANS TWO OPPOSITE THINGS AND MUST NEVER BE ONE
    // NUMBER. Either a session did work that was never recorded, which is the
    // gap KNOWN-LIMITS 14 exists to surface, or a session opened and did
    // nothing at all, in which case SessionEnd correctly appended nothing
    // (limit 5's no-change guard) and there is no gap.
    //
    // The first version of this view reported them together as 116 sessions
    // "where work happened that is not in the record", which read as a 9%
    // capture rate and a crisis. The real figure was an order of magnitude
    // smaller. A metric that cries wolf is worse than no metric, because the
    // one time it matters nobody believes it.
    //
    // The transcript is what separates them: no transcript, or an empty one,
    // means the session had no conversation to record.
    const empty = [];
    const withWork = [];
    for (const id of r.unclosedOpens) {
      const d = r.openDetail.get(id) || {};
      let bytes = 0;
      try { if (d.transcriptPath) bytes = fs.statSync(d.transcriptPath).size; } catch { bytes = 0; }
      (bytes > 2048 ? withWork : empty).push({ id, ...d, bytes });
    }
    r.unclosedEmpty = empty;
    r.unclosedWithWork = withWork;

    w(`  opened and did nothing    ${empty.length}   (no transcript; nothing to record, not a gap)`);
    w(`  DID WORK, NO RECEIPT      ${withWork.length}   <- the real gap, incl. any session still running`);
  }
  w('');

  if (r.sessions.size > 0) {
    w('  WHAT RAN');
    const byModel = new Map();
    for (const [, s] of r.sessions) {
      const m = byModel.get(s.model) || { sessions: 0, toolCalls: 0, touched: 0 };
      m.sessions += 1; m.toolCalls += s.toolCalls; m.touched += s.touched;
      byModel.set(s.model, m);
    }
    for (const [model, m] of [...byModel].sort((a, b) => b[1].toolCalls - a[1].toolCalls)) {
      w(`    ${model.padEnd(24)} ${String(m.sessions).padStart(3)} sessions  ` +
        `${String(m.toolCalls).padStart(5)} tool calls  ${String(m.touched).padStart(4)} files`);
    }
    w('');
  }

  w('  THE GATE');
  w(`    approved                ${r.approved.length}`);
  w(`    denied                  ${r.denied.length}`);
  w(`    ran under a grant       ${r.grantUses}`);
  w('');

  if (r.denied.length > 0) {
    w('  MOST FREQUENT DENIALS');
    const top = [...r.deniedByRule].sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [reason, n] of top) w(`    ${String(n).padStart(3)}x  ${reason}`);
    w('');
  }

  // The ratio is the number worth watching. Many denials per approval means
  // the human is being asked a lot and reading less each time, which is the
  // corrosive failure KNOWN-LIMITS 26 names.
  if (r.approved.length + r.denied.length > 0) {
    const ratio = r.denied.length / Math.max(1, r.approved.length);
    w(`  friction: ${ratio.toFixed(1)} denials per approval`);
    if (ratio > 3) {
      w('    ^ high. Every avoidable signature teaches the operator to sign');
      w('      faster and read less. Worth asking what is being re-signed.');
    }
    w('');
  }
}

function printCharter(charter, r, home) {
  const w = s => process.stdout.write(s + '\n');

  const pubFile = path.join(home, 'keys', 'approval.pub');
  let pubX = null;
  if (fs.existsSync(pubFile)) {
    const raw = fs.readFileSync(pubFile, 'utf8').trim();
    const m = /^ed25519:([^:]+):/.exec(raw);
    pubX = m ? m[1] : null;
  }

  w('');
  w(`CHARTER  ${charter.id}   ${charter.title || ''}`);
  w('='.repeat(64));

  const v = pubX ? verifyCharter(charter, pubX) : { ok: false, reason: 'no approval public key on this machine' };
  w(`  integrity      ${v.ok ? 'VALID' : 'INVALID -- ' + v.reason}`);
  w(`  issued         ${stamp(charter.issuedAt)}`);
  w(`  expires        ${charter.expiresAt ? stamp(charter.expiresAt) : 'no window'}`);
  w(`  declared       ${charter.itemCount} items`);
  w('');

  // States are a sidecar in v1. Said plainly, because a sidecar can be edited
  // to mark an item closed that never ran; deriving state from chain entries
  // the way grants derive their ceiling is the correct design and is not built.
  const statesFile = path.join(home, 'charters', `${charter.id}.states.json`);
  let states = {};
  if (fs.existsSync(statesFile)) {
    try { states = JSON.parse(fs.readFileSync(statesFile, 'utf8')); } catch { /* ignore */ }
  }
  const c = completion(charter, states);
  w(`  closed ${c.closed}   blocked ${c.blocked}   withdrawn ${c.withdrawn}   open ${c.open}`);
  w(`  charter is ${c.done ? 'DONE' : 'STILL OPEN'}`);
  w('');

  // The bearing itself.
  const declared = new Map();
  for (const item of charter.items) {
    try { declared.set(canonicalizeItem(item), item); } catch { /* skip */ }
  }

  const ranButNotDeclared = [];
  for (const [canon, n] of r.actionsSeen) {
    if (!declared.has(canon)) ranButNotDeclared.push({ canon, n });
  }
  const declaredButNotRun = [];
  for (const [canon, item] of declared) {
    if (!r.actionsSeen.has(canon)) declaredButNotRun.push(item);
  }

  w('  DEVIATION');
  w(`    declared and never attempted   ${declaredButNotRun.length}`);
  for (const item of declaredButNotRun.slice(0, 8)) {
    w(`      - ${item.id || '?'}  ${truncate(detailOf(item), 56)}`);
  }
  w(`    attempted and not declared     ${ranButNotDeclared.length}`);
  for (const x of ranButNotDeclared.slice(0, 8)) {
    let d = '';
    try { d = detailOf(JSON.parse(x.canon)); } catch { d = x.canon; }
    w(`      - ${String(x.n).padStart(2)}x  ${truncate(d, 56)}`);
  }
  w('');

  w('  WHAT THIS DOES NOT TELL YOU');
  w('    Receipts carry which tools ran and a digest of their parameters.');
  w('    They carry no intent, ever. This shows that items 3 and 7 never ran');
  w('    and that four things ran which were not on the list. It cannot show');
  w('    why. Read the deviation as a question, not a verdict.');
  w('');
}

// --------------------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

const home = resolveHome();
const since = parseSince(flag('--since'));
const entries = readChain(home);
const r = reconstruct(entries, since);

if (argv.includes('--unclosed')) {
  // Answers WHAT never closed rather than how many. Grouped by working
  // directory and source, because a hundred identical opens from one cron is a
  // different story from a hundred scattered ones.
  const w = s => process.stdout.write(s + '\n');
  const groups = new Map();
  for (const id of r.unclosedOpens) {
    const d = r.openDetail.get(id) || {};
    const key = `${d.source || '?'}  ${d.cwd || '?'}`;
    const g = groups.get(key) || { n: 0, first: Infinity, last: 0 };
    g.n += 1;
    g.first = Math.min(g.first, d.at || Infinity);
    g.last = Math.max(g.last, d.at || 0);
    groups.set(key, g);
  }
  w('');
  w(`OPENED, NEVER CLOSED  (${r.unclosedOpens.size} distinct sessions)`);
  w('='.repeat(64));
  w('');
  for (const [key, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
    w(`  ${String(g.n).padStart(4)}x  ${key}`);
    if (g.n > 1 && g.first !== Infinity) {
      w(`         first ${stamp(g.first)}   last ${stamp(g.last)}`);
    }
  }
  w('');
  w('  A session that opens and never closes wrote no session receipt, so');
  w('  everything after its last captured tool call is unknown. Sessions still');
  w('  running appear here too, which is why this is a place to look rather');
  w('  than a count of failures.');
  w('');
  process.exit(0);
}

const charterId = flag('--charter');
if (charterId) {
  const charter = loadCharters(home).find(c => c.id === charterId);
  if (!charter) die(`no charter ${charterId} in ${path.join(home, 'charters')}`);
  printCharter(charter, r, home);
}

printWindow(r);
