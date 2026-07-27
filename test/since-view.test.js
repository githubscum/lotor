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

test('gate decisions are unattributed rather than guessed at', () => {
  // gated-action payloads carry no session id. With concurrent sessions,
  // attributing by timestamp would be wrong often enough to be worse than a
  // stated gap.
  const r = sinceReport(fixture());
  assert.equal(r.unattributed.denials.length, 1);
  assert.equal(r.unattributed.denials[0].action, 'Bash');
  for (const s of r.sessions) {
    assert.ok(!('denials' in s), 'a denial must never be pinned to a session');
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
