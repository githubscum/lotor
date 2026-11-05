/**
 * The since-view: what happened while I was not looking.
 *
 * WHY THIS EXISTS
 *   Concurrent sessions cannot see each other. On 2026-07-26 an unattended
 *   session at 02:30 read the repo, confirmed a tool already existed, and wrote
 *   a proposal saying so. Seventeen hours later an interactive session asserted
 *   three separate times that the same tool did not exist. Both sessions were
 *   recorded in the same chain.
 *
 *   The information was never missing. It was unreachable, because nothing
 *   summarised the chain across sessions. These tests hold the shape of the
 *   thing that makes it reachable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sinceReport, renderSince } from '../src/views/since.js';

const at = (ms, payload, seq) => ({ seq, timestamp: ms, hash: 'h', payload });

/** Two sessions, one busy and one idle, plus a denial that belongs to neither. */
function fixture() {
  return [
    at(1000, { type: 'session-open', sessionId: 'A', source: 'startup', cwd: '/repo' }, 1),
    at(1100, { type: 'session-open', sessionId: 'B', source: 'startup', cwd: '/elsewhere' }, 2),
    at(1200, { type: 'gated-action', decision: 'denied', action: 'Bash', reason: 'no token' }, 3),
    at(1300, {
      session: { id: 'A', model: 'claude-opus-5' },
      counts: { turns: 10, toolCalls: 7, failures: 1 },
      touched: [{ path: '/repo/tokens.js', via: 'write' }]
    }, 4),
    at(1400, {
      session: { id: 'B', model: 'claude-sonnet-5' },
      counts: { turns: 2, toolCalls: 0, failures: 0 },
      touched: []
    }, 5)
  ];
}

test('work is attributed to the session that did it', () => {
  const r = sinceReport(fixture());
  assert.equal(r.sessions.length, 1, 'only the session that did work is listed');

  const a = r.sessions[0];
  assert.equal(a.sessionId, 'A');
  assert.equal(a.model, 'claude-opus-5');
  assert.equal(a.toolCalls, 7);
  assert.equal(a.failures, 1);
  assert.equal(a.cwd, '/repo', 'cwd comes from the open receipt');
  assert.deepEqual(a.touched, ['/repo/tokens.js'],
    'the path is kept, because a count narrows and a path answers');
});

test('sessions that opened and did nothing are counted, not enumerated', () => {
  // 101 idle sessions in one real day. Listing them buries the two that matter,
  // which is the failure this view exists to fix, reproduced one level up.
  const r = sinceReport(fixture());
  assert.equal(r.quietCount, 1);
  assert.deepEqual(r.quietSessionIds, ['B']);
  assert.ok(!r.sessions.some(s => s.sessionId === 'B'));

  const withQuiet = sinceReport(fixture(), { includeQuiet: true });
  assert.equal(withQuiet.sessions.length, 2, 'they are still reachable on request');
});

test('a gate denial with no session id stays unattributed rather than guessed at', () => {
  // Rows written before 2026-09-07 (and some since) carry no sessionId. With
  // concurrent sessions, attributing by timestamp would be wrong often enough
  // to be worse than a stated gap, so the row stays a stated gap.
  const r = sinceReport(fixture());
  assert.equal(r.unattributed.denials.length, 1);
  assert.equal(r.unattributed.denials[0].action, 'Bash');
  for (const s of r.sessions) {
    assert.equal(s.denials.length, 0,
      'a denial whose row states no session id must never be pinned to a session');
  }
});

test('the window filters by timestamp', () => {
  const r = sinceReport(fixture(), { since: 1350 });
  assert.equal(r.window.entryCount, 1);
  assert.equal(r.sessions.length, 0, 'nothing in that window did work');
  assert.equal(r.quietCount, 1);
});

test('a caller can exclude its own session', () => {
  const r = sinceReport(fixture(), { excludeSessionId: 'A' });
  assert.equal(r.sessions.length, 0, 'A did the work and A was excluded');
});

test('an empty report says nothing was recorded, not that nothing happened', () => {
  const out = renderSince(sinceReport([], {}));
  assert.match(out, /nothing was RECORDED/);
  assert.match(out, /does not mean nothing ran/);
});

test('the render always states what it cannot tell you', () => {
  const out = renderSince(sinceReport(fixture()));
  assert.match(out, /never carry intent/);
  assert.match(out, /self-attested/);
  assert.match(out, /no session id/);
});

test('subsession receipts accumulate rather than overwrite', () => {
  // A session can write several receipts. Taking the last one under-reports
  // exactly the busiest sessions, which are the ones worth finding.
  const entries = [
    at(1000, { type: 'session-open', sessionId: 'A' }, 1),
    at(1100, { session: { id: 'A' }, counts: { toolCalls: 5, turns: 5 }, touched: [{ path: '/a' }] }, 2),
    at(1200, { session: { id: 'A' }, counts: { toolCalls: 9, turns: 9 }, touched: [{ path: '/b' }] }, 3)
  ];
  const r = sinceReport(entries);
  assert.equal(r.sessions[0].toolCalls, 14);
  assert.deepEqual(r.sessions[0].touched, ['/a', '/b']);
});

// --- Gate rows that carry a session id (limit 74, since-view half) ---
//
// Lotor records and never infers: a gate row is attributed only when its own
// payload states a non-empty string `sessionId`, and never by timestamp. All
// rows here are synthetic.

test('a gate row whose sessionId states A lands on A, and on nothing else', () => {
  const entries = [
    at(1000, { type: 'gated-action', decision: 'denied', action: 'Bash', reason: 'no token', sessionId: 'A' }, 1),
    at(1100, { type: 'gated-action', decision: 'allowed', action: 'Edit', sessionId: 'B' }, 2)
  ];
  const r = sinceReport(entries);

  const a = r.sessions.find(s => s.sessionId === 'A');
  assert.ok(a, 'a denied gate row is evidence of work (a)');
  assert.equal(a.denials.length, 1, 'the denial goes on A\'s record');
  assert.equal(a.denials[0].action, 'Bash');
  assert.equal(a.denials[0].reason, 'no token');
  assert.equal(a.denials[0].seq, 1);
  assert.equal(a.approvals.length, 0);
  assert.deepEqual(a.firstGateAt, 1000, 'firstGateAt is its first attributed gate row (b)');

  const b = r.sessions.find(s => s.sessionId === 'B');
  assert.ok(b);
  assert.equal(b.approvals.length, 1, 'the approval goes on B\'s record');
  assert.equal(b.approvals[0].decision, 'allowed');
  assert.equal(b.approvals[0].action, 'Edit');
  assert.equal(b.denials.length, 0);

  assert.equal(r.unattributed.denials.length, 0, 'attributed rows leave the unattributed lists');
  assert.equal(r.unattributed.approvals.length, 0);
});

test('a gate row that states no usable sessionId stays unattributed', () => {
  // Absent, null, empty, non-string, and snake_case are all no-owner states.
  // Only camelCase `sessionId` with a non-empty string attributes.
  const entries = [
    at(1000, { type: 'gated-action', decision: 'denied', action: 'Bash' }, 1),
    at(1100, { type: 'gated-action', decision: 'denied', action: 'Bash', sessionId: null }, 2),
    at(1200, { type: 'gated-action', decision: 'denied', action: 'Bash', sessionId: '' }, 3),
    at(1300, { type: 'gated-action', decision: 'denied', action: 'Bash', sessionId: 7 }, 4),
    at(1400, { type: 'gated-action', decision: 'denied', action: 'Bash', session_id: 'A' }, 5)
  ];
  const r = sinceReport(entries);
  assert.equal(r.unattributed.denials.length, 5, 'all five stay in unattributed');
  assert.equal(r.sessions.length, 0, 'no session record was created for any of them');
  assert.deepEqual(r.quietSessionIds, []);
});

test('a policy-warn with a session id lands on warns; without one stays unattributed', () => {
  const entries = [
    at(1000, { type: 'policy-warn', ruleId: 'r1', sessionId: 'A' }, 1),
    at(1100, { type: 'policy-warn', ruleId: 'r2' }, 2)
  ];
  const r = sinceReport(entries);

  const a = r.sessions.find(s => s.sessionId === 'A');
  assert.ok(a);
  assert.equal(a.warns.length, 1);
  assert.equal(a.warns[0].ruleId, 'r1');
  assert.equal(a.firstGateAt, 1000);

  assert.equal(r.unattributed.warns.length, 1);
  assert.equal(r.unattributed.warns[0].ruleId, 'r2');
});

test('an egress row never attributes, even when a sessionId key is on it', () => {
  const entries = [
    at(1000, { type: 'egress-event', ruleId: 'eg1', sessionId: 'A' }, 1)
  ];
  const r = sinceReport(entries);
  assert.equal(r.unattributed.egress.length, 1, 'the row stays in unattributed.egress');
  assert.equal(r.sessions.length, 0, 'no session record was created for the id on it');
});

test('a session whose only row is a denial is listed, not counted quiet', () => {
  // No open, no close receipt: the denial is itself evidence of work, so the
  // session must not read as "opened idle, not listed" (a).
  const entries = [
    at(1000, { type: 'gated-action', decision: 'denied', action: 'Bash', reason: 'no token', sessionId: 'A' }, 1)
  ];
  const r = sinceReport(entries);
  assert.equal(r.sessions.length, 1);
  assert.equal(r.sessions[0].sessionId, 'A');
  assert.deepEqual(r.quietSessionIds, []);
  assert.equal(r.sessions[0].opened, null);
  assert.equal(r.sessions[0].firstGateAt, 1000);
});

