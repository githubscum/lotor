/**
 * test/retcon.test.js
 *
 * Regression tests for the retcon fold.
 *
 * WHY THESE EXIST, SPECIFICALLY
 *   `bin/retcon.js` shipped untested on 2026-07-25 and produced two wrong
 *   numbers on its first real run. Both changed what the output MEANT rather
 *   than merely how it looked, which is the kind of bug a display tool is
 *   supposed to be too simple to have:
 *
 *     1. Approvals were counted into the denial histogram, because an approved
 *        entry carries no `reason` and fell through to a default label. The
 *        report showed "35x denied" that were really the approvals, counted a
 *        second time under a word that meant the opposite.
 *
 *     2. Open EVENTS were counted as sessions. SessionStart fires on startup,
 *        resume, clear AND compact, so one long session emitted many opens and
 *        read as many crashed ones.
 *
 *   A third framing error had no code bug but the same effect: opens without
 *   closes were reported as one number implying lost work, when most were
 *   sessions that did nothing at all. That is asserted here too, because it is
 *   the distinction the whole view now rests on.
 *
 * PROVE-FAIL-FIRST
 *   Each test below targets a specific pre-fix behaviour and would fail against
 *   it. Tests 1 and 2 are true regressions: the old code put approvals in the
 *   histogram and counted events, so both assertions fail on it directly.
 *
 * THE FIXTURE WAS FICTION, AND THAT IS WHY 38 SHIPPED GREEN (added 2026-07-26)
 *   Until now `gated()` below wrote `action` as an OBJECT:
 *
 *     action: { action: 'Bash', params: { command } }
 *
 *   The gate has never written that. `src/gate/index.js:144` does
 *   `const action = actionRequest?.action || 'unknown'`, so `action` on every
 *   one of the four gated-action receipts is a BARE TOOL-NAME STRING. Verified
 *   twice: at the source, and against a live chain entry (`"action":"Bash"`).
 *
 *   The consequence is the whole of KNOWN-LIMITS 38. `reconstruct()` called
 *   `canonicalizeItem(p.action)`, which throws on a string, into an empty
 *   catch. So `actionsSeen` was ALWAYS EMPTY in production, and a charter
 *   reconciled against it reported every declared item as never attempted and
 *   nothing as undeclared. Both directions wrong, confidently.
 *
 *   The suite did not catch it because two tests asserted `actionsSeen` worked
 *   against a shape production never produces. This is the same failure class
 *   as limit 12, where the fixture used `createdAt` and real transcripts used
 *   `timestamp`. A fixture that disagrees with production does not merely fail
 *   to catch a bug, it manufactures confidence that there is none.
 *
 *   The fixtures below now match what the gate writes. Anything asserting the
 *   old shape was asserting a world that does not exist.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
// Namespace import on purpose. A named import of a symbol that does not exist
// yet is a link-time SyntaxError that takes the whole FILE down, so a
// prove-fail-first run would show twelve unrelated failures instead of the one
// being proved. This way a missing export fails exactly the test that calls it.
import * as retcon from '../bin/retcon.js';
const { reconstruct } = retcon;

const T0 = 1_700_000_000_000;

/** A chain entry as the store writes it: payload nested under `payload`. */
function entry(payload, timestamp) {
  return { seq: 0, timestamp: timestamp ?? payload.timestamp ?? T0, payload };
}

function open(sessionId, at, extra = {}) {
  return entry({ type: 'session-open', sessionId, timestamp: at, source: 'startup', ...extra }, at);
}
/**
 * A session receipt as `src/parser/index.js:186` writes it.
 *
 * `touched` is an array of OBJECTS, `{ path, via }`, not an array of strings:
 *
 *   touched: Array.from(touched.entries()).map(([path, meta]) => ({ path, ...meta }))
 *
 * Recorded emphatically because the first draft of these very tests used bare
 * strings here, twenty minutes after diagnosing that a fixture disagreeing with
 * production is what let KNOWN-LIMITS 38 ship green. The failure mode is not
 * carelessness, it is that a plausible shape reads as correct. Check the writer.
 */
function close(sessionId, at, toolCalls = 5, paths = []) {
  return entry({
    session: { id: sessionId, model: 'test-model' },
    counts: { toolCalls },
    touched: paths.map(p => ({ path: p, via: 'edit' }))
  }, at);
}

/**
 * A gated-action receipt EXACTLY as `src/gate/index.js` writes it.
 *
 * `action` is a bare tool-name string. There is no params object and no path,
 * which is KNOWN-LIMITS 36: an approved receipt records the tool and never the
 * target. Do not "improve" this fixture into carrying params. The point of it
 * is that the record really is this thin, and any reconciliation built on the
 * assumption that it is richer will be wrong in production while green here.
 */
