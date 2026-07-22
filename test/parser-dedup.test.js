import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseSession } from '../src/parser/index.js';

/**
 * Tests for the per-message usage dedup fix in src/parser/index.js.
 *
 * Claude Code writes one assistant message across several JSONL lines.
 * Each line carries a full, byte-identical copy of the same message.usage.
 * The parser must accumulate usage only ONCE per distinct message, while
 * still walking every line for tool_use extraction.
 */

/**
 * Build a one-message / four-line JSONL where the assistant reply is split
 * into a text block on line 1 and three tool_use blocks on lines 2-4.
 * All four lines share the same message.id and the same usage.
 */
function buildSplitMessageJsonl({ id, usage, tools }) {
  const sessionStart = JSON.stringify({
    sessionId: 'dedup-test',
    version: '2.1.999',
    createdAt: '2026-07-22T10:00:00Z',
    type: 'session-start'
  });

  const lines = [sessionStart];

  // Line 1: text content + shared usage
  lines.push(JSON.stringify({
    message: {
      id,
      role: 'assistant',
      model: 'test-model-v1',
      content: [{ type: 'text', text: 'hi' }],
      usage
    },
    createdAt: '2026-07-22T10:00:01Z'
  }));

  // Lines 2..N: one tool_use each, same message.id, same usage
  tools.forEach((tool, i) => {
    lines.push(JSON.stringify({
      message: {
        id,
        role: 'assistant',
        model: 'test-model-v1',
        content: [{
          type: 'tool_use',
          name: tool.name,
          id: tool.id,
          input: tool.input
        }],
        usage
      },
      createdAt: `2026-07-22T10:00:0${2 + i}Z`
    }));
  });

  return lines.join('\n');
}

describe('parseSession usage dedup (cost/2)', () => {
  it('counts usage once for a message split across 4 lines (same message.id)', () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5
    };
    const tools = [
      { name: 'Edit',   id: 'tool_a', input: { file_path: '/tmp/a.js' } },
      { name: 'Bash',   id: 'tool_b', input: { command: 'ls' } },
      { name: 'WebFetch', id: 'tool_c', input: { url: 'https://example.com' } }
    ];
    const jsonl = buildSplitMessageJsonl({ id: 'msg_abc123', usage, tools });
    const result = parseSession(jsonl);

    assert.strictEqual(result.cost.inputTokens, 100, 'inputTokens should be 100, not 400');
    assert.strictEqual(result.cost.outputTokens, 50, 'outputTokens should be 50, not 200');
    assert.strictEqual(result.cost.cacheCreationTokens, 10, 'cacheCreationTokens should be 10, not 40');
    assert.strictEqual(result.cost.cacheReadTokens, 5, 'cacheReadTokens should be 5, not 20');

    // Distinct messages: one
    assert.strictEqual(result.counts.assistantMessages, 1);
    // ran[] must still walk every line: 3 tool_use blocks
    assert.strictEqual(result.ran.length, 3);
    // turns counts assistant LINES, not deduplicated messages — should be 4
    assert.strictEqual(result.counts.turns, 4);
    // Provenance discriminator
    assert.strictEqual(result.cost.schema, 'cost/2');
  });

  it('sums distinct messages by message.id (no over-collapse)', () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    };
    const sessionStart = JSON.stringify({
      sessionId: 'dedup-distinct',
      version: '2.1.999',
      createdAt: '2026-07-22T10:00:00Z',
      type: 'session-start'
    });
    const lineA = JSON.stringify({
      message: {
        id: 'msg_aaa',
        role: 'assistant',
        model: 'm',
        content: [{ type: 'text', text: 'a' }],
        usage
      },
      createdAt: '2026-07-22T10:00:01Z'
    });
    const lineB = JSON.stringify({
      message: {
        id: 'msg_bbb',
        role: 'assistant',
        model: 'm',
        content: [{ type: 'text', text: 'b' }],
        usage
      },
      createdAt: '2026-07-22T10:00:02Z'
    });
    const result = parseSession([sessionStart, lineA, lineB].join('\n'));

    assert.strictEqual(result.cost.inputTokens, 20);
    assert.strictEqual(result.cost.outputTokens, 10);
    assert.strictEqual(result.counts.assistantMessages, 2);
    assert.strictEqual(result.counts.turns, 2);
  });

  it('falls back to a per-line key when no id/requestId/uuid is present', () => {
    // This is the case the existing synthetic fixture in test/parser.test.js
    // exercises. With the per-line fallback, the four turns are distinct
    // even though none carry an id, and the sum equals the naive per-line
    // sum.
    const sessionStart = JSON.stringify({
      sessionId: 'dedup-fallback',
      version: '2.1.999',
      createdAt: '2026-07-22T10:00:00Z',
      type: 'session-start'
    });
    const makeLine = (text, usage) => JSON.stringify({
      message: {
        role: 'assistant',
        model: 'm',
        content: [{ type: 'text', text }],
        usage
      },
      createdAt: '2026-07-22T10:00:01Z'
    });
    const lineA = makeLine('a', {
      input_tokens: 10, output_tokens: 5,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0
    });
    const lineB = makeLine('b', {
      input_tokens: 10, output_tokens: 5,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0
    });
    const result = parseSession([sessionStart, lineA, lineB].join('\n'));

    assert.strictEqual(result.cost.inputTokens, 20);
    assert.strictEqual(result.cost.outputTokens, 10);
    assert.strictEqual(result.counts.assistantMessages, 2);
    assert.strictEqual(result.counts.turns, 2);
  });
});
