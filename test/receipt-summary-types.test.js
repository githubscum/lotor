/**
 * query_receipts must say what each row IS, and must never report a field that
 * does not apply to that row.
 *
 * WHY THIS TEST EXISTS
 *   The chain holds six kinds of entry and only one of them carries work
 *   counts. The previous summariser mapped all of them through a single shape
 *   with `|| 0`, so a gate denial and a session that did nothing came back
 *   identical: toolCalls 0, touchedCount 0, no type.
 *
 *   On 2026-07-26 an agent queried this surface to find out what a concurrent
 *   session had built, read twelve consecutive rows of zeros, and concluded the
 *   chain was empty. The chain had 771 entries and was intact. Nothing was
 *   lost; the answer was simply unavailable. That is a counting failure, and
 *   these assertions are the guard against it recurring.
 *
 * THE RULE BEING TESTED
 *   Absent is not zero. A field that does not apply is omitted, not defaulted.
 *
 * PROVE-FAIL-FIRST, RUN LATE
 *   The fix was written before this test, so the discipline was broken. Rather
 *   than assert the test would have caught it, the pre-fix summariser was
 *   reproduced verbatim and these assertions were run against it on 2026-07-26.
 *   All five failed:
 *
 *     - gated-action reports a type                    failed
 *     - gated-action must not report toolCalls         failed
 *     - session-open carries payload-level sessionId   failed
 *     - a kind-discriminated row is labelled           failed
 *     - a quiet session and a denial differ            failed
 *
 *   Every assertion discriminates. A test that passes against the broken code
 *   is worse than no test, because it manufactures confidence, and the only way
 *   to know which kind you have is to run it against the break.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeEntry } from '../src/mcp/server.js';

/** A row as it appears in the chain, wrapped the way the store yields it. */
const entry = (payload, seq = 1) => ({
  seq,
  timestamp: 1785000000000,
  hash: 'a'.repeat(64),
  payload
});

test('an untyped payload is reported as a session receipt', () => {
  // The original receipt shape predates typed payloads and has no `type`.
  // Callers should never have to know that history.
  const s = summarizeEntry(entry({
    session: { id: 'sess-1', model: 'claude-opus-5', subsession: null },
    counts: { turns: 50, toolCalls: 39, failures: 0 },
    touched: ['a.js', 'b.js']
  }));

  assert.equal(s.type, 'session');
  assert.equal(s.sessionId, 'sess-1');
  assert.equal(s.model, 'claude-opus-5');
  assert.equal(s.turns, 50);
  assert.equal(s.toolCalls, 39);
  assert.equal(s.failures, 0);
  assert.equal(s.touchedCount, 2);
});

test('a gated-action carries its decision and never a tool-call count', () => {
  const s = summarizeEntry(entry({
    type: 'gated-action',
    decision: 'denied',
    action: 'PowerShell',
    reason: 'no approval token provided'
  }));

  assert.equal(s.type, 'gated-action');
  assert.equal(s.decision, 'denied');
  assert.equal(s.action, 'PowerShell');
  assert.equal(s.reason, 'no approval token provided');

  // The heart of it. A denial has no counts, so it must not claim any.
  assert.ok(!('toolCalls' in s), 'gated-action must not report toolCalls');
  assert.ok(!('touchedCount' in s), 'gated-action must not report touchedCount');
});

test('a session-open carries its sessionId from the payload level', () => {
  // session-open puts sessionId at the top of the payload, not under `session`.
  // The old summariser read only payload.session.id and so dropped it entirely.
  const s = summarizeEntry(entry({
    type: 'session-open',
    sessionId: 'sess-2',
    source: 'startup',
    cwd: 'C:\\Users\\liemi'
  }));

  assert.equal(s.type, 'session-open');
  assert.equal(s.sessionId, 'sess-2');
  assert.equal(s.source, 'startup');
  assert.ok(!('toolCalls' in s), 'session-open must not report toolCalls');
});

test('a policy-warn carries its rule id', () => {
  const s = summarizeEntry(entry({ type: 'policy-warn', ruleId: 'push-force' }));
  assert.equal(s.type, 'policy-warn');
  assert.equal(s.ruleId, 'push-force');
  assert.ok(!('toolCalls' in s));
});

test('a payload discriminated by `kind` is labelled, not called unknown', () => {
  // The attempt-ledger writer uses `kind` and snake_case where the gate and the
  // hooks use `type` and camelCase. Reading only one convention mislabels the
  // other, which is absent-is-not-zero wearing a different hat. Found while
  // auditing coverage, not by reasoning about it.
  const s = summarizeEntry(entry({
    kind: 'ledger-head',
    limit_id: 11,
    entry_count: 2,
    head_hash: 'c'.repeat(64)
  }));

  assert.equal(s.type, 'ledger-head');
  assert.ok(!('toolCalls' in s));
});

test('an unknown type is described thinly rather than dropped', () => {
  // A future payload type must still be legible. Reporting it as an unknown
  // row is honest; omitting it would make the readout quietly incomplete,
  // which is the failure mode this whole file exists to prevent.
  const s = summarizeEntry(entry({ type: 'ledger-head', head: { seq: 700 } }));
  assert.equal(s.type, 'ledger-head');
  assert.equal(s.seq, 1);
  assert.ok(!('toolCalls' in s));
});

test('a session that genuinely did nothing is distinguishable from a denial', () => {
  // This is the pair that were indistinguishable before, and the reason the
  // agent read the chain as empty.
  const quietSession = summarizeEntry(entry({
    session: { id: 'sess-3', model: 'claude-opus-5' },
    counts: { turns: 0, toolCalls: 0, failures: 0 },
    touched: []
  }));
  const denial = summarizeEntry(entry({
    type: 'gated-action', decision: 'denied', action: 'Bash'
  }));

  assert.equal(quietSession.type, 'session');
  assert.equal(quietSession.toolCalls, 0, 'a real zero is still reported');
  assert.equal(denial.type, 'gated-action');
  assert.ok(!('toolCalls' in denial), 'an absent count is absent, not zero');
  assert.notDeepEqual(quietSession, denial);
});
