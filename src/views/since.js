/**
 * src/views/since.js
 *
 * The since-view: what happened while I was not looking.
 *
 * WHY THIS EXISTS
 *   Concurrent sessions cannot see each other. On 2026-07-26 three ran against
 *   the same machine; one of them built the authorization ledger and another
 *   asserted three separate times that no such thing existed. The chain had
 *   recorded all of it. Nothing surfaced it.
 *
 *   That is a counting problem, not a memory problem, and it belongs inside the
 *   product rather than around it. `receipts` answers what happened in ONE
 *   session. This answers what happened across ALL of them since a point in
 *   time, grouped the way a reader actually thinks: by session, not by row.
 *
 * WHAT IT CANNOT TELL YOU, AND WHY THAT IS PRINTED IN ITS OWN OUTPUT
 *   1. Receipts carry which named tools ran and a digest of their parameters.
 *      They never carry intent. A session summary is behavioural metadata and
 *      is not a statement about what anyone was trying to do.
 *   2. Capture is self-attested. A clean since-view is not proof another
 *      session did nothing; it is proof nothing was recorded. Silence is not
 *      safety.
 *   3. `gated-action` payloads carry NO session id. Denials therefore cannot be
 *      attributed to a session, and with concurrent sessions running they must
 *      not be guessed at from timestamps. They are reported as an unattributed
 *      timeline, deliberately separate from the per-session rollup.
 */

import { loadChain } from '../store/index.js';

/** An untyped payload is the original session receipt, which predates types. */
function typeOf(payload) {
  return payload?.type ?? (payload?.session ? 'session' : 'unknown');
}

/**
 * Resolve a `since` argument into a millisecond timestamp.
 * Accepts: ms number, ISO string, or `{ seq }` to start after a chain sequence.
 * Returns null for "from the beginning", which is a legitimate ask.
 */
function resolveSince(since, entries) {
  if (since === undefined || since === null) return null;
  if (typeof since === 'number') return since;
  if (typeof since === 'string') {
    const parsed = Date.parse(since);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof since === 'object' && typeof since.seq === 'number') {
    const row = entries.find(e => e.seq === since.seq);
    return row ? row.timestamp : null;
  }
  return null;
}

/**
 * Build the report.
 *
 * @param {Array}  entries          chain entries, oldest first
 * @param {object} opts
 * @param {number|string|{seq:number}} [opts.since]  window start
 * @param {string} [opts.excludeSessionId]  usually the caller's own session, so
 *                 "what did everyone ELSE do" is one argument rather than a
 *                 filter the caller has to remember to apply.
 */
export function sinceReport(entries, opts = {}) {
  const all = Array.isArray(entries) ? entries : [];
  const sinceTs = resolveSince(opts.since, all);
  const rows = sinceTs === null ? all : all.filter(e => e.timestamp >= sinceTs);

  /** sessionId -> accumulating record */
  const sessions = new Map();
  const ensure = id => {
    if (!sessions.has(id)) {
      sessions.set(id, {
        sessionId: id,
        opened: null, closed: null,
        source: null, cwd: null, model: null,
        turns: null, toolCalls: null, failures: null, touchedCount: null,
        touched: [],
        receiptSeq: null
      });
    }
    return sessions.get(id);
  };

  const denials = [];
  const warns = [];
  const egress = [];
  let otherRows = 0;

  for (const e of rows) {
    const p = e.payload || {};
    switch (typeOf(p)) {
      case 'session-open': {
        if (!p.sessionId) { otherRows++; break; }
        const s = ensure(p.sessionId);
        // A session can be opened more than once (resume). The first open is
        // the one that describes when it started.
        if (s.opened === null) {
          s.opened = e.timestamp;
          s.source = p.source ?? null;
          s.cwd = p.cwd ?? null;
        }
        break;
      }

      case 'session': {
        const id = p.session?.id;
        if (!id) { otherRows++; break; }
        const s = ensure(id);
        s.closed = e.timestamp;
        s.receiptSeq = e.seq;
        s.model = p.session?.model ?? s.model;
        const c = p.counts || {};
        // A session may write several receipts (subsessions). Accumulate rather
        // than overwrite, or the rollup under-reports the busiest sessions.
        s.turns = (s.turns ?? 0) + (c.turns ?? 0);
        s.toolCalls = (s.toolCalls ?? 0) + (c.toolCalls ?? 0);
        s.failures = (s.failures ?? 0) + (c.failures ?? 0);
        if (Array.isArray(p.touched)) {
          s.touchedCount = (s.touchedCount ?? 0) + p.touched.length;
          // Keep the paths, not just the count. A count narrows the search to
          // a handful of sessions; a path answers the question outright, which
          // is the difference between "go and look" and "here it is". This is
          // a local view, not the MCP summary surface, so paths are in scope.
          for (const t of p.touched) {
            const pth = typeof t === 'string' ? t : t?.path;
            if (pth && !s.touched.includes(pth)) s.touched.push(pth);
          }
        }
        break;
      }

      // No session id on this payload. Attributing it by timestamp would be a
      // guess, and with concurrent sessions a guess is wrong often enough to be
      // worse than an honest gap.
      case 'gated-action':
        denials.push({
          seq: e.seq, timestamp: e.timestamp,
          decision: p.decision ?? null, action: p.action ?? null, reason: p.reason ?? null
        });
        break;

      case 'policy-warn':
        warns.push({ seq: e.seq, timestamp: e.timestamp, ruleId: p.ruleId ?? null });
        break;

      case 'egress-event':
        egress.push({ seq: e.seq, timestamp: e.timestamp, ruleId: p.ruleId ?? null });
        break;

      default:
        otherRows++;
    }
  }

  let list = [...sessions.values()];
  if (opts.excludeSessionId) {
    list = list.filter(s => s.sessionId !== opts.excludeSessionId);
  }
  list.sort((a, b) => (a.opened ?? a.closed ?? 0) - (b.opened ?? b.closed ?? 0));

  // Most sessions open and do nothing. A single day produced 107 of them, and
  // listing all 107 in full buries the two or three that actually built
  // something -- which is the exact failure this view exists to fix, reproduced
  // one level up. So they are counted, not enumerated.
  //
  // The split is on evidence of work, not on whether a close receipt exists: a
  // session can close having done nothing, and a session can do work and die
  // before writing its receipt. The second kind must stay visible, because an
  // unclosed session that ran tools is the case KNOWN-LIMITS 14 is about.
  const didWork = s => (s.toolCalls ?? 0) > 0 || (s.touchedCount ?? 0) > 0;
  const active = list.filter(didWork);
  const quiet = list.filter(s => !didWork(s));

  return {
    window: {
      from: sinceTs,
      to: rows.length ? rows[rows.length - 1].timestamp : null,
      entryCount: rows.length
    },
    sessions: opts.includeQuiet ? list : active,
    quietCount: quiet.length,
    quietSessionIds: quiet.map(s => s.sessionId),
    unattributed: {
      denials: denials.filter(d => d.decision === 'denied'),
      approvals: denials.filter(d => d.decision !== 'denied'),
      warns,
      egress
    },
    otherRows,
    caveats: [
      'Receipts carry which named tools ran and a digest of their parameters. They never carry intent.',
      'Capture is self-attested. An empty report means nothing was recorded, not that nothing happened.',
      'Gate decisions carry no session id and are listed unattributed rather than guessed at by time.'
    ]
  };
}

