import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseSession } from '../src/parser/index.js';

/**
 * Thought-level cost rows (2026-08-29).
 *
 * A "thought" is one distinct assistant message — the unit the API bills.
 * The session-total cost fields answer "what did this session cost"; they
 * cannot answer "where in the session did the cost go", which is the
 * question the operator actually asks when a session runs hot. The Drive
 * bridge proved the extraction on live transcripts; this ports it into the
 * parser so the witnessed record carries the same granularity.
 *
 * cost.thoughts: one row per distinct assistant message, dedup-aligned
 * with the existing usage dedup (a message split across N transcript lines
 * is ONE thought). Fields: id, ts, model, input, output, cacheRead,
 * cacheCreate. No content, no digests of content — usage numbers only.
 */

function line(obj) { return JSON.stringify(obj); }

function buildJsonl() {
  const usageA = {
    input_tokens: 3,
    output_tokens: 40,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 200
  };
  const usageB = {
    input_tokens: 5,
    output_tokens: 70,
    cache_read_input_tokens: 1300,
    cache_creation_input_tokens: 100
  };
  return [
    line({ sessionId: 'thoughts-test', version: '2.1.999', type: 'session-start', createdAt: '2026-08-29T10:00:00Z' }),
    // Message A, split across two lines (same id, byte-identical usage):
    // must produce exactly ONE thought row.
    line({
      timestamp: '2026-08-29T10:00:01Z',
      message: { id: 'msg_A', role: 'assistant', model: 'test-model-v1',
        content: [{ type: 'text', text: 'hi' }], usage: usageA }
    }),
    line({
      timestamp: '2026-08-29T10:00:02Z',
      message: { id: 'msg_A', role: 'assistant', model: 'test-model-v1',
        content: [{ type: 'tool_use', name: 'Read', id: 'tu_1', input: { file_path: 'x' } }],
        usage: usageA }
    }),
    // Message B: a second thought on a different model id.
    line({
      timestamp: '2026-08-29T10:00:09Z',
      message: { id: 'msg_B', role: 'assistant', model: 'test-model-v2',
        content: [{ type: 'text', text: 'done' }], usage: usageB }
    })
  ].join('\n');
}

describe('parser: thought-level cost rows', () => {
  it('emits one row per distinct assistant message, dedup-aligned', () => {
    const summary = parseSession(buildJsonl());
    const rows = summary.cost.thoughts;
    assert.ok(Array.isArray(rows), 'cost.thoughts must be an array');
    assert.strictEqual(rows.length, 2, 'split message is one thought');

    const [a, b] = rows;
    assert.strictEqual(a.id, 'msg_A');
    assert.strictEqual(a.model, 'test-model-v1');
    assert.strictEqual(a.ts, '2026-08-29T10:00:01Z');
    assert.strictEqual(a.input, 3);
    assert.strictEqual(a.output, 40);
    assert.strictEqual(a.cacheRead, 1000);
    assert.strictEqual(a.cacheCreate, 200);

    assert.strictEqual(b.id, 'msg_B');
    assert.strictEqual(b.model, 'test-model-v2');
    assert.strictEqual(b.input, 5);
  });

  it('rows sum to the session totals the dedup already produces', () => {
    const summary = parseSession(buildJsonl());
    const rows = summary.cost.thoughts;
    const sum = k => rows.reduce((t, r) => t + r[k], 0);
    assert.strictEqual(sum('input'), summary.cost.inputTokens);
    assert.strictEqual(sum('output'), summary.cost.outputTokens);
    assert.strictEqual(sum('cacheRead'), summary.cost.cacheReadTokens);
    assert.strictEqual(sum('cacheCreate'), summary.cost.cacheCreationTokens);
  });

  it('bumps the cost schema: the sub-object changed shape', () => {
    const summary = parseSession(buildJsonl());
    assert.strictEqual(summary.cost.schema, 'cost/4');
  });

  it('a session with no assistant messages has an empty thoughts array', () => {
    const jsonl = line({ sessionId: 'empty-test', type: 'session-start', createdAt: '2026-08-29T10:00:00Z' });
    const summary = parseSession(jsonl);
    assert.deepStrictEqual(summary.cost.thoughts, []);
  });
});
