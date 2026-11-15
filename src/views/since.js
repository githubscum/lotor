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
 *   3. Gate rows written since 2026-09-07 carry the session id the hook passed,
 *      self-reported (limit 1), and are listed under that session; older rows,
 *      rows with a null id, and egress rows are an unattributed timeline and
 *      are never guessed at from timestamps.
 */

import { loadChain } from '../store/index.js';

/**
 * Two discriminator conventions live in the same chain, found 2026-07-26:
 *   `type`  camelCase payloads from the gate and the hooks
 *   `kind`  snake_case payloads from the attempt-ledger work
 * An untyped payload carrying `session` is the original receipt shape and
 * predates both. Reading only one convention silently mislabels the other.
 */
export function typeOf(payload) {
  return payload?.type ?? payload?.kind ?? (payload?.session ? 'session' : 'unknown');
}

/**
 * The owner of a gate row, read the way limit 74 draws it: a row is attributed
 * only when its own payload states a non-empty string `sessionId`. Key absent,
 * `null`, empty, or any non-string means no owner, and no other spelling counts.
 */
const ownerOf = p => (typeof p.sessionId === 'string' && p.sessionId !== '') ? p.sessionId : null;

/**
 * Resolve a `since` argument into a millisecond timestamp.
 * Accepts: ms number, ISO string, or `{ seq }` to start after a chain sequence.
 * Returns null for "from the beginning", which is a legitimate ask.
 */
export function resolveSince(since, entries) {
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
        // touchedRefused (limit 76, closed 2026-10-19): touched items whose
        // receipt says the harness returned an error for the attempt. null
        // when no receipt was written; 0 means a receipt existed and refused
        // nothing it can show, so the two states stay apart.
        touchedRefused: null,
        touched: [],
        // Paths whose receipt item carried outcome 'error', kept beside the
        // bare path list so the render can mark the refusal in place.
        refusedPaths: [],
        // Gate rows the row's own `sessionId` attributes to this session
        // (written since 2026-09-07, limit 35; the split is limit 74).
        // firstGateAt is the timestamp of its first attributed gate row, null
        // when none: the sort key for a session with no open and no close.
        denials: [],
        approvals: [],
        warns: [],
        firstGateAt: null,
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
            // The receipt's own word (limit 76): outcome 'error' means the
            // harness returned an error for that attempt. Old receipts carry
            // no outcome key and refuse nothing a reader can see.
            if (pth && typeof t === 'object' && t?.outcome === 'error') {
              if (!s.refusedPaths.includes(pth)) s.refusedPaths.push(pth);
            } else if (pth && s.refusedPaths.includes(pth)) {
              // A later receipt answering the same path with a landed write
              // (any outcome other than 'error', including none) un-refuses
              // it: one landed write is a write.
              s.refusedPaths.splice(s.refusedPaths.indexOf(pth), 1);
            }
          }
          // DISTINCT refused paths for the session, not a per-receipt sum.
          // Every subsession receipt re-parses the whole transcript
          // (src/ingest), so one refused write in a session with three
          // SessionEnd firings appears in three receipts; summing them read
          // as "(3 refused)" for one refusal.
          s.touchedRefused = s.refusedPaths.length;
        }
        break;
      }

      // A gate row written since 2026-09-07 carries the session id the hook
      // passed (self-reported, limit 1), and is listed under that session.
      // A row with no id — all rows older than that, and some since — stays
      // in the unattributed timeline. Attributing by timestamp would be a
      // guess, and with concurrent sessions a guess is wrong often enough to
      // be worse than an honest gap. Only camelCase `sessionId` counts: a
      // snake_case `session_id` is a different spelling, not an owner.
      case 'gated-action': {
        const ownerId = ownerOf(p);
        if (ownerId) {
          const s = ensure(ownerId);
          if (s.firstGateAt === null) s.firstGateAt = e.timestamp;
          if ((p.decision ?? null) === 'denied') {
            s.denials.push({
              seq: e.seq, timestamp: e.timestamp,
              action: p.action ?? null, reason: p.reason ?? null
            });
          } else {
            s.approvals.push({
              seq: e.seq, timestamp: e.timestamp,
              decision: p.decision ?? null, action: p.action ?? null
            });
          }
          break;
        }
        denials.push({
          seq: e.seq, timestamp: e.timestamp,
          decision: p.decision ?? null, action: p.action ?? null, reason: p.reason ?? null
        });
        break;
      }

      case 'policy-warn': {
        // Same split as `gated-action`, on the payload's own id.
        const ownerId = ownerOf(p);
        if (ownerId) {
          const s = ensure(ownerId);
          if (s.firstGateAt === null) s.firstGateAt = e.timestamp;
          s.warns.push({ seq: e.seq, timestamp: e.timestamp, ruleId: p.ruleId ?? null });
          break;
        }
        warns.push({ seq: e.seq, timestamp: e.timestamp, ruleId: p.ruleId ?? null });
        break;
      }

      // Egress rows carry no session id in either spelling. One present on
      // the payload is not read as an owner: this row type is never attributed.
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
  list.sort((a, b) => (a.opened ?? a.closed ?? a.firstGateAt ?? 0) -
                      (b.opened ?? b.closed ?? b.firstGateAt ?? 0));

  // Most sessions open and do nothing. A single day produced 107 of them, and
  // listing all 107 in full buries the two or three that actually built
  // something -- which is the exact failure this view exists to fix, reproduced
  // one level up. So they are counted, not enumerated.
  //
  // The split is on evidence of work, not on whether a close receipt exists: a
  // session can close having done nothing, and a session can do work and die
  // before writing its receipt. The second kind must stay visible, because an
  // unclosed session that ran tools is the case KNOWN-LIMITS 14 is about.
  // A session whose only record is a gate row — a denial with no receipt
  // written, no open row seen — is evidence of work the same way an unclosed
  // session that ran tools is, and stays listed for the same reason.
  const didWork = s => (s.toolCalls ?? 0) > 0 || (s.touchedCount ?? 0) > 0
    || s.denials.length > 0 || s.approvals.length > 0 || s.warns.length > 0;
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
      'A gate decision is listed under a session only when its row states that session\'s id, and that id is self-reported by the hook. Rows with no session id (all written before 2026-09-07, and some since) are listed unattributed rather than guessed at by time, so a session showing no denials may still own one of those.',
      'A touched path is a write the transcript recorded an attempt at; a path marked refused means the harness returned an error for every attempt.'
    ]
  };
}

