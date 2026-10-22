/**
 * KNOWN-LIMITS 76: `touched` counted attempts, so a refused write read as a change.
 *
 * WHAT WAS WRONG
 *   `parseSession` added a path to `touched` when it saw the Edit/Write
 *   tool_use, before and regardless of the tool_result that answered it. On
 *   2026-10-19 a gate denial at seq 36203 refused a session's write to one of
 *   its own hook files, and the session's receipt (seq 36204) listed that file
 *   under `touched` anyway. The file was unchanged on disk; the chain read it
 *   as written.
 *
 * THE RULE BEING TESTED
 *   A touched entry from an Edit/Write attempt carries `outcome`, and the
 *   outcome comes from the transcript's own answer, not from intent:
 *     'ok'      a tool_result arrived with no is_error (absent = success)
 *     'error'   the tool_result arrived with is_error: true
 *     'unknown' no tool_result ever arrived (e.g. the session died mid-turn)
 *   'ok' is sticky: one landed write is a write, whatever later attempts to
 *   the same path did. Entries added by file-history carry NO outcome key, so
 *   old readers see exactly what they saw before. `failed` still records the
 *   error digest; this adds the join, it does not move the record.
 *
 * The a-f cases hold parser behaviour. The g cases hold the since-view:
 * a refused path renders "(refused)", the work line counts them, and a legacy
 * receipt with no outcome renders exactly as today.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseSession } from '../src/parser/index.js';
import { sinceReport, renderSince } from '../src/views/since.js';
import { renderSessionReceipt } from '../src/views/index.js';
import { liveReport, renderLive } from '../src/views/live.js';
import { createStore } from '../src/store/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** One assistant turn carrying a single tool_use, then optionally its result. */
function turnUse(name, id, input) {
  return JSON.stringify({
    message: {
      role: 'assistant',
      model: 'test-model-v1',
      content: [{ type: 'tool_use', name, id, input }]
    }
  });
}

/** One user turn carrying a single tool_result. is_error absent on success. */
function turnResult(id, isError) {
  return JSON.stringify({
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: id,
        ...(isError ? { is_error: true, content: 'gate denial: rule self-mod' } : { content: 'The file has been updated.' })
      }]
    }
  });
}

/** A file-history record for one path, the parser's other touch source. */
function fileHistory(pathStr) {
  return JSON.stringify({
    type: 'file-history-delta',
    trackingPath: pathStr
  });
}

const touchFor = (result, pathStr) =>
  result.touched.find(t => t.path === pathStr);

