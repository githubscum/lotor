/**
 * test/known-limits-88-sent-plaintext.test.js
 *
 * Tripwire for KNOWN-LIMITS 88 (2026-11-05). It pins the parser's current
 * behaviour on `sent.items[].target`: the value is plaintext, nothing
 * redacts it. The wide-match half of the limit is now closed — the Bash
 * network test is whole-word, not a bare substring over the lowercased
 * command — so non-network commands no longer qualify through a fragment of
 * a verb. The plaintext behaviour is still pinned here; this file is not an
 * endorsement of it.
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

describe('KNOWN-LIMITS 88: sent targets are plaintext', () => {
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

  it('writes no sent item for cat mapping.txt — the Bash network match is whole-word (limit 88 wide-match half closed)', () => {
    const hit = items.find(i => i.tool === 'Bash' && i.target === 'cat mapping.txt');
    assert.ok(!hit, 'cat mapping.txt produced a sent item; the whole-word match regressed to a bare substring');
  });

  it('writes no sent item for a plain ls or a Write call', () => {
    assert.ok(!items.some(i => i.target.includes('ls -la')), 'plain ls produced a sent item');
    assert.ok(!items.some(i => i.tool === 'Write'), 'a Write call produced a sent item');
    // Everything else in the transcript is accounted for above. The bare
    // substring no longer qualifies `cat mapping.txt`, so one fewer item.
    assert.equal(items.length, 4);
  });
});

describe('KNOWN-LIMITS 88 wide-match half: whole-word network verbs, per row', () => {
  // Required outcomes, lowercased command -> recorded in sent?
  const CASES = [
    ['cat mapping.txt', false],
    ['ls scpfiles/', false],
    ['echo skipping', false],
    ['ping 1.1.1.1', true],
    ['curl https://x.test', true],
    ['/usr/bin/curl https://x.test', true],
    ['curl.exe https://x.test', true],
    ['echo hi && curl https://x.test', true],
    ['x=$(curl -s https://x.test)', true],
    ['git  push origin main', true],
    ['nc -l 8080', true],
    ['sync', false],
    ['ls -la', false],
  ];

  // One synthetic transcript per table row, each a lone Bash command, so a
  // row's sent item (target === command.slice(0, 100), all rows < 100 chars)
  // is directly attributable to its own command.
  const tableJsonl = CASES.map(([cmd], i) => toolUseLine(`w${i}`, 'Bash', { command: cmd }));

  const tableItems = parseSession(tableJsonl.join('\n')).sent.items;

  assert.equal(tableItems.length, CASES.filter(([, expected]) => expected).length,
    'the transcript produced an unexpected number of sent items');

  for (const [cmd, expected] of CASES) {
    it(`${expected ? 'records' : 'does not record'} \`${cmd}\``, () => {
      assert.equal(tableItems.some(i => i.tool === 'Bash' && i.target === cmd), expected,
        `\`${cmd}\` should ${expected ? '' : 'not '}land in sent`);
    });
  }
});
