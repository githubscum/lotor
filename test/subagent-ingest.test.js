import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectSubagents, countParentDispatches, summarizeSubagents } from '../src/ingest/subagents.js';

/**
 * subagent transcript ingest (WO-TRACE-BRIDGE-01).
 *
 * These tests pin the found:false / count:0 distinction: a missing sidecar
 * directory is null/omitted, a present-but-empty one is a real zero. They
 * also pin defensive summing — missing or non-finite usage sub-fields
 * contribute 0 and never propagate NaN into a receipt total — and the
 * parent-dispatch cross-check (WO-LIMIT68-FALSE-ZERO): a parent whose
 * Task/Agent calls went through must never collapse into a silent null when
 * its sidecar dir is missing, a dispatch that was denied, rejected or
 * interrupted must not count (it ran no child, so sidecarMissing would be a
 * false statement), and unmatched sidecar entries must be captured by name
 * rather than dropped behind a count.
 */

let tmp;

function line(obj) { return JSON.stringify(obj); }

function writeJsonl(filePath, objs) {
  fs.writeFileSync(filePath, objs.map(line).join('\n') + '\n', 'utf-8');
}

function subagentsDir(transcriptPath) {
  return path.join(
    path.dirname(transcriptPath),
    path.basename(transcriptPath, '.jsonl'),
    'subagents'
  );
}

function assistantRow(over = {}) {
  return {
    timestamp: '2026-09-03T11:00:00Z',
    sessionId: 'parent-1',
    agentId: 'a',
    isSidechain: true,
    cwd: '/repo',
    gitBranch: 'main',
    requestId: 'req-1',
    sourceToolAssistantUUID: 'parent-tool-uuid',
    message: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 200
      }
    },
    ...over
  };
}

/** A parent-side assistant row that dispatches a subagent via `toolName`. */
function dispatchRow(toolName, over = {}, id = 'tu-1') {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id, name: toolName, input: {} }
      ]
    },
    ...over
  };
}

/**
 * The parent-side user row that answers tool_use `id`. `isError: true` is the
 * shape a hook denial, an operator rejection or an interrupt leaves.
 */
function resultRow(id, { isError = false, text = 'child finished' } = {}) {
  const item = { type: 'tool_result', tool_use_id: id, content: text };
  if (isError) item.is_error = true;
  return { type: 'user', message: { role: 'user', content: [item] } };
}

describe('ingest: subagent sidecar transcripts', () => {
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-subagent-ingest-'));
  });

  after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  });

  it('no subagents directory -> found:false and summarizeSubagents is null', () => {
    const transcriptPath = path.join(tmp, 'none.jsonl');
    // Deliberately do not create the subagents directory.
    const collected = collectSubagents(transcriptPath);
    assert.strictEqual(collected.found, false);
    assert.deepStrictEqual(collected.children, []);
    assert.strictEqual(summarizeSubagents(transcriptPath), null);
  });

  it('empty subagents directory -> found:true, children:[], summarize count 0 (NOT null)', () => {
    const transcriptPath = path.join(tmp, 'empty.jsonl');
    fs.mkdirSync(subagentsDir(transcriptPath), { recursive: true });

    const collected = collectSubagents(transcriptPath);
    assert.strictEqual(collected.found, true);
    assert.deepStrictEqual(collected.children, []);

    const summary = summarizeSubagents(transcriptPath);
    assert.ok(summary !== null, 'empty dir must summarize to an object, not null');
    assert.strictEqual(summary.count, 0);
    assert.strictEqual(summary.schema, 'subagents/1');
    assert.deepStrictEqual(summary.totals, {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      assistantTurns: 0
    });
    assert.deepStrictEqual(summary.children, []);
    assert.deepStrictEqual(summary.unreadable, []);
  });

  it('three children, two assistant rows each -> count 3, exact sums, sorted by agentId', () => {
    const transcriptPath = path.join(tmp, 'three.jsonl');
    const dir = subagentsDir(transcriptPath);
    fs.mkdirSync(dir, { recursive: true });

    // Write out of filename order (c, a, b) to prove determinism via sort.
    const defs = [
      {
        agentId: 'a',
        rows: [
          assistantRow({ agentId: 'a', requestId: 'a-1', timestamp: '2026-09-03T11:00:00Z', message: { model: 'claude-opus-5', usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 200 } } }),
          assistantRow({ agentId: 'a', requestId: 'a-2', timestamp: '2026-09-03T11:01:00Z', message: { model: 'claude-opus-5', usage: { input_tokens: 30, output_tokens: 70, cache_creation_input_tokens: 0, cache_read_input_tokens: 40 } } })
        ]
      },
      {
        agentId: 'b',
        rows: [
          assistantRow({ agentId: 'b', requestId: 'b-1', timestamp: '2026-09-03T11:05:00Z', message: { model: 'claude-sonnet-5', usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 } } }),
          assistantRow({ agentId: 'b', requestId: 'b-2', timestamp: '2026-09-03T11:06:00Z', message: { model: 'claude-sonnet-5', usage: { input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 } } })
        ]
      },
      {
        agentId: 'c',
        rows: [
          assistantRow({ agentId: 'c', requestId: 'c-1', timestamp: '2026-09-03T11:10:00Z', message: { model: 'claude-opus-5', usage: { input_tokens: 1000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
          assistantRow({ agentId: 'c', requestId: 'c-2', timestamp: '2026-09-03T11:11:00Z', message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
        ]
      }
    ];
    for (const d of defs) {
      writeJsonl(path.join(dir, `agent-${d.agentId}.jsonl`), d.rows);
    }
    // Also write a non-matching file to confirm it is ignored.
    fs.writeFileSync(path.join(dir, 'README.txt'), 'ignore me', 'utf-8');

    const summary = summarizeSubagents(transcriptPath);
    assert.strictEqual(summary.count, 3);
    assert.deepStrictEqual(summary.children.map(c => c.agentId), ['a', 'b', 'c']);

    const byId = Object.fromEntries(summary.children.map(c => [c.agentId, c]));

    // Per-child exact sums.
    assert.deepStrictEqual(byId.a.usage, { inputTokens: 130, outputTokens: 120, cacheCreationInputTokens: 10, cacheReadInputTokens: 240 });
    assert.deepStrictEqual(byId.b.usage, { inputTokens: 10, outputTokens: 10, cacheCreationInputTokens: 2, cacheReadInputTokens: 4 });
    assert.deepStrictEqual(byId.c.usage, { inputTokens: 1001, outputTokens: 1001, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });

    // assistantTurns: two per child.
    assert.strictEqual(byId.a.assistantTurns, 2);
    assert.strictEqual(byId.b.assistantTurns, 2);
    assert.strictEqual(byId.c.assistantTurns, 2);

    // Totals equal the sum of the three children.
    assert.deepStrictEqual(summary.totals, {
      inputTokens: 130 + 10 + 1001,
      outputTokens: 120 + 10 + 1001,
      cacheCreationInputTokens: 10 + 2 + 0,
      cacheReadInputTokens: 240 + 4 + 0,
      assistantTurns: 6
    });

    // Distinct models, sorted; child a saw only claude-opus-5.
    assert.deepStrictEqual(byId.a.models, ['claude-opus-5']);
    assert.deepStrictEqual(byId.b.models, ['claude-sonnet-5']);
  });

  it('malformed lines are counted, valid rows still summed', () => {
    const transcriptPath = path.join(tmp, 'malformed.jsonl');
    const dir = subagentsDir(transcriptPath);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'agent-x.jsonl');
    const valid = assistantRow({ agentId: 'x', requestId: 'x-1', message: { model: 'claude-opus-5', usage: { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    const content = line(valid) + '\n' + 'this is not json\n' + '{ "broken":\n' + line(valid) + '\n';
    fs.writeFileSync(file, content, 'utf-8');

    const collected = collectSubagents(transcriptPath);
    assert.strictEqual(collected.found, true);
    assert.strictEqual(collected.children.length, 1);
    const child = collected.children[0];
    assert.strictEqual(child.agentId, 'x');
    assert.strictEqual(child.rows, 2);
    assert.strictEqual(child.malformedRows, 2);
    assert.deepStrictEqual(child.usage, { inputTokens: 14, outputTokens: 6, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
    assert.strictEqual(child.assistantTurns, 2);
  });

  it('missing usage sub-fields and non-finite values -> 0, no NaN anywhere', () => {
    const transcriptPath = path.join(tmp, 'partial.jsonl');
    const dir = subagentsDir(transcriptPath);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'agent-p.jsonl');
    const rows = [
      // No cache fields at all; a non-finite input_tokens string.
      { timestamp: '2026-09-03T11:00:00Z', agentId: 'p', isSidechain: true, requestId: 'p-1', message: { model: 'claude-opus-5', usage: { input_tokens: 'lots', output_tokens: 5 } } },
      // output_tokens missing; cache_read a non-finite number.
      { timestamp: '2026-09-03T11:01:00Z', agentId: 'p', isSidechain: true, requestId: 'p-2', message: { model: 'claude-opus-5', usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: NaN } } }
    ];
    writeJsonl(file, rows);

    const summary = summarizeSubagents(transcriptPath);
    const child = summary.children[0];
    assert.deepStrictEqual(child.usage, { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 2, cacheReadInputTokens: 0 });
    // Every total and per-child usage value must be finite.
    for (const v of Object.values(child.usage)) {
      assert.strictEqual(Number.isFinite(v), true);
    }
    for (const v of Object.values(summary.totals)) {
      assert.strictEqual(Number.isFinite(v), true);
    }
  });

  it('rows with no agentId -> agentId recovered from the filename', () => {
    const transcriptPath = path.join(tmp, 'noid.jsonl');
    const dir = subagentsDir(transcriptPath);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'agent-recovered.jsonl');
    // Rows deliberately omit agentId.
    const rows = [
      { timestamp: '2026-09-03T11:00:00Z', sessionId: 'parent-9', isSidechain: true, requestId: 'r-1', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 1, output_tokens: 1 } } }
    ];
    writeJsonl(file, rows);

    const collected = collectSubagents(transcriptPath);
    assert.strictEqual(collected.children.length, 1);
    const child = collected.children[0];
    assert.strictEqual(child.agentId, 'recovered');
    assert.strictEqual(child.parentSessionId, 'parent-9');
    assert.strictEqual(child.model, 'claude-haiku-4-5');
    assert.deepStrictEqual(child.models, ['claude-haiku-4-5']);
  });

  it('priceTableDate is passed through when given, absent when not', () => {
    const transcriptPath = path.join(tmp, 'price.jsonl');
    const dir = subagentsDir(transcriptPath);
    fs.mkdirSync(dir, { recursive: true });
    writeJsonl(path.join(dir, 'agent-q.jsonl'), [
      assistantRow({ agentId: 'q', requestId: 'q-1', message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } } })
    ]);

    const without = summarizeSubagents(transcriptPath);
    assert.ok(!('priceTableDate' in without), 'priceTableDate must be absent when not supplied');

    const withDate = summarizeSubagents(transcriptPath, { priceTableDate: '2026-09-01' });
    assert.strictEqual(withDate.priceTableDate, '2026-09-01');

    const withEmpty = summarizeSubagents(transcriptPath, { priceTableDate: '' });
    assert.ok(!('priceTableDate' in withEmpty), 'an empty priceTableDate must not be included');
  });

  it('parent dispatched 2 Task calls, no dir -> sidecarMissing summary, not null', () => {
    const transcriptPath = path.join(tmp, 'dispatched-missing.jsonl');
    writeJsonl(transcriptPath, [
      dispatchRow('Task', { sessionId: 'parent-d' }, 'tu-d1'),
      resultRow('tu-d1'),
      dispatchRow('Task', { sessionId: 'parent-d' }, 'tu-d2'),
      resultRow('tu-d2')
    ]);
    // Deliberately do not create the subagents directory.

    const summary = summarizeSubagents(transcriptPath);
    assert.ok(summary !== null, 'parent dispatches with a missing sidecar dir must not be a silent null');
    assert.strictEqual(summary.schema, 'subagents/1');
    assert.strictEqual(summary.count, null);
    assert.strictEqual(summary.derived, true);
    assert.strictEqual(summary.source, 'transcript-sidecar');
    assert.strictEqual(summary.sidecarMissing, true);
    assert.strictEqual(summary.parentDispatches, 2);
    assert.strictEqual(summary.dir, subagentsDir(transcriptPath));
  });

  it('parent dispatched 0, no dir -> null (unchanged behavior)', () => {
    const transcriptPath = path.join(tmp, 'nodispatch-missing.jsonl');
    // A parent row with no tool_use at all still proves the file is read.
    writeJsonl(transcriptPath, [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'plain reply' }] } }
    ]);

    const collected = collectSubagents(transcriptPath);
    assert.strictEqual(collected.found, false);
    assert.strictEqual(countParentDispatches(transcriptPath), 0);
    assert.strictEqual(summarizeSubagents(transcriptPath), null);
  });

  it('dir holds agent-x.jsonl plus child-y.jsonl (renamed layout) -> unmatchedEntries captured', () => {
    const transcriptPath = path.join(tmp, 'renamed-layout.jsonl');
    const dir = subagentsDir(transcriptPath);
    fs.mkdirSync(dir, { recursive: true });
    writeJsonl(path.join(dir, 'agent-x.jsonl'), [
      assistantRow({ agentId: 'x', requestId: 'x-1', message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
    ]);
    // A child under the renamed pattern: read as data, never counted as a child.
    fs.writeFileSync(
      path.join(dir, 'child-y.jsonl'),
      line(assistantRow({ agentId: 'y', requestId: 'y-1' })) + '\n',
      'utf-8'
    );

    const summary = summarizeSubagents(transcriptPath);
    assert.strictEqual(summary.count, 1);
    assert.deepStrictEqual(summary.unmatchedEntries, ['child-y.jsonl']);
    // The parent transcript does not exist here, so parentDispatches must be
    // omitted rather than guessed at.
    assert.ok(!('parentDispatches' in summary), 'parentDispatches must be omitted when the parent file was unreadable');
  });

  it("parent uses tool name 'Agent' -> counted", () => {
    const transcriptPath = path.join(tmp, 'agent-named.jsonl');
    writeJsonl(transcriptPath, [dispatchRow('Agent'), resultRow('tu-1')]);

    assert.strictEqual(countParentDispatches(transcriptPath), 1);

    // 1 dispatch and no sidecar dir -> the sidecarMissing summary carries it.
    const summary = summarizeSubagents(transcriptPath);
    assert.strictEqual(summary.sidecarMissing, true);
    assert.strictEqual(summary.parentDispatches, 1);
  });

  it('malformed parent lines are skipped; valid dispatch rows still counted', () => {
    const transcriptPath = path.join(tmp, 'parent-malformed.jsonl');
    const content = line(dispatchRow('Task', {}, 'tu-m1')) + '\n' + 'this is not json\n' + '{ "broken":\n' +
      line(dispatchRow('Agent', {}, 'tu-m2')) + '\n' + line(resultRow('tu-m1')) + '\n' + line(resultRow('tu-m2')) + '\n';
    fs.writeFileSync(transcriptPath, content, 'utf-8');

    assert.strictEqual(countParentDispatches(transcriptPath), 2);
  });

  it('a dispatch a hook denied is not counted; no dir -> null, not sidecarMissing', () => {
    const transcriptPath = path.join(tmp, 'denied-dispatch.jsonl');
    writeJsonl(transcriptPath, [
      dispatchRow('Agent', {}, 'tu-denied'),
      resultRow('tu-denied', { isError: true, text: 'PreToolUse:Agent hook error: BLOCKED' })
    ]);

    assert.strictEqual(countParentDispatches(transcriptPath), 0);
    assert.strictEqual(summarizeSubagents(transcriptPath), null,
      'a denied dispatch ran no child; claiming the sidecar is missing would be false');
  });

  it('rejected (error result) and interrupted (no result) dispatches are not counted', () => {
    const transcriptPath = path.join(tmp, 'rejected-interrupted.jsonl');
    writeJsonl(transcriptPath, [
      dispatchRow('Task', {}, 'tu-rejected'),
      resultRow('tu-rejected', { isError: true, text: "The user doesn't want to proceed with this tool use." }),
      dispatchRow('Task', {}, 'tu-interrupted')
      // No result row for tu-interrupted: cut off before it answered.
    ]);

    assert.strictEqual(countParentDispatches(transcriptPath), 0);
    assert.strictEqual(summarizeSubagents(transcriptPath), null);
  });

  it('one dispatch through and one denied -> parentDispatches 1', () => {
    const transcriptPath = path.join(tmp, 'mixed-dispatch.jsonl');
    writeJsonl(transcriptPath, [
      dispatchRow('Agent', {}, 'tu-ok'),
      resultRow('tu-ok'),
      dispatchRow('Agent', {}, 'tu-no'),
      resultRow('tu-no', { isError: true, text: 'PreToolUse:Agent hook error: BLOCKED' })
    ]);

    const summary = summarizeSubagents(transcriptPath);
    assert.strictEqual(summary.sidecarMissing, true);
    assert.strictEqual(summary.parentDispatches, 1);
  });

  it('a repeated row for the same tool_use id counts once', () => {
    const transcriptPath = path.join(tmp, 'repeated-dispatch.jsonl');
    writeJsonl(transcriptPath, [
      dispatchRow('Task', {}, 'tu-r'),
      dispatchRow('Task', {}, 'tu-r'),
      resultRow('tu-r')
    ]);

    assert.strictEqual(countParentDispatches(transcriptPath), 1);
  });

  it('transcriptText is used in place of reading the parent file', () => {
    // The path does not exist; only the supplied text can produce a count.
    const transcriptPath = path.join(tmp, 'text-only-never-written.jsonl');
    const text = [dispatchRow('Task', {}, 'tu-t'), resultRow('tu-t')].map(line).join('\n') + '\n';

    assert.strictEqual(countParentDispatches(transcriptPath), null);
    assert.strictEqual(countParentDispatches(transcriptPath, { text }), 1);
    const summary = summarizeSubagents(transcriptPath, { transcriptText: text });
    assert.strictEqual(summary.sidecarMissing, true);
    assert.strictEqual(summary.parentDispatches, 1);
  });
});