describe('KNOWN-LIMITS 76: touched counts attempts, outcome comes from tool_result', () => {
  it('a. an Edit answered by success reads outcome ok', () => {
    const jsonl = [
      turnUse('Edit', 'edit-76a', { file_path: '/w/src/app.js', old_string: 'a', new_string: 'b' }),
      turnResult('edit-76a', false)
    ].join('\n');

    const t = touchFor(parseSession(jsonl), '/w/src/app.js');
    assert.ok(t, 'the Edit file is in touched');
    assert.strictEqual(t.via, 'edit', 'via is unchanged by this fix');
    assert.strictEqual(t.outcome, 'ok');
  });

  it('b. a Write answered by is_error:true stays in touched but reads outcome error', () => {
    // The live defect: the gate refuses the write, the harness returns an
    // error, and the path must still be listed (an attempt happened) but as
    // an attempt the harness refused, not as a change.
    const jsonl = [
      turnUse('Write', 'write-76b', { file_path: '/w/bin/hook-pre-tool-use.js', content: 'new body' }),
      turnResult('write-76b', true)
    ].join('\n');

    const result = parseSession(jsonl);
    const t = touchFor(result, '/w/bin/hook-pre-tool-use.js');
    assert.ok(t, 'the attempted path is still reported: refusal is evidence too');
    assert.strictEqual(t.outcome, 'error',
      'before the fix this entry carried no outcome and read as a plain write');
    // The failure record is untouched: the error digest still lands there.
    assert.strictEqual(result.failed.length, 1);
    assert.strictEqual(result.failed[0].id, 'write-76b');
  });

  it('c. same path refused then landed reads ok, and landed then refused still reads ok', () => {
    const erroredThenOk = [
      turnUse('Edit', 'edit-76c1', { file_path: '/w/shared.js' }),
      turnResult('edit-76c1', true),
      turnUse('Edit', 'edit-76c2', { file_path: '/w/shared.js' }),
      turnResult('edit-76c2', false)
    ].join('\n');
    assert.strictEqual(touchFor(parseSession(erroredThenOk), '/w/shared.js').outcome, 'ok',
      'a later landed write settles the path as ok');

    const okThenErrored = [
      turnUse('Edit', 'edit-76c3', { file_path: '/w/other.js' }),
      turnResult('edit-76c3', false),
      turnUse('Edit', 'edit-76c4', { file_path: '/w/other.js' }),
      turnResult('edit-76c4', true)
    ].join('\n');
    assert.strictEqual(touchFor(parseSession(okThenErrored), '/w/other.js').outcome, 'ok',
      'ok is sticky: one landed write is a write, whatever later attempts did');
  });

  it('d. an Edit with no tool_result reads outcome unknown', () => {
    const jsonl = turnUse('Edit', 'edit-76d', { file_path: '/w/died.js' });

    const t = touchFor(parseSession(jsonl), '/w/died.js');
    assert.ok(t);
    assert.strictEqual(t.outcome, 'unknown',
      'no answer is not a refusal and not a landing; it is an unanswered attempt');
  });

  it('CONTROL e. a file-history-only path carries no outcome key at all', () => {
    const jsonl = fileHistory('/w/only-in-history.js');

    const t = touchFor(parseSession(jsonl), '/w/only-in-history.js');
    assert.ok(t);
    assert.strictEqual(t.via, 'file-history');
    assert.ok(!('outcome' in t),
      'file-history touches are not attempts; inventing an outcome for them would be a lie on the wire');
  });

  it('CONTROL f. a Read does not enter touched, as before', () => {
    const jsonl = [
      turnUse('Read', 'read-76f', { file_path: '/w/read-only.js' }),
      turnResult('read-76f', false)
    ].join('\n');

    assert.strictEqual(touchFor(parseSession(jsonl), '/w/read-only.js'), undefined);
  });
});

