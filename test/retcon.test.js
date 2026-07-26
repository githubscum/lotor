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
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { reconstruct } from '../bin/retcon.js';

const T0 = 1_700_000_000_000;

/** A chain entry as the store writes it: payload nested under `payload`. */
function entry(payload, timestamp) {
  return { seq: 0, timestamp: timestamp ?? payload.timestamp ?? T0, payload };
}

function open(sessionId, at, extra = {}) {
  return entry({ type: 'session-open', sessionId, timestamp: at, source: 'startup', ...extra }, at);
}
function close(sessionId, at, toolCalls = 5) {
  return entry({ session: { id: sessionId, model: 'test-model' }, counts: { toolCalls }, touched: [] }, at);
}
function gated(decision, at, { command = 'npm test', reason } = {}) {
  return entry({
    type: 'gated-action',
    decision,
    action: { action: 'Bash', params: { command } },
    reason,
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

describe('retcon fold: actions seen', () => {
  it('counts repeats of the same action', () => {
    const r = reconstruct([
      gated('denied', T0 + 1, { command: 'npm test', reason: 'x' }),
      gated('denied', T0 + 2, { command: 'npm test', reason: 'x' }),
      gated('approved', T0 + 3, { command: 'git push' })
    ], T0);

    const counts = [...r.actionsSeen.values()];
    assert.equal(counts.reduce((a, b) => a + b, 0), 3, 'every gated action is seen');
    assert.equal(r.actionsSeen.size, 2, 'two distinct actions');
  });

  it('treats the same command under a different tool as a different action', () => {
    const r = reconstruct([
      entry({ type: 'gated-action', decision: 'denied', reason: 'x',
              action: { action: 'Bash', params: { command: 'npm test' } }, timestamp: T0 + 1 }, T0 + 1),
      entry({ type: 'gated-action', decision: 'denied', reason: 'x',
              action: { action: 'PowerShell', params: { command: 'npm test' } }, timestamp: T0 + 2 }, T0 + 2)
    ], T0);
    assert.equal(r.actionsSeen.size, 2);
  });
});
