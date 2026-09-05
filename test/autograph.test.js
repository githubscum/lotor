/**
 * The autograph ratio.
 *
 * An autograph is a signature whose content the signer did not read. A
 * signature is a decision. The gate collects either without complaint, so
 * counting them is the only defence.
 *
 * The load-bearing constraint these tests pin: this view reports BOTH a
 * window split and a per-signature match count, and the two answer
 * different questions. Per-signature attribution used to be underivable
 * from the record at all; since 2026-08-15 (paramsDigestCanonical on every
 * gate receipt) it is derivable AGAINST A KNOWN CANDIDATE — a charter's own
 * declared item — and since 2026-09-04 this view computes it rather than
 * only describing that it could (KNOWN-LIMITS 36, corrected; see
 * test/limit-36-digest-attribution.test.js for the underlying proof and its
 * residual). The window split stays because a signature the matcher counts
 * as unmatched is not thereby proven unrelated to the charter — only
 * unproven against what it declared.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autographReport, renderAutograph } from '../src/views/autograph.js';
import { digestParamsCanonical } from '../src/parser/index.js';

const HOUR = 60 * 60 * 1000;
const T0 = 1785000000000;

const gate = (ms, decision, action, seq) => ({
  seq, timestamp: ms, hash: 'h',
  payload: { type: 'gated-action', decision, action, timestamp: ms }
});

const charter = (id, from, to, signed = true) => ({
  id, title: `charter ${id}`, issuedAt: from, expiresAt: to,
  ...(signed ? { signature: 'sig' } : {})
});

test('signatures inside a charter window count as confirmations', () => {
  const entries = [
    gate(T0, 'approved', 'Edit', 1),               // outside
    gate(T0 + 2 * HOUR, 'approved', 'Bash', 2),    // inside
    gate(T0 + 3 * HOUR, 'approved', 'Bash', 3)     // inside
  ];
  const r = autographReport(entries, [charter('001', T0 + HOUR, T0 + 4 * HOUR)], { now: T0 + 5 * HOUR });

  assert.equal(r.totals.approved, 3);
  assert.equal(r.decisions.approved, 1);
  assert.equal(r.confirmations.approved, 2);
});

test('the rate is per hour, because the windows are different lengths', () => {
  // The comparison the complaint was actually about: 33 signatures in one
  // evening against 3 across a whole overnight window. Raw counts cannot say
  // which was worse; a rate can.
  //
  // Six signatures in a two-hour un-chartered burst, two across a seven-hour
  // charter. Anything that reports these as "6 vs 2" has lost the point.
  const entries = [
    gate(T0 + 10 * 60 * 1000, 'approved', 'Edit', 1),
    gate(T0 + 20 * 60 * 1000, 'approved', 'Edit', 2),
    gate(T0 + 30 * 60 * 1000, 'approved', 'Edit', 3),
    gate(T0 + 40 * 60 * 1000, 'approved', 'Edit', 4),
    gate(T0 + 50 * 60 * 1000, 'approved', 'Edit', 5),
    gate(T0 + 60 * 60 * 1000, 'approved', 'Edit', 6),
    gate(T0 + 3 * HOUR, 'approved', 'Bash', 7),
    gate(T0 + 9 * HOUR, 'approved', 'Bash', 8)
  ];
  const r = autographReport(
    entries,
    [charter('001', T0 + 2 * HOUR, T0 + 10 * HOUR)],
    { now: T0 + 10 * HOUR, since: T0 }
  );

  assert.equal(r.decisions.approved, 6);
  assert.equal(r.confirmations.approved, 2);
  assert.ok(r.decisions.perHour > r.confirmations.perHour,
    `a burst outside a charter should outrank a trickle inside one: ` +
    `${r.decisions.perHour}/h vs ${r.confirmations.perHour}/h`);
});

test('overlapping charters do not double-count clock time', () => {
  const entries = [gate(T0 + 2 * HOUR, 'approved', 'Edit', 1)];
  const r = autographReport(
    entries,
    [charter('a', T0, T0 + 3 * HOUR), charter('b', T0 + HOUR, T0 + 4 * HOUR)],
    { now: T0 + 4 * HOUR, since: T0 }
  );
  // Union is T0..T0+4h clipped to the observed span, not 3h + 3h.
  assert.ok(r.confirmations.hours <= 4.01, `hours should merge, got ${r.confirmations.hours}`);
});

test('an unsigned charter opens no window', () => {
  const entries = [gate(T0 + HOUR, 'approved', 'Edit', 1)];
  const r = autographReport(entries, [charter('draft', T0, T0 + 2 * HOUR, false)], { now: T0 + 2 * HOUR });
  assert.equal(r.confirmations.approved, 0);
  assert.equal(r.decisions.approved, 1);
});

test('denials are counted separately and never treated as signatures', () => {
  const entries = [
    gate(T0, 'denied', 'Bash', 1),
    gate(T0 + HOUR, 'approved', 'Bash', 2)
  ];
  const r = autographReport(entries, [], { now: T0 + 2 * HOUR });
  assert.equal(r.totals.approved, 1);
  assert.equal(r.totals.denied, 1);
  assert.equal(r.byAction.Bash.approved, 1);
  assert.equal(r.byAction.Bash.denied, 1);
});

test('the report states what per-signature matching can and cannot answer, not that it is impossible (KNOWN-LIMITS 36, corrected)', () => {
  // The honesty requirement moved twice: first (2026-08-15) a receipt started
  // carrying enough to match a signature to a known candidate; then
  // (2026-09-04) this view started doing that matching. The remaining honest
  // claim is narrower still — it can only confirm or deny a candidate you
  // already hold, never enumerate a receipt's target from the chain alone.
  const out = renderAutograph(autographReport([], [], { now: T0 }));
  assert.match(out, /can only confirm or deny a candidate you already hold/);
  assert.match(out, /PER-SIGNATURE MATCH/);
  assert.match(out, /no target ratio/);
});

test('per-signature match: a receipt whose digest matches a declared charter item is CONFIRMED', () => {
  const item = { id: 'i1', action: 'Edit', params: { file_path: 'a.js' } };
  const digest = digestParamsCanonical(item.params);
  const entries = [{
    seq: 1, timestamp: T0 + 2 * HOUR, hash: 'h',
    payload: { type: 'gated-action', decision: 'approved', action: 'Edit', paramsDigestCanonical: digest, timestamp: T0 + 2 * HOUR }
  }];
  const c = { ...charter('001', T0 + HOUR, T0 + 4 * HOUR), items: [item] };
  const r = autographReport(entries, [c], { now: T0 + 5 * HOUR });
  assert.equal(r.signatures.confirmed, 1);
  assert.equal(r.signatures.unmatched, 0);
  assert.equal(r.signatures.ambiguous, 0);
});

test('per-signature match: a receipt inside the window that matches no declared item is UNMATCHED, not invisible', () => {
  const item = { id: 'i1', action: 'Bash', params: { command: 'npm test' } };
  const entries = [{
    seq: 1, timestamp: T0 + 2 * HOUR, hash: 'h',
    payload: { type: 'gated-action', decision: 'approved', action: 'Edit', paramsDigestCanonical: 'somethingelse', timestamp: T0 + 2 * HOUR }
  }];
  const c = { ...charter('001', T0 + HOUR, T0 + 4 * HOUR), items: [item] };
  const r = autographReport(entries, [c], { now: T0 + 5 * HOUR });
  assert.equal(r.signatures.confirmed, 0);
  assert.equal(r.signatures.unmatched, 1);
  // Still counted as inside the window, per the window split this does not replace.
  assert.equal(r.confirmations.approved, 1);
});

test('per-signature match: two declared items sharing action+params both match, and that is AMBIGUOUS, never silently picked', () => {
  const item1 = { id: 'i1', action: 'Edit', params: { file_path: 'a.js' } };
  const item2 = { id: 'i2', action: 'Edit', params: { file_path: 'a.js' } };
  const digest = digestParamsCanonical(item1.params);
  const entries = [{
    seq: 1, timestamp: T0 + 2 * HOUR, hash: 'h',
    payload: { type: 'gated-action', decision: 'approved', action: 'Edit', paramsDigestCanonical: digest, timestamp: T0 + 2 * HOUR }
  }];
  const c = { ...charter('001', T0 + HOUR, T0 + 4 * HOUR), items: [item1, item2] };
  const r = autographReport(entries, [c], { now: T0 + 5 * HOUR });
  assert.equal(r.signatures.confirmed, 1);
  assert.equal(r.signatures.ambiguous, 1);
});

test('per-signature match guards the no-arg edge case: an item with params omitted matches a receipt whose action took no params at all', () => {
  const item = { id: 'i1', action: 'Bash' }; // params field entirely omitted, not {}
  const entries = [{
    seq: 1, timestamp: T0 + 2 * HOUR, hash: 'h',
    payload: { type: 'gated-action', decision: 'approved', action: 'Bash', paramsDigestCanonical: digestParamsCanonical(undefined), timestamp: T0 + 2 * HOUR }
  }];
  const c = { ...charter('001', T0 + HOUR, T0 + 4 * HOUR), items: [item] };
  const r = autographReport(entries, [c], { now: T0 + 5 * HOUR });
  assert.equal(r.signatures.confirmed, 1,
    'item.params omitted must digest as "empty" to match a genuinely no-arg receipt, not hash("{}")');
});

test('with no charters every signature is a decision', () => {
  const entries = [gate(T0, 'approved', 'Edit', 1), gate(T0 + HOUR, 'approved', 'Edit', 2)];
  const r = autographReport(entries, [], { now: T0 + 2 * HOUR });
  assert.equal(r.decisions.approved, 2);
  assert.equal(r.confirmations.approved, 0);
  assert.match(renderAutograph(r), /No signed charters in this window/);
});