describe('KNOWN-LIMITS 76: the since-view separates a landed write from a refused attempt', () => {
  const at = (seq, ts, payload) => ({ seq, timestamp: ts, hash: 'h', payload });

  /** A chain: one session-open plus one session receipt, in the raw payload shape. */
  function chain(receipt) {
    return [
      at(1, 1000, { type: 'session-open', sessionId: receipt.session.id, source: 'startup', cwd: '/w' }),
      at(2, 2000, receipt)
    ];
  }

  const refusedReceipt = {
    session: { id: 'sess-76-refused', model: 'test-model' },
    counts: { turns: 3, toolCalls: 3, failures: 1 },
    touched: [
      { path: '/w/bin/hook-pre-tool-use.js', via: 'write', outcome: 'error' },
      { path: '/w/src/views/since.js', via: 'edit', outcome: 'ok' }
    ]
  };

  it('g1. a refused path renders with "(refused)" and the work line counts it', () => {
    const report = sinceReport(chain(refusedReceipt));
    const s = report.sessions[0];
    assert.strictEqual(s.touchedRefused, 1, 'one of the two touched items is an error');
    assert.deepEqual(s.refusedPaths, ['/w/bin/hook-pre-tool-use.js']);

    const out = renderSince(report);
    assert.ok(out.includes('/w/bin/hook-pre-tool-use.js (refused)'),
      'the reader must see the refusal on the path itself, not dig for it in counts');
    assert.ok(out.includes('/w/src/views/since.js\n') && !out.includes('/w/src/views/since.js (refused)'),
      'an ok path must not be dressed as refused');
    const workLine = out.split('\n').find(l => l.startsWith('    work        '));
    assert.ok(workLine, 'the rollup line renders');
    assert.ok(workLine.includes('files touched (1 refused)'), `work line: ${workLine}`);
    assert.ok(out.includes('recorded an attempt at'),
      'the new caveat line ships with the field');
  });

  it('g2. a legacy receipt with no outcome renders exactly as today', () => {
    const legacy = {
      session: { id: 'sess-76-legacy', model: 'test-model' },
      counts: { turns: 1, toolCalls: 1, failures: 0 },
      touched: [{ path: '/w/old.js', via: 'write' }]
    };

    const report = sinceReport(chain(legacy));
    const s = report.sessions[0];
    assert.strictEqual(s.touchedRefused, 0, 'a receipt without outcome refused nothing it can show');
    const out = renderSince(report);
    assert.ok(!out.includes('(refused)'), 'no refusal language on a legacy receipt');
    assert.ok(out.includes('1 files touched'), 'the work line is unchanged when M is 0');
    assert.ok(out.includes('    touched     /w/old.js\n'), 'the path renders bare, no suffix');
  });

  it('g3. a session with no receipt yet reports touchedRefused null, not zero', () => {
    const entries = [
      at(1, 1000, { type: 'session-open', sessionId: 'sess-76-noreceipt', source: 'startup' })
    ];
    const report = sinceReport(entries, { includeQuiet: true });
    const s = report.sessions[0];
    assert.strictEqual(s.touchedCount, null, 'unchanged: no receipt, no counts');
    assert.strictEqual(s.touchedRefused, null,
      'null means nothing was written about this; zero would mean a receipt said 0');
    assert.ok(!renderSince(report).includes('(refused)'));
  });

  it('g4. a later receipt landing the path un-refuses it', () => {
    const receipt1 = {
      session: { id: 'sess-76-landed', model: 'test-model' },
      counts: { turns: 1, toolCalls: 1, failures: 1 },
      touched: [{ path: '/w/a.js', via: 'write', outcome: 'error' }]
    };
    const receipt2 = {
      session: { id: 'sess-76-landed', model: 'test-model' },
      counts: { turns: 2, toolCalls: 2, failures: 0 },
      touched: [{ path: '/w/a.js', via: 'write', outcome: 'ok' }]
    };
    const entries = [
      at(1, 1000, { type: 'session-open', sessionId: 'sess-76-landed', source: 'startup', cwd: '/w' }),
      at(2, 2000, receipt1),
      at(3, 3000, receipt2)
    ];

    const report = sinceReport(entries);
    const s = report.sessions[0];
    assert.deepEqual(s.refusedPaths, [],
      'one landed write is a write: the refusal is withdrawn');
    assert.strictEqual(s.touchedRefused, 0, 'the count follows the withdrawn refusal');
    const out = renderSince(report);
    assert.ok(!out.includes('a.js (refused)'), 'the reader must not see a landed write as refused');
    assert.ok(out.includes('    touched     /w/a.js\n'), 'the path renders bare, no suffix');
  });
});

