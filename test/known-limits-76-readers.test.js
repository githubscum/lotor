/**
 * KNOWN-LIMITS 76, narrowed 2026-11-04, branch `lotor-lane/l76-readers`:
 * three readers still reported a refused write as a plain touched file.
 *
 * WHAT THIS HOLDS
 *   Chapters: src/views/chapters.js settles each file attempt against the
 *   tool_result that answers it, per chapter; a chapter whose every answered
 *   write to a path came back as an error carries `refused: [paths]`.
 *   MCP: `query_receipts` session rows carry `touchedRefused`, omitted when
 *   no item on the receipt has an `outcome` (absent is not zero).
 *   Since-view: `touchedCount` is distinct paths per session, not a sum.
 *   s3 is a deliberate tripwire: it pins a known wrong number so a fix has
 *   to come and update the limit beside it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  chaptersFromClaudeTranscript,
  chaptersBinding,
  renderChapters
} from '../src/views/chapters.js';
import { sinceReport } from '../src/views/since.js';
import { createStore } from '../src/store/index.js';

// Fixture helpers, copied verbatim from .lane/fixture.mjs (the work order
// forbids importing from .lane: the copy is the durable thing).
const u = (ts, content, extra = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content }, timestamp: ts, ...extra });
const a = (ts, id, name, input) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, timestamp: ts });
const r = (ts, id, isError) => u(ts, [{ type: 'tool_result', tool_use_id: id, content: isError ? 'denied' : 'ok', is_error: isError }]);
const T = s => `2026-11-04T10:00:${String(s).padStart(2, '0')}.000Z`;
const TRANSCRIPT = [
  u(T(0), 'Fix the hook'),
  a(T(1), 'tu1', 'Write', { file_path: '/w/refused.js', content: 'x' }),
  r(T(2), 'tu1', true),
  a(T(3), 'tu2', 'Write', { file_path: '/w/landed.js', content: 'x' }),
  r(T(4), 'tu2', false),
  a(T(5), 'tu3', 'Edit', { file_path: '/w/retry.js', old_string: 'a', new_string: 'b' }),
  r(T(6), 'tu3', true),
  a(T(7), 'tu4', 'Edit', { file_path: '/w/retry.js', old_string: 'a', new_string: 'b' }),
  r(T(8), 'tu4', false),
  u(T(9), 'Second prompt'),
  a(T(10), 'tu5', 'Write', { file_path: '/w/refused.js', content: 'x' }),
  r(T(11), 'tu5', false),
  a(T(12), 'tu6', 'Write', { file_path: '/w/unanswered.js', content: 'x' }),
  a(T(13), 'tu7', 'Write', { file_path: '/w/late.js', content: 'x' }),
  u(T(14), 'Third prompt'),
  r(T(15), 'tu7', true)
].join('\n') + '\n';

const chapters = chaptersFromClaudeTranscript(TRANSCRIPT);

describe('KNOWN-LIMITS 76 narrowing: the chapters view settles attempts per chapter', () => {
  it('c1. chapter 1 lists retry.js as touched but not refused: it failed then landed', () => {
    assert.deepEqual(chapters[0].touched, ['/w/refused.js', '/w/landed.js', '/w/retry.js']);
    assert.deepEqual(chapters[0].refused, ['/w/refused.js'],
      'retry.js failed once then landed in the same chapter; one landed write is a write');
  });

  it('c2. chapter 2: late.js is refused there, refused.js landed there, unanswered.js stays out', () => {
    assert.deepEqual(chapters[1].refused, ['/w/late.js'],
      'the answer to tu7 arrived after chapter 3 opened, but the attempt was chapter 2\'s');
    assert.ok(!chapters[1].refused.includes('/w/refused.js'),
      'refused.js landed in chapter 2 (tu5 answered ok), so it refuses nothing here');
    assert.ok(!chapters[1].refused.includes('/w/unanswered.js'),
      'an attempt with no answer stays out: unanswered is not refused');
  });

  it('c3. chapter 3 has no own refused property', () => {
    assert.ok(!Object.hasOwn(chapters[2], 'refused'),
      '"refused appears only on a chapter that has one"; chapter 3 only received a late answer');
  });

  it('c4. the chapters/1 digest is unchanged by this narrowing', () => {
    // Computed on main (22ae903) before this change, using the same fixture:
    //   sha256(chaptersCanonical(chaptersFromClaudeTranscript(TRANSCRIPT)))
    // It must never move. chapters/1 digests are already on the chain, bound
    // at signing sitting against the pre-refused canonical text, so any change to what
    // chaptersCanonical includes makes every stored binding read DOES NOT
    // match. That is why `refused` is excluded from the canonical form, and
    // why this pins it.
    assert.strictEqual(chaptersBinding(chapters).digest,
      'b8c53cab506db1ac645937ed57744861a46e90894e013f810fa039462fd24e5c');
  });

  it('c5. failures are unchanged: [2, 0, 1]', () => {
    assert.deepEqual(chapters.map(c => c.failures), [2, 0, 1],
      'the settle pass must not change book.fail behaviour');
  });

  it('c6. renderChapters shows "1 refused" for chapter 1 and no refused word where there is none', () => {
    const report = {
      window: { from: 0, to: 0, entryCount: 0 },
      sessions: [{
        runtime: 'claude-code', sessionId: 's', witnessed: false,
        chapters, caveats: []
      }],
      caveats: []
    };
    const out = renderChapters(report);
    const lines = out.split('\n');
    const l1 = lines.find(l => l.trim().startsWith('#1 '));
    const l3 = lines.find(l => l.trim().startsWith('#3 '));
    assert.ok(l1 && l1.includes(', 1 refused,'),
      `chapter 1's line must carry the refused count, got: ${l1}`);
    assert.ok(l3 && !l3.includes('refused'),
      `a chapter without refused must print no refused word, got: ${l3}`);
  });
});

// Point the shared home at an isolated temp dir BEFORE importing the server,
// so the server's singleton store lands there and never touches the real
// ~/.lotor. Same approach as test/mcp.test.js; dynamic import because ESM
// static imports are hoisted above this assignment.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-l76-readers-'));
process.env.LOTOR_HOME = TEST_HOME;

const { handleQueryReceipts } = await import('../src/mcp/server.js');

describe('KNOWN-LIMITS 76 narrowing: query_receipts session rows carry touchedRefused', () => {
  it('m1. two touched items, one outcome error: touchedCount 2, touchedRefused 1', () => {
    const store = createStore(TEST_HOME);
    store.appendReceipt({
      session: { id: 'l76-m1', model: 'test-model' },
      ran: [], failed: [], cost: {},
      counts: { turns: 1, toolCalls: 2, failures: 1 },
      touched: [
        { path: '/a', via: 'write', outcome: 'error' },
        { path: '/b', via: 'write', outcome: 'ok' }
      ]
    });
    const row = handleQueryReceipts({ sessionId: 'l76-m1' }).receipts[0];
    assert.strictEqual(row.touchedCount, 2);
    assert.strictEqual(row.touchedRefused, 1);
  });

  it('m2. all outcomes ok: touchedRefused is present and reads 0', () => {
    const store = createStore(TEST_HOME);
    store.appendReceipt({
      session: { id: 'l76-m2', model: 'test-model' },
      ran: [], failed: [], cost: {},
      counts: { turns: 1, toolCalls: 2, failures: 0 },
      touched: [
        { path: '/a', via: 'write', outcome: 'ok' },
        { path: '/b', via: 'write', outcome: 'ok' }
      ]
    });
    const row = handleQueryReceipts({ sessionId: 'l76-m2' }).receipts[0];
    assert.ok(Object.hasOwn(row, 'touchedRefused'),
      'zero refused is a receipt that said so; only no-outcome receipts omit the key');
    assert.strictEqual(row.touchedRefused, 0);
  });

  it('m3. touched with no outcome key anywhere: no touchedRefused key on the row', () => {
    const store = createStore(TEST_HOME);
    store.appendReceipt({
      session: { id: 'l76-m3', model: 'test-model' },
      ran: [], failed: [], cost: {},
      counts: { turns: 1, toolCalls: 1, failures: 0 },
      touched: [{ path: '/a', via: 'write' }]
    });
    const row = handleQueryReceipts({ sessionId: 'l76-m3' }).receipts[0];
    assert.strictEqual(row.touchedCount, 1);
    assert.ok(!Object.hasOwn(row, 'touchedRefused'),
      'a receipt written before 2026-10-19 records nothing about outcomes; absent is not zero');
  });
});

describe('KNOWN-LIMITS 76 narrowing: the since-view counts touched paths once per session', () => {
  const at = (seq, ts, payload) => ({ seq, timestamp: ts, hash: 'h', payload });

  const receipt = (id, sub, paths) => ({
    session: { id, model: 'test-model', subsession: sub },
    counts: { turns: 1, toolCalls: 1, failures: 0 },
    touched: paths.map(p => ({ path: p, via: 'write', outcome: 'ok' }))
  });

  const open = id => at(0, 1000, { type: 'session-open', sessionId: id, source: 'startup', cwd: '/w' });

  it('s1. two receipts listing the same two paths count 2, not 4', () => {
    const entries = [
      open('l76-s1'),
      at(1, 2000, receipt('l76-s1', 0, ['/a.js', '/b.js'])),
      at(2, 3000, receipt('l76-s1', 1, ['/a.js', '/b.js']))
    ];
    const s = sinceReport(entries).sessions[0];
    assert.strictEqual(s.touchedCount, 2,
      'every subsession receipt repeats the whole transcript\'s touched list; the count is distinct paths');
  });

  it('s2. a second receipt adding one new path counts 3', () => {
    const entries = [
      open('l76-s2'),
      at(1, 2000, receipt('l76-s2', 0, ['/a.js', '/b.js'])),
      at(2, 3000, receipt('l76-s2', 1, ['/a.js', '/b.js', '/c.js']))
    ];
    const s = sinceReport(entries).sessions[0];
    assert.strictEqual(s.touchedCount, 3);
  });

  it('s3. tripwire: turns, toolCalls and failures still sum across cumulative receipts (limit 76, still open)', () => {
    // This asserts a known wrong number ON PURPOSE. Every subsession receipt
    // re-parses the whole transcript (src/ingest), so a session with two
    // SessionEnd firings reports each of these counts about twice over, and
    // the since-view still sums them. Summing is wrong for cumulative
    // receipts; the honest fix needs a decision this change did not make.
    // A fix must come and update this test together with KNOWN-LIMITS 76's
    // "Still open" list; if this test starts failing instead, the number
    // moved and the limit must be revisited, not the test deleted.
    const entries = [
      open('l76-s3'),
      at(1, 2000, {
        session: { id: 'l76-s3', model: 'test-model', subsession: 0 },
        counts: { turns: 5, toolCalls: 4, failures: 1 },
        touched: [{ path: '/a.js', via: 'write', outcome: 'ok' }]
      }),
      at(2, 3000, {
        session: { id: 'l76-s3', model: 'test-model', subsession: 1 },
        counts: { turns: 5, toolCalls: 4, failures: 1 },
        touched: [{ path: '/a.js', via: 'write', outcome: 'ok' }]
      })
    ];
    const s = sinceReport(entries).sessions[0];
    assert.strictEqual(s.turns, 10, 'WRONG ON PURPOSE: 5 turns happened, 10 are reported');
    assert.strictEqual(s.toolCalls, 8, 'WRONG ON PURPOSE: 4 tool calls happened, 8 are reported');
    assert.strictEqual(s.failures, 2, 'WRONG ON PURPOSE: 1 failure happened, 2 are reported');
  });
});