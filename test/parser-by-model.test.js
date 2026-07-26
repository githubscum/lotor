import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseSession } from '../src/parser/index.js';

/**
 * Tests for the per-model cost breakdown added in src/parser/index.js.
 *
 * These cover WO-COST-ATTRIBUTION-2026-07-25 requirements:
 *  - mixed-model transcript: each model's tokens land under its own key
 *  - single-model transcript: flat total unchanged (regression guard)
 *  - dedup: one assistant message across several JSONL lines -> counted once,
 *    in both the flat total and the breakdown
 *  - a message with no model field: does not crash; lands in an "unknown" bucket
 *
 * The schema marker is `cost/3` once a receipt carries a breakdown.
 */

const sessionStart = (id) => JSON.stringify({
  sessionId: id,
  version: '2.1.999',
  createdAt: '2026-07-25T10:00:00Z',
  type: 'session-start'
});

const assistantLine = (overrides) => JSON.stringify({
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'x' }],
    ...overrides
  },
  createdAt: '2026-07-25T10:00:01Z'
});

describe('parseSession per-model cost breakdown (cost/3)', () => {
  it('attributes tokens to each model in a mixed-model transcript', () => {
    const lines = [
      sessionStart('mixed-001'),
      assistantLine({
        id: 'msg_alpha_1',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      }),
      assistantLine({
        id: 'msg_alpha_2',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 200, output_tokens: 75, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      }),
      assistantLine({
        id: 'msg_beta_1',
        model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 30, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 15 }
      })
    ];
    const result = parseSession(lines.join('\n'));

    // Schema must be cost/3
    assert.strictEqual(result.cost.schema, 'cost/3', 'schema should be cost/3');

    // byModel exists and has both models
    assert.ok(result.cost.byModel, 'byModel should exist');
    assert.ok(result.cost.byModel['claude-opus-4-8'], 'opus bucket should exist');
    assert.ok(result.cost.byModel['claude-haiku-4-5-20251001'], 'haiku bucket should exist');

    // Opus: 100+200 input, 50+75 output
    const opus = result.cost.byModel['claude-opus-4-8'];
    assert.strictEqual(opus.inputTokens, 300, 'opus inputTokens');
    assert.strictEqual(opus.outputTokens, 125, 'opus outputTokens');
    assert.strictEqual(opus.cacheCreationTokens, 0, 'opus cacheCreationTokens');
    assert.strictEqual(opus.cacheReadTokens, 0, 'opus cacheReadTokens');
    assert.strictEqual(opus.messages, 2, 'opus message count');

    // Haiku: 30 input, 20 output, 5 cache creation, 15 cache read
    const haiku = result.cost.byModel['claude-haiku-4-5-20251001'];
    assert.strictEqual(haiku.inputTokens, 30, 'haiku inputTokens');
    assert.strictEqual(haiku.outputTokens, 20, 'haiku outputTokens');
    assert.strictEqual(haiku.cacheCreationTokens, 5, 'haiku cacheCreationTokens');
    assert.strictEqual(haiku.cacheReadTokens, 15, 'haiku cacheReadTokens');
    assert.strictEqual(haiku.messages, 1, 'haiku message count');

    // Neither bucket should contain the other's tokens
    assert.strictEqual(opus.inputTokens, 300, 'opus must not include haiku input');
    assert.strictEqual(haiku.inputTokens, 30, 'haiku must not include opus input');
    assert.notStrictEqual(opus.outputTokens, haiku.outputTokens, 'distinct outputs');

    // Flat total remains the sum of all (regression guard for the cost/2 dedup)
    assert.strictEqual(result.cost.inputTokens, 330, 'flat inputTokens = opus+haiku');
    assert.strictEqual(result.cost.outputTokens, 145, 'flat outputTokens = opus+haiku');
    assert.strictEqual(result.cost.cacheCreationTokens, 5);
    assert.strictEqual(result.cost.cacheReadTokens, 15);

    // assistantMessages still deduped
    assert.strictEqual(result.counts.assistantMessages, 3);
  });

  it('preserves the existing flat total for a single-model transcript (regression guard)', () => {
    const lines = [
      sessionStart('single-001'),
      assistantLine({
        id: 'msg_solo_1',
        model: 'claude-sonnet-5',
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      }),
      assistantLine({
        id: 'msg_solo_2',
        model: 'claude-sonnet-5',
        usage: { input_tokens: 50, output_tokens: 30, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 }
      })
    ];
    const result = parseSession(lines.join('\n'));

    // Same flat totals as before cost/3
    assert.strictEqual(result.cost.inputTokens, 150);
    assert.strictEqual(result.cost.outputTokens, 80);
    assert.strictEqual(result.cost.cacheCreationTokens, 10);
    assert.strictEqual(result.cost.cacheReadTokens, 5);
    assert.strictEqual(result.cost.schema, 'cost/3');

    // byModel has a single bucket, equal to the flat totals
    assert.ok(result.cost.byModel, 'byModel should exist');
    assert.ok(result.cost.byModel['claude-sonnet-5']);
    const sonnet = result.cost.byModel['claude-sonnet-5'];
    assert.strictEqual(sonnet.inputTokens, 150);
    assert.strictEqual(sonnet.outputTokens, 80);
    assert.strictEqual(sonnet.cacheCreationTokens, 10);
    assert.strictEqual(sonnet.cacheReadTokens, 5);
    assert.strictEqual(sonnet.messages, 2);

    // No other buckets
    assert.strictEqual(Object.keys(result.cost.byModel).length, 1);
  });

  it('dedups a single message split across several JSONL lines (in both flat and byModel)', () => {
    // One assistant message (id=msg_dedup_1) on three lines, same byte-identical usage.
    // Same-model breakdown, so byModel['m'] should reflect ONE message's worth.
    const sharedUsage = {
      input_tokens: 100, output_tokens: 50,
      cache_creation_input_tokens: 10, cache_read_input_tokens: 5
    };
    const lines = [
      sessionStart('dedup-001'),
      // Line 1: text content, shared usage
      JSON.stringify({
        message: { id: 'msg_dedup_1', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'hi' }], usage: sharedUsage },
        createdAt: '2026-07-25T10:00:01Z'
      }),
      // Line 2: tool_use 1
      JSON.stringify({
        message: { id: 'msg_dedup_1', role: 'assistant', model: 'm', content: [{ type: 'tool_use', name: 'Edit', id: 't1', input: { file_path: '/a.js' } }], usage: sharedUsage },
        createdAt: '2026-07-25T10:00:02Z'
      }),
      // Line 3: tool_use 2
      JSON.stringify({
        message: { id: 'msg_dedup_1', role: 'assistant', model: 'm', content: [{ type: 'tool_use', name: 'Bash', id: 't2', input: { command: 'ls' } }], usage: sharedUsage },
        createdAt: '2026-07-25T10:00:03Z'
      })
    ];
    const result = parseSession(lines.join('\n'));

    // Flat total: one message's worth, not three
    assert.strictEqual(result.cost.inputTokens, 100, 'flat inputTokens must not be tripled');
    assert.strictEqual(result.cost.outputTokens, 50, 'flat outputTokens must not be tripled');
    assert.strictEqual(result.cost.cacheCreationTokens, 10);
    assert.strictEqual(result.cost.cacheReadTokens, 5);
    assert.strictEqual(result.counts.assistantMessages, 1);

    // byModel: same one-message worth, counted once
    assert.ok(result.cost.byModel['m']);
    const m = result.cost.byModel['m'];
    assert.strictEqual(m.inputTokens, 100, 'byModel inputTokens must not be tripled');
    assert.strictEqual(m.outputTokens, 50);
    assert.strictEqual(m.cacheCreationTokens, 10);
    assert.strictEqual(m.cacheReadTokens, 5);
    assert.strictEqual(m.messages, 1, 'byModel messages must be 1, not 3');

    // ran[] must still walk every line (3 tool_use blocks -> 2 tool_uses; line 1 is text-only)
    assert.strictEqual(result.ran.length, 2, 'ran must still reflect all tool_use lines');
  });

  it('lands messages with no model field in an "unknown" bucket, without crashing', () => {
    const lines = [
      sessionStart('nomodel-001'),
      assistantLine({
        id: 'msg_nm_1',
        // no `model` field at all
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      }),
      assistantLine({
        id: 'msg_nm_2',
        model: 'claude-sonnet-5',
        usage: { input_tokens: 20, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      })
    ];
    const result = parseSession(lines.join('\n'));

    // Did not crash; flat total includes both messages
    assert.strictEqual(result.cost.inputTokens, 30);
    assert.strictEqual(result.cost.outputTokens, 15);

    // The no-model message lands in `unknown` explicitly
    assert.ok(result.cost.byModel, 'byModel should exist');
    assert.ok(result.cost.byModel.unknown, 'no-model message should land in unknown bucket');
    assert.strictEqual(result.cost.byModel.unknown.inputTokens, 10);
    assert.strictEqual(result.cost.byModel.unknown.outputTokens, 5);
    assert.strictEqual(result.cost.byModel.unknown.messages, 1);

    // The named model still gets its own bucket
    assert.ok(result.cost.byModel['claude-sonnet-5']);
    assert.strictEqual(result.cost.byModel['claude-sonnet-5'].inputTokens, 20);
    assert.strictEqual(result.cost.byModel['claude-sonnet-5'].messages, 1);
  });
});