test('a gate-only session sorts by its first gate row', () => {
  // (b) A session with no open and no close must not sort as 0. Sort on the
  // first attributed gate row when that is all there is.
  const entries = [
    at(1000, { type: 'session-open', sessionId: 'OPEN1', source: 'startup' }, 1),
    at(2000, { type: 'gated-action', decision: 'denied', action: 'Bash', sessionId: 'GATE' }, 2),
    at(3000, { type: 'session-open', sessionId: 'OPEN3', source: 'startup' }, 3)
  ];
  const r = sinceReport(entries, { includeQuiet: true });
  assert.deepEqual(r.sessions.map(s => s.sessionId), ['OPEN1', 'GATE', 'OPEN3'],
    'the gate-only session sits between the sessions opened around it');
});

test('an approvals-only window still prints the unattributed block', () => {
  // (c) The block guard counts denials, warnings and egress; without approvals
  // in it, an approvals-only window printed nothing.
  const entries = [
    at(1000, { type: 'gated-action', decision: 'allowed', action: 'Bash' }, 1)
  ];
  const out = renderSince(sinceReport(entries, {}));
  assert.match(out, /approved/, 'the unattributed block prints, with its approval line');
});

test('a working session with no attributed gate rows gets no gate line and no zero count', () => {
  // (d) A session with no attributed row may still own a row in the
  // unattributed list, so printing "0 denied" would state a count the report
  // refuses to make.
  const out = renderSince(sinceReport(fixture(), {}));
  assert.ok(!/^    gate /m.test(out), 'no gate line prints');
  assert.ok(!out.includes('0 denied'), 'no zero count prints for the gate line');
});

test('excludeSessionId drops the attributed rows entirely, not into unattributed', () => {
  // (e) Filtering happens after attribution, so excluded rows are simply gone.
  const entries = [
    at(1000, { type: 'gated-action', decision: 'denied', action: 'Bash', sessionId: 'A' }, 1)
  ];
  const r = sinceReport(entries, { excludeSessionId: 'A' });
  assert.equal(r.sessions.length, 0);
  assert.equal(r.unattributed.denials.length, 0,
    'the exclusion must not relocate the denial into unattributed');
});

test('the per-session gate line reads as denied (tally), approved, warnings', () => {
  // Parts join in that order, only non-zero parts print, and the denied tally
  // is by action.
  const entries = [
    at(1000, { type: 'gated-action', decision: 'denied', action: 'Bash', sessionId: 'A' }, 1),
    at(1100, { type: 'gated-action', decision: 'denied', action: 'Bash', sessionId: 'A' }, 2),
    at(1200, { type: 'gated-action', decision: 'allowed', action: 'Edit', sessionId: 'A' }, 3),
    at(1300, { type: 'policy-warn', ruleId: 'r1', sessionId: 'A' }, 4),
    at(1400, { type: 'policy-warn', ruleId: 'r2', sessionId: 'A' }, 5),
    at(1500, { type: 'policy-warn', ruleId: 'r3', sessionId: 'A' }, 6)
  ];
  const out = renderSince(sinceReport(entries, {}));
  assert.match(out, /gate        2 denied \(Bash x2\), 1 approved, 3 warnings/);
});

test('the caveat no longer says gate decisions carry no session id', () => {
  // The old sentence is false for rows written since 2026-09-07.
  const out = renderSince(sinceReport(fixture(), {}));
  assert.ok(!out.includes('Gate decisions carry no session id'));
  assert.match(out, /no session id/, 'the phrase survives in the caveat');
});

test('the action tally counts names that collide with Object members', () => {
  // tallyByAction counted on a plain {}: `constructor` came back as the
  // inherited Object constructor and `__proto__` was swallowed by setter
  // semantics, so the tally misreported exactly these names. It counts on a
  // Map now, so any action name is just a key. All rows here are synthetic.
  for (const name of ['constructor', '__proto__', 'toString']) {
    const entries = [
      at(1000, { type: 'gated-action', decision: 'denied', action: name, sessionId: 'A' }, 1),
      at(1100, { type: 'gated-action', decision: 'denied', action: name, sessionId: 'A' }, 2)
    ];
    const out = renderSince(sinceReport(entries, {}));
    assert.ok(out.includes(`2 denied (${name} x2)`), `the tally handles ${name}`);
  }

  const unattributed = [
    at(1000, { type: 'gated-action', decision: 'denied', action: 'constructor' }, 1)
  ];
  const out = renderSince(sinceReport(unattributed, {}));
  assert.ok(out.includes('denied      1  (constructor x1)'),
    'the unattributed tally counts the name too');
});