const stamp = ms =>
  ms === null || ms === undefined ? '—' : new Date(ms).toLocaleString();

/** Human-readable render. Kept separate so callers can have the data instead. */
export function renderSince(report) {
  const L = [];
  const w = report.window;

  // One tally, two readers: the per-session gate line and the unattributed
  // block both count rows by the action the gate was asked for.
  const tallyByAction = rows => {
    // Counted on a Map: a plain object inherits `constructor` from the
    // prototype and swallows `__proto__` into its setter, so action names that
    // collide with Object members misreported or vanished (WO-SINCE-ATTRIBUTE-2).
    const byAction = new Map();
    for (const d of rows) {
      const a = d.action ?? '?';
      byAction.set(a, (byAction.get(a) ?? 0) + 1);
    }
    return [...byAction.entries()].map(([a, n]) => `${a} x${n}`);
  };

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
      if (s.touchedCount !== null) {
        bits.push(s.touchedRefused > 0
          ? `${s.touchedCount} files touched (${s.touchedRefused} refused)`
          : `${s.touchedCount} files touched`);
      }
      L.push(`    work        ${bits.length ? bits.join(', ') : 'no close receipt, so no counts'}`);
      // Gate rows the session's own id claimed. Only non-zero parts print, so
      // a session with no attributed row gets no line at all — it may still
      // own a row in the unattributed list, and a "0 denied" would read as a
      // denial count when the report itself refuses to make one.
      const gateParts = [];
      if (s.denials?.length) {
        gateParts.push(`${s.denials.length} denied (${tallyByAction(s.denials).join(', ')})`);
      }
      if (s.approvals?.length) gateParts.push(`${s.approvals.length} approved`);
      if (s.warns?.length) gateParts.push(`${s.warns.length} warnings`);
      if (gateParts.length) L.push(`    gate        ${gateParts.join(', ')}`);
      if (s.touched && s.touched.length) {
        // Mark the refusal on the path itself (limit 76): a reader scanning
        // the paths must not have to cross-check the count line.
        const refuse = pth => (s.refusedPaths?.includes(pth) ? `${pth} (refused)` : pth);
        const show = s.touched.slice(0, 6).map(refuse);
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
  if (u.denials.length || u.approvals.length || u.warns.length || u.egress.length) {
    L.push('  UNATTRIBUTED — these carry no session id and are not guessed at');
    if (u.denials.length) {
      L.push(`    denied      ${u.denials.length}  (${tallyByAction(u.denials).join(', ')})`);
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
