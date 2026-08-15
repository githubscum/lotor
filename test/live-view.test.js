// live-view (WO-RC-REPAIR-01, 2026-08-15): bridge-ephemeral and orphaned
// states, last-event-timestamp over mtime. The RC bridge produces phantom
// session-opens with no transcript, keeps sessions open forever, and touches
// transcript files long after their last real event (27h mtime drift
// observed), so the old mtime-based reading lied in both directions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liveReport, renderLive } from '../src/views/live.js';

const HOUR = 3600000;

// A minimal fake LOTOR_HOME with a receipts/chain.jsonl the store can load.
function makeHome(chainEntries) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-live-'));
  fs.mkdirSync(path.join(home, 'receipts'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'receipts', 'chain.jsonl'),
    chainEntries.map(e => JSON.stringify(e)).join('\n') + '\n',
    'utf8'
  );
  return home;
}

function openEntry(seq, ts, sessionId, transcriptPath) {
  return {
    seq, timestamp: ts, prevHash: 'x', hash: 'x',
    payload: { type: 'session-open', sessionId, source: 'startup', cwd: 'C:\\t', transcriptPath }
  };
}

// A transcript with one assistant tool call so the report keeps the session,
// with a controllable last event timestamp (ISO).
function transcript(dir, name, lastEventIso, extraLines = []) {
  const p = path.join(dir, name);
  const lines = [
    JSON.stringify({
      timestamp: lastEventIso,
      message: {
        role: 'assistant', model: 'test-model',
        content: [{ type: 'tool_use', name: 'Read', id: 't1', input: { f: 1 } }]
      }
    }),
    ...extraLines
  ];
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

test('phantom open (no transcript, id never seen again) reads bridge-ephemeral, not unreadable', () => {
  const now = Date.now();
  const home = makeHome([openEntry(0, now - HOUR, 'phantom-1', path.join(os.tmpdir(), 'does-not-exist-1.jsonl'))]);
  const r = liveReport(home, { now });
  assert.equal(r.bridgeEphemeral.length, 1);
  assert.equal(r.bridgeEphemeral[0].state, 'bridge-ephemeral');
  assert.equal(r.bridgeEphemeral[0].derived, true);
  assert.equal(r.unreadable.length, 0);
});

test('missing transcript with the id seen AGAIN in the chain stays unreadable (resumed, not phantom)', () => {
  const now = Date.now();
  const home = makeHome([
    openEntry(0, now - 2 * HOUR, 'resumed-1', path.join(os.tmpdir(), 'does-not-exist-2.jsonl')),
    openEntry(1, now - HOUR, 'resumed-1', path.join(os.tmpdir(), 'does-not-exist-2.jsonl'))
  ]);
  const r = liveReport(home, { now });
  assert.equal(r.bridgeEphemeral.length, 0);
  assert.equal(r.unreadable.length, 1);
});

test('stale last event beyond the orphan threshold reads orphaned with lastEventAt, derived', () => {
  const now = Date.now();
  const home = makeHome([]);
  const lastEvent = new Date(now - 8 * HOUR);
  const tp = transcript(home, 't-orphan.jsonl', lastEvent.toISOString());
  const chain = makeHome([openEntry(0, now - 9 * HOUR, 'orphan-1', tp)]);
  const r = liveReport(chain, { now });
  assert.equal(r.sessions.length, 1);
  const s = r.sessions[0];
  assert.equal(s.state, 'orphaned');
  assert.equal(s.derived, true);
  assert.equal(s.lastEventAt, lastEvent.getTime());
  assert.match(s.note, /transcript-derived reconciliation/);
});

test('mtime drift does not fool the reading: fresh mtime + old last event = orphaned', () => {
  const now = Date.now();
  const lastEvent = new Date(now - 10 * HOUR);
  const home = makeHome([]);
  const tp = transcript(home, 't-drift.jsonl', lastEvent.toISOString());
  // File just written, so mtime is NOW. Old code would read this as live.
  const chain = makeHome([openEntry(0, now - 11 * HOUR, 'drift-1', tp)]);
  const r = liveReport(chain, { now });
  assert.equal(r.sessions[0].state, 'orphaned');
});

test('queue-operation lines are not last events', () => {
  const now = Date.now();
  const lastReal = new Date(now - 9 * HOUR);
  const home = makeHome([]);
  const tp = transcript(home, 't-queue.jsonl', lastReal.toISOString(), [
    JSON.stringify({ type: 'queue-operation', timestamp: new Date(now - 1000).toISOString(), op: 'clear' })
  ]);
  const chain = makeHome([openEntry(0, now - 10 * HOUR, 'queue-1', tp)]);
  const r = liveReport(chain, { now });
  assert.equal(r.sessions[0].state, 'orphaned');
  assert.equal(r.sessions[0].lastEventAt, lastReal.getTime());
});

test('fresh session stays live; orphan threshold is parameterized', () => {
  const now = Date.now();
  const home = makeHome([]);
  const tp = transcript(home, 't-live.jsonl', new Date(now - 5 * 60000).toISOString());
  const chain = makeHome([openEntry(0, now - HOUR, 'live-1', tp)]);
  const r = liveReport(chain, { now });
  assert.equal(r.sessions[0].state, 'live');
  // Tighten the threshold below the idle time and the same session orphans.
  const r2 = liveReport(chain, { now, orphanAfterMs: 60000 });
  assert.equal(r2.sessions[0].state, 'orphaned');
});

test('renderLive labels both states and reports bridge-ephemeral distinctly', () => {
  const now = Date.now();
  const home = makeHome([]);
  const tp = transcript(home, 't-render.jsonl', new Date(now - 8 * HOUR).toISOString());
  const chain = makeHome([
    openEntry(0, now - 9 * HOUR, 'render-orphan', tp),
    openEntry(1, now - HOUR, 'render-phantom', path.join(os.tmpdir(), 'does-not-exist-3.jsonl'))
  ]);
  const out = renderLive(liveReport(chain, { now }));
  assert.match(out, /ORPHANED/);
  assert.match(out, /bridge-ephemeral open\(s\)/);
  assert.match(out, /Derived, unsigned, not chain evidence/);
});

test('caveats include the derived-not-evidence line', () => {
  const r = liveReport(makeHome([]), { now: Date.now() });
  assert.ok(r.caveats.some(c => /DERIVED, not chain evidence/.test(c)));
});