describe('KNOWN-LIMITS 76 review fixes: per-session refused count, canonical join, other readers', () => {
  const at = (seq, ts, payload) => ({ seq, timestamp: ts, hash: 'h', payload });

  it('g5. one refused write across three subsession receipts counts as 1 refused, not 3', () => {
    // Every SessionEnd re-parses the whole transcript (src/ingest), so each
    // subsession receipt repeats the same refused path.
    const receipt = sub => ({
      session: { id: 'sess-76-subs', model: 'test-model', subsession: sub },
      counts: { turns: 1 + sub, toolCalls: 1 + sub, failures: 1 },
      touched: [
        { path: '/w/bin/hook-pre-tool-use.js', via: 'write', outcome: 'error' },
        { path: '/w/src/ok.js', via: 'edit', outcome: 'ok' }
      ]
    });
    const entries = [
      at(1, 1000, { type: 'session-open', sessionId: 'sess-76-subs', source: 'startup', cwd: '/w' }),
      at(2, 2000, receipt(0)),
      at(3, 3000, receipt(1)),
      at(4, 4000, receipt(2))
    ];
    const report = sinceReport(entries);
    assert.strictEqual(report.sessions[0].touchedRefused, 1, 'distinct refused paths, not a per-receipt sum');
    const workLine = renderSince(report).split('\n').find(l => l.startsWith('    work        '));
    assert.ok(workLine.includes('(1 refused)'), `work line: ${workLine}`);
    assert.ok(!workLine.includes('(3 refused)'));
  });

  it('g6. a refusal landed in a later receipt leaves touchedRefused at 0', () => {
    const r = (sub, outcome) => ({
      session: { id: 'sess-76-relanded', model: 'test-model', subsession: sub },
      counts: { turns: 1, toolCalls: 1, failures: 0 },
      touched: [{ path: '/w/a.js', via: 'write', outcome }]
    });
    const entries = [
      at(1, 1000, { type: 'session-open', sessionId: 'sess-76-relanded', source: 'startup', cwd: '/w' }),
      at(2, 2000, r(0, 'error')),
      at(3, 3000, r(1, 'ok'))
    ];
    const report = sinceReport(entries);
    assert.strictEqual(report.sessions[0].touchedRefused, 0);
    assert.ok(!renderSince(report).includes('refused)'));
  });

  it('h1. Edit absolute + file-history relative + refused result: one entry, outcome error (canonical key join)', () => {
    const jsonl = [
      JSON.stringify({ cwd: '/w', type: 'user', message: { role: 'user', content: 'go' } }),
      turnUse('Write', 'write-76h1', { file_path: '/w/bin/hook.js', content: 'x' }),
      fileHistory('bin/hook.js'),
      turnResult('write-76h1', true)
    ].join('\n');
    const result = parseSession(jsonl);
    assert.strictEqual(result.touched.length, 1, 'limit 75 identity still holds with outcome');
    assert.strictEqual(result.touched[0].path, '/w/bin/hook.js');
    assert.strictEqual(result.touched[0].via, 'write');
    assert.deepEqual(result.touched[0].alsoVia, ['file-history']);
    assert.strictEqual(result.touched[0].outcome, 'error');
  });

  it('h2. file-history first, then a landed Edit through a non-normalised path: outcome ok on the merged entry', () => {
    const jsonl = [
      JSON.stringify({ cwd: '/w', type: 'user', message: { role: 'user', content: 'go' } }),
      fileHistory('src/a.js'),
      turnUse('Edit', 'edit-76h2', { file_path: '/w/lib/../src/a.js' }),
      turnResult('edit-76h2', false)
    ].join('\n');
    const result = parseSession(jsonl);
    assert.strictEqual(result.touched.length, 1);
    assert.strictEqual(result.touched[0].via, 'edit');
    assert.strictEqual(result.touched[0].outcome, 'ok');
  });

  it('i. the text receipt marks a refused path and leaves a landed or legacy one bare', () => {
    const out = renderSessionReceipt({
      session: { id: 'sess-76-text', model: 'test-model' },
      ran: [], failed: [], cost: {}, sent: { items: [] }, counts: {},
      touched: [
        { path: '/w/bin/hook.js', via: 'write', outcome: 'error' },
        { path: '/w/src/ok.js', via: 'edit', outcome: 'ok' },
        { path: '/w/old.js', via: 'write' }
      ]
    });
    assert.ok(out.includes('/w/bin/hook.js (via: write, refused)'));
    assert.ok(out.includes('/w/src/ok.js (via: edit)\n'));
    assert.ok(out.includes('/w/old.js (via: write)\n'));
  });

  it('j. the live view counts and marks a refused write', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-76-live-'));
    try {
      const transcript = path.join(home, 'sess-76-live.jsonl');
      fs.writeFileSync(transcript, [
        JSON.stringify({ cwd: '/w', type: 'user', message: { role: 'user', content: 'go' } }),
        turnUse('Write', 'write-76j1', { file_path: '/w/bin/hook.js', content: 'x' }),
        turnResult('write-76j1', true),
        turnUse('Edit', 'edit-76j2', { file_path: '/w/src/ok.js' }),
        turnResult('edit-76j2', false)
      ].join('\n') + '\n');
      createStore(home).appendReceipt({
        type: 'session-open', sessionId: 'sess-76-live', source: 'startup', cwd: '/w',
        transcriptPath: transcript
      });

      const r = liveReport(home);
      const s = r.sessions.find(x => x.sessionId === 'sess-76-live');
      assert.ok(s, 'the in-flight session is reported');
      assert.deepEqual(s.refusedPaths, ['/w/bin/hook.js']);
      const out = renderLive(r);
      assert.ok(out.includes('2 files (1 refused)'), out);
      assert.ok(out.includes('/w/bin/hook.js (refused)'));
      assert.ok(!out.includes('/w/src/ok.js (refused)'));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});