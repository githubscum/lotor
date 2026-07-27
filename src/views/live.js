/**
 * src/views/live.js
 *
 * What is happening RIGHT NOW, in the other windows.
 *
 * WHY THIS EXISTS
 *   A receipt is written at session end. So while three sessions run
 *   concurrently, the chain holds one row each -- their opens -- and nothing
 *   about what any of them is doing. `sessions_since` answers "what happened
 *   yesterday". It cannot answer "what is my other window doing", which is the
 *   question that actually costs something when you work in three at once.
 *
 * NO NEW HOOK, NO NEW WRITES
 *   Everything needed is already on disk:
 *     - `session-open` receipts record `transcriptPath` and `sessionId`
 *     - those transcripts are written live by the harness
 *     - `parseSession` already reduces a transcript to {session, counts, touched}
 *   So this reads what exists rather than adding a per-turn receipt. A heartbeat
 *   row every N tool calls would write to an append-only chain forever to answer
 *   a question that matters for a few minutes.
 *
 * AWARENESS, NOT EVIDENCE. The distinction is load-bearing.
 *   A live summary is an observation of a session in progress. It is unsigned,
 *   it is not in the chain, and it changes under you as the session runs. The
 *   receipt written at session end is the record. Use this to know what your
 *   other windows are doing; use the chain for what actually happened. Treating
 *   a live reading as evidence would be the same error as treating a clean chain
 *   as proof of completeness.
 */

import fs from 'node:fs';
import { loadChain } from '../store/index.js';
import { parseSession } from '../parser/index.js';

/** Sessions that have a close receipt are done; everything else may be live. */
function closedSessionIds(entries) {
  const closed = new Set();
  for (const e of entries) {
    const id = e.payload?.session?.id;
    if (id) closed.add(id);
  }
  return closed;
}

/** The most recent open per session, since a session can re-open on compaction. */
function opensBySession(entries) {
  const opens = new Map();
  for (const e of entries) {
    const p = e.payload;
    if (p?.type !== 'session-open' || !p.sessionId) continue;
    const prev = opens.get(p.sessionId);
    if (!prev || e.timestamp >= prev.at) {
      opens.set(p.sessionId, {
        sessionId: p.sessionId,
        at: e.timestamp,
        cwd: p.cwd ?? null,
        source: p.source ?? null,
        transcriptPath: p.transcriptPath ?? null
      });
    }
  }
  return opens;
}

/**
 * @param {string} baseDir            LOTOR_HOME
 * @param {object} opts
 * @param {string} [opts.excludeSessionId]  usually your own
 * @param {number} [opts.staleAfterMs]      a transcript untouched for longer
 *                                          than this is reported as stale
 *                                          rather than live. Default 30 min.
 */
export function liveReport(baseDir, opts = {}) {
  const staleAfter = opts.staleAfterMs ?? 30 * 60 * 1000;
  const now = opts.now ?? Date.now();
  // Transcripts get cleaned up, so an old session with no file on disk is
  // expected and uninteresting. The first run reported 275 of them and buried
  // the three sessions actually running. Same lesson as the idle-session count:
  // never enumerate the boring majority.
  const horizon = now - (opts.withinMs ?? 24 * 60 * 60 * 1000);

  let entries = [];
  try { entries = loadChain(baseDir); } catch { entries = []; }

  const closed = closedSessionIds(entries);
  const opens = opensBySession(entries);

  const sessions = [];
  const unreadable = [];
  let agedOut = 0;

  for (const o of opens.values()) {
    if (closed.has(o.sessionId)) continue;               // already has a receipt
    if (opts.excludeSessionId === o.sessionId) continue;
    if (o.at < horizon) { agedOut++; continue; }         // old, transcript long gone
    if (!o.transcriptPath) { unreadable.push({ ...o, why: 'no transcriptPath recorded' }); continue; }

    let stat;
    try { stat = fs.statSync(o.transcriptPath); }
    catch { unreadable.push({ ...o, why: 'transcript not on disk' }); continue; }

    // A session that opened and never wrote anything is not interesting and
    // there are a great many of them. 134 in one day.
    if (stat.size === 0) continue;

    let parsed = null;
    try {
      parsed = parseSession(fs.readFileSync(o.transcriptPath, 'utf-8'));
    } catch (e) {
      unreadable.push({ ...o, why: `parse failed: ${e.message}` });
      continue;
    }

    const counts = parsed?.counts || {};
    const touched = Array.isArray(parsed?.touched) ? parsed.touched : [];
    // No work recorded yet is the same nothing-to-say as an empty transcript.
    if (!counts.toolCalls && touched.length === 0) continue;

    const idleMs = now - stat.mtimeMs;
    sessions.push({
      sessionId: o.sessionId,
      state: idleMs > staleAfter ? 'stale' : 'live',
      openedAt: o.at,
      lastActivity: stat.mtimeMs,
      idleMinutes: Math.round(idleMs / 60000),
      cwd: o.cwd,
      model: parsed?.session?.model ?? null,
      turns: counts.turns ?? null,
      toolCalls: counts.toolCalls ?? null,
      failures: counts.failures ?? null,
      touchedCount: touched.length,
      touched: touched.map(t => (typeof t === 'string' ? t : t?.path)).filter(Boolean).slice(0, 12),
      transcriptBytes: stat.size
    });
  }

  sessions.sort((a, b) => b.lastActivity - a.lastActivity);

  return {
    at: now,
    sessions,
    unreadable,
    agedOut,
    caveats: [
      'AWARENESS, NOT EVIDENCE. These readings come from live transcripts, not from the chain. They are unsigned, they are not receipts, and they change as the sessions run.',
      'A session appears here only until it writes its close receipt. After that it is in the chain and belongs to sessions_since.',
      'Absence means no open receipt, no transcript, or no work yet. It does not mean no session is running.'
    ]
  };
}

const clock = ms => (ms == null ? '—' : new Date(ms).toLocaleTimeString());

export function renderLive(r) {
  const L = [];
  L.push('');
  L.push(`IN FLIGHT   as of ${clock(r.at)}`);
  L.push('='.repeat(66));

  if (r.sessions.length === 0) {
    L.push('  Nothing in flight, or nothing that has done work yet.');
    L.push('  Absence is not proof no session is running.');
    L.push('');
  }

  for (const s of r.sessions) {
    const tag = s.state === 'live' ? 'LIVE' : `stale ${s.idleMinutes}m`;
    L.push(`  ${s.sessionId}   ${tag}`);
    if (s.cwd) L.push(`    cwd         ${s.cwd}`);
    if (s.model) L.push(`    model       ${s.model}`);
    L.push(`    work        ${s.toolCalls ?? 0} tool calls, ${s.touchedCount} files, last active ${clock(s.lastActivity)}`);
    if (s.touched.length) {
      L.push(`    touched     ${s.touched[0]}`);
      for (const t of s.touched.slice(1, 5)) L.push(`                ${t}`);
      if (s.touched.length > 5) L.push(`                ... and ${s.touchedCount - 5} more`);
    }
    L.push('');
  }

  // Both of these are large, boring and expected. A count is the honest report;
  // enumerating them is how the signal got buried on the first two runs.
  const quiet = [];
  if (r.unreadable.length) {
    quiet.push(`${r.unreadable.length} opened today with no transcript to read`);
  }
  if (r.agedOut) {
    quiet.push(`${r.agedOut} older, never closed, transcripts long gone`);
  }
  if (quiet.length) {
    L.push(`  not shown: ${quiet.join('; ')}. Expected, not a gap.`);
    L.push('');
  }

  L.push('  WHAT THIS IS NOT');
  for (const c of r.caveats) L.push(`    - ${c}`);
  L.push('');
  return L.join('\n');
}
