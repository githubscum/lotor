/**
 * test/known-limits-87-sent-plaintext.test.js
 *
 * Tripwire for KNOWN-LIMITS 87 (2026-11-05). It pins the parser's current
 * behaviour on `sent.items[].target`: the value is plaintext, nothing
 * redacts it, and the Bash network test is a bare substring over the
 * lowercased command, so it matches wider than the verb names suggest.
 * This pins today's behaviour; it is not an endorsement of it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSession } from '../src/parser/index.js';

// Synthetic assistant tool_use line, shaped exactly like the real thing.
const toolUseLine = (id, name, input) => JSON.stringify({
  type: 'assistant',
  sessionId: 's1',
  timestamp: '2026-11-05T00:00:00Z',
  message: {
    model: 'm',
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }]
  }
});

// All values below are obviously fake and go nowhere. They exist so the
// pinned assertions are about shape, not about any real credential.
const LONG_COMMAND = 'curl https://example.test/' + 'FAKE'.repeat(40); // > 100 chars

const jsonl = [
  toolUseLine('t0', 'Bash', { command: 'curl -H "Authorization: Bearer FAKE-TOKEN" https://example.test/x' }),
  toolUseLine('t1', 'WebFetch', { url: 'https://example.test/x?api_key=FAKE-KEY' }),
  toolUseLine('t2', 'WebSearch', { query: 'FAKE-QUERY private search words' }),
  toolUseLine('t3', 'Bash', { command: LONG_COMMAND }),
  toolUseLine('t4', 'Bash', { command: 'cat mapping.txt' }),
  toolUseLine('t5', 'Bash', { command: 'ls -la' }),
  toolUseLine('t6', 'Write', { file_path: 'FAKE.md', content: '# fake' })
].join('\n');

const receipt = parseSession(jsonl);
const sent = receipt.sent;
const items = sent.items;

function findTargetSubstring(tool, needle) {
  return items.filter(i => i.tool === tool && i.target.includes(needle));
}

describe('KNOWN-LIMITS 87: sent targets are plaintext', () => {
  it('keeps the capture note (self-attested) beside the items', () => {
    assert.ok(typeof sent.captureNote === 'string');
  });

  it('carries a Bash curl command verbatim as a target, credential text included', () => {
    const [hit] = findTargetSubstring('Bash', 'FAKE-TOKEN');
    assert.ok(hit, 'no sent item holds the curl command text');
    assert.equal(hit.target, 'curl -H "Authorization: Bearer FAKE-TOKEN" https://example.test/x');
  });

  it('carries a WebFetch URL verbatim, query string included', () => {
    const [hit] = findTargetSubstring('WebFetch', 'api_key=FAKE-KEY');
    assert.ok(hit, 'no sent item holds the WebFetch URL');
    assert.equal(hit.target, 'https://example.test/x?api_key=FAKE-KEY');
  });

  it('carries a WebSearch query verbatim', () => {
    const [hit] = findTargetSubstring('WebSearch', 'FAKE-QUERY private search words');
    assert.ok(hit, 'no sent item holds the WebSearch query');
    assert.equal(hit.target, 'FAKE-QUERY private search words');
  });

  it('truncates a long Bash command to exactly 100 characters', () => {
    assert.ok(LONG_COMMAND.length > 100);
    const [hit] = findTargetSubstring('Bash', 'curl https://example.test/');
    assert.ok(hit, 'long curl command did not produce a sent item');
    assert.equal(hit.target.length, 100);
    assert.equal(hit.target, LONG_COMMAND.slice(0, 100));
  });

  it('qualifies a non-network command through a bare substring (pinning the wide match)', () => {
    const hit = items.find(i => i.tool === 'Bash' && i.target === 'cat mapping.txt');
    assert.ok(hit, 'cat mapping.txt did not land in sent; the bare substring match on ping has changed');
  });

  it('writes no sent item for a plain ls or a Write call', () => {
    assert.ok(!items.some(i => i.target.includes('ls -la')), 'plain ls produced a sent item');
    assert.ok(!items.some(i => i.tool === 'Write'), 'a Write call produced a sent item');
    // Everything else in the transcript is accounted for above.
    assert.equal(items.length, 5);
  });
});