const stamp = ms =>
  ms === null || ms === undefined ? '—' : new Date(ms).toLocaleString();

/** Human-readable render. Kept separate so callers can have the data instead. */
export function renderSince(report) {
  const L = [];
  const w = report.window;

  L.push('');
  L.push('WHAT HAPPENED WHILE YOU WERE NOT LOOKING');
  L.push('='.repeat(66));
  L.push(`  window        ${stamp(w.from)}  ->  ${stamp(w.to)}`);
  L.push(`  chain rows    ${w.entryCount}`);
  L.push(`  did work      ${report.sessions.length}`);
  if (report.quietCount) {
    L.push(`  opened idle   ${report.quietCount}  (no tools, no files, not listed)`);
  }
  L.push('');

  if (report.sessions.length === 0) {
    L.push('  No session in this window recorded any work.');
    L.push('  That means nothing was RECORDED. It does not mean nothing ran.');
    L.push('');
  } else {
    for (const s of report.sessions) {
      const live = s.closed === null ? '  (no close receipt)' : '';
      L.push(`  ${s.sessionId}${live}`);
      L.push(`    opened      ${stamp(s.opened)}`);
      L.push(`    closed      ${stamp(s.closed)}`);
      if (s.model) L.push(`    model       ${s.model}`);
      if (s.cwd) L.push(`    cwd         ${s.cwd}`);
      const bits = [];
      if (s.toolCalls !== null) bits.push(`${s.toolCalls} tool calls`);
      if (s.turns !== null) bits.push(`${s.turns} turns`);
      if (s.failures) bits.push(`${s.failures} failures`);
      if (s.touchedCount !== null) bits.push(`${s.touchedCount} files touched`);
      L.push(`    work        ${bits.length ? bits.join(', ') : 'no close receipt, so no counts'}`);
      if (s.touched && s.touched.length) {
        const show = s.touched.slice(0, 6);
        L.push(`    touched     ${show[0]}`);
        for (const t of show.slice(1)) L.push(`                ${t}`);
        if (s.touched.length > show.length) {
          L.push(`                ... and ${s.touched.length - show.length} more`);
        }
      }
      L.push('');
    }
  }

  const u = report.unattributed;
  if (u.denials.length || u.warns.length || u.egress.length) {
    L.push('  UNATTRIBUTED — these carry no session id and are not guessed at');
    if (u.denials.length) {
      const byAction = {};
      for (const d of u.denials) byAction[d.action ?? '?'] = (byAction[d.action ?? '?'] ?? 0) + 1;
      const parts = Object.entries(byAction).map(([a, n]) => `${a} x${n}`);
      L.push(`    denied      ${u.denials.length}  (${parts.join(', ')})`);
    }
    if (u.approvals.length) L.push(`    approved    ${u.approvals.length}`);
    if (u.warns.length) L.push(`    warnings    ${u.warns.length}`);
    if (u.egress.length) L.push(`    egress      ${u.egress.length}`);
    L.push('');
  }

  L.push('  WHAT THIS DOES NOT TELL YOU');
  for (const c of report.caveats) L.push(`    - ${c}`);
  L.push('');

  return L.join('\n');
}

/** Convenience for callers that just want it off disk. */
export function sinceFromDisk(baseDir = '.', opts = {}) {
  return sinceReport(loadChain(baseDir), opts);
}