function gated(decision, at, { tool = 'Bash', reason } = {}) {
  return entry({
    type: 'gated-action',
    decision,
    action: tool,
    reason,
    ...(decision === 'approved' ? { approvalNonce: `n-${at}` } : {}),
    timestamp: at
  }, at);
}

describe('retcon fold: the denial histogram', () => {
  it('does NOT count approvals as denials', () => {
    // The shipped bug. Approved entries have no `reason`, fell through to a
    // default, and appeared in the histogram under a label meaning the opposite.
    const r = reconstruct([
      gated('approved', T0 + 1),
      gated('approved', T0 + 2),
      gated('denied', T0 + 3, { reason: 'no approval token provided' })
    ], T0);

    assert.equal(r.approved.length, 2);
    assert.equal(r.denied.length, 1);

    const total = [...r.deniedByRule.values()].reduce((a, b) => a + b, 0);
    assert.equal(total, 1, 'the histogram must total the DENIALS only');
    assert.equal(r.deniedByRule.has('no approval token provided'), true);
  });

  it('buckets denials by their reason', () => {
    const r = reconstruct([
      gated('denied', T0 + 1, { reason: 'no approval token provided' }),
      gated('denied', T0 + 2, { reason: 'no approval token provided' }),
      gated('denied', T0 + 3, { reason: 'signature verification failed' })
    ], T0);
    assert.equal(r.deniedByRule.get('no approval token provided'), 2);
    assert.equal(r.deniedByRule.get('signature verification failed'), 1);
  });
});

describe('retcon fold: sessions vs open events', () => {
  it('counts DISTINCT sessions, not open events', () => {
    // One session, four opens: startup then three compactions. The shipped bug
    // reported this as four sessions.
    const s = 'sess-long';
    const r = reconstruct([
      open(s, T0 + 1),
      open(s, T0 + 2, { source: 'compact' }),
      open(s, T0 + 3, { source: 'compact' }),
      open(s, T0 + 4, { source: 'resume' })
    ], T0);

    assert.equal(r.openedIds.size, 1, 'one session');
    assert.equal(r.opens, 4, 'four open events');
  });

  it('removes a session from unclosed once it closes', () => {
    const r = reconstruct([
      open('a', T0 + 1),
      open('b', T0 + 2),
      close('a', T0 + 3)
    ], T0);

    assert.equal(r.openedIds.size, 2);
    assert.equal(r.sessions.size, 1);
    assert.equal(r.unclosedOpens.has('a'), false, 'a closed session is not unclosed');
    assert.equal(r.unclosedOpens.has('b'), true);
  });

  it('handles a close arriving before any open, without inventing a session', () => {
    // Happens when the window starts mid-session. It must not crash and must
    // not resurrect an open that was never seen.
    const r = reconstruct([close('ghost', T0 + 1)], T0);
    assert.equal(r.sessions.size, 1);
    assert.equal(r.unclosedOpens.size, 0);
  });
});

describe('retcon fold: the window', () => {
  it('excludes entries older than the cutoff', () => {
    const r = reconstruct([
      gated('denied', T0 - 10_000, { reason: 'old' }),
      gated('denied', T0 + 10_000, { reason: 'new' })
    ], T0);
    assert.equal(r.denied.length, 1);
    assert.equal(r.deniedByRule.has('new'), true);
    assert.equal(r.deniedByRule.has('old'), false);
  });

  it('is empty and does not throw on an empty chain', () => {
    const r = reconstruct([], T0);
    assert.equal(r.entries, 0);
    assert.equal(r.denied.length, 0);
    assert.equal(r.openedIds.size, 0);
  });

  it('ignores malformed entries rather than failing the whole fold', () => {
    const r = reconstruct([
      { timestamp: T0 + 1 },                       // no payload
      { payload: {}, timestamp: T0 + 2 },          // payload with no type
      gated('denied', T0 + 3, { reason: 'real' })
    ], T0);
    assert.equal(r.denied.length, 1, 'the one real entry still lands');
  });
});

describe('retcon fold: tools seen (KNOWN-LIMITS 38, root cause)', () => {
  it('counts gated calls by TOOL NAME from the shape the gate really writes', () => {
    // Pre-fix this is empty. `canonicalizeItem('Bash')` throws into an empty
    // catch, so every gated receipt in production was silently dropped.
    const r = reconstruct([
      gated('denied', T0 + 1, { tool: 'Bash', reason: 'x' }),
      gated('denied', T0 + 2, { tool: 'Bash', reason: 'x' }),
      gated('approved', T0 + 3, { tool: 'Edit' })
    ], T0);

    const counts = [...r.toolsSeen.values()];
    assert.equal(counts.reduce((a, b) => a + b, 0), 3, 'every gated call is seen');
    assert.equal(r.toolsSeen.size, 2, 'two distinct tools');
    assert.equal(r.toolsSeen.get('Bash'), 2);
    assert.equal(r.toolsSeen.get('Edit'), 1);
  });

  it('keeps the touched PATHS from a session receipt, not just how many', () => {
    // Pre-fix the fold stored `touched: p.touched.length` and discarded the
    // paths, throwing away the only evidence in the chain that can reconcile a
    // file item at all.
    const r = reconstruct([
      close('s1', T0 + 5, 3, ['src/a.js', 'src/b.js'])
    ], T0);

    assert.deepEqual([...r.touchedPaths].sort(), ['src/a.js', 'src/b.js']);
  });
});

describe('retcon reconciliation (KNOWN-LIMITS 38)', () => {
  const fileItem = (id, p) => ({ id, action: 'Edit', params: { file_path: p } });
  const cmdItem = (id, c) => ({ id, action: 'Bash', params: { command: c } });
  const charterOf = items => ({ id: 'CHARTER-TEST', title: 't', items, itemCount: items.length });

  it('confirms a declared file item whose path appears in touched', () => {
    const r = reconstruct([close('s1', T0 + 5, 3, ['src/a.js'])], T0);
    const out = retcon.reconcile(charterOf([fileItem('1', 'src/a.js')]), r);

    assert.equal(out.confirmed.length, 1);
    assert.equal(out.noEvidence.length, 0);
    assert.equal(out.unreconcilable.length, 0);
  });

  it('reports a declared file item absent from touched as NO EVIDENCE', () => {
    const r = reconstruct([close('s1', T0 + 5, 3, ['src/other.js'])], T0);
    const out = retcon.reconcile(charterOf([fileItem('1', 'src/a.js')]), r);

    assert.equal(out.confirmed.length, 0);
    assert.equal(out.noEvidence.length, 1);
  });

  it('classifies a COMMAND item as unreconcilable, never as never-attempted', () => {
    // The heart of 38. A gated receipt carries the tool and no command string
    // (limit 36), and a session receipt carries files and no commands. So the
    // record structurally cannot answer whether a declared command ran. Saying
    // "declared and never attempted" is a confident wrong answer.
    const r = reconstruct([
      gated('approved', T0 + 1, { tool: 'Bash' }),
      close('s1', T0 + 5, 3, ['src/a.js'])
    ], T0);
    const out = retcon.reconcile(charterOf([cmdItem('1', 'npm test')]), r);

    assert.equal(out.unreconcilable.length, 1, 'a command item is unreconcilable');
    assert.equal(out.noEvidence.length, 0, 'and must NOT be reported as never attempted');
    assert.equal(out.confirmed.length, 0);
  });

  it('does not call anything never-attempted when no session has closed yet', () => {
    // "While a session is still running, the retcon is reading an empty room
    // and reporting it as an empty plan." An open with no close means touched
    // does not exist yet, which is unknown, not absent.
    const r = reconstruct([open('s1', T0 + 1)], T0);
    const out = retcon.reconcile(charterOf([fileItem('1', 'src/a.js')]), r);

    assert.equal(out.pathEvidenceAvailable, false);
    assert.equal(out.noEvidence.length, 0, 'unknown is not the same as never attempted');
    assert.equal(out.undetermined.length, 1);
  });

  it('flags what ran but was not declared, by tool', () => {
    const r = reconstruct([
      gated('approved', T0 + 1, { tool: 'WebFetch' }),
      close('s1', T0 + 5, 3, ['src/a.js'])
    ], T0);
    const out = retcon.reconcile(charterOf([fileItem('1', 'src/a.js')]), r);

    assert.ok(out.toolsNotDeclared.some(x => x.tool === 'WebFetch'),
      'a tool used but not named by any declared item is surfaced');
  });
});

describe('retcon deviation note (KNOWN-LIMITS 39)', () => {
  it('derives its numbers instead of stating invented ones', () => {
    // The shipped text read "items 3 and 7 never ran and four things ran which
    // were not on the list", hardcoded, printed regardless of data, inside the
    // block headed WHAT THIS DOES NOT TELL YOU. In the run that found it, it
    // contradicted the computed figures six lines above.
    const note = retcon.deviationNote({
      noEvidence: [1, 2], unreconcilable: [], toolsNotDeclared: [1, 2, 3], undetermined: []
    });

    assert.ok(!/items 3 and 7/i.test(note), 'must not state invented item numbers');
    assert.ok(!/\bfour\b/i.test(note), 'must not state an invented count');
    assert.ok(/\b2\b/.test(note), 'must state the real no-evidence count');
    assert.ok(/\b3\b/.test(note), 'must state the real undeclared count');
  });

  it('says nothing specific when there is nothing to say', () => {
    const note = retcon.deviationNote({
      noEvidence: [], unreconcilable: [], toolsNotDeclared: [], undetermined: []
    });
    assert.ok(!/items 3 and 7/i.test(note));
    assert.ok(note.length > 0, 'the general caveat still stands');
  });
});
