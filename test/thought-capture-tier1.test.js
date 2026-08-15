// thought-capture tier 1 + parser versioning (2026-08-15): transcriptHash
// bind, thinkingBlocks digests, parserVersionHash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { parseSession, PARSER_SCHEMA, parserVersionHash } from '../src/parser/index.js';

const line = obj => JSON.stringify(obj);
const asst = (content, extra = {}) => line({
  message: { role: 'assistant', model: 'test-model', content }, ...extra
});

test('PARSER_SCHEMA and parserVersionHash exist and are stable in-process', () => {
  assert.equal(PARSER_SCHEMA, 'parser/1');
  const h = parserVersionHash();
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(parserVersionHash(), h);
});

test('transcriptHash is full 64-hex and matches the utf-8 bytes of the input', () => {
  const text = asst([{ type: 'text', text: 'hi' }]);
  const out = parseSession(text);
  assert.equal(out.transcriptHash, crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'));
  assert.match(out.transcriptHash, /^[0-9a-f]{64}$/);
});

test('explicit transcriptBytes wins over the string encoding', () => {
  const text = asst([]);
  const bytes = Buffer.from(text + '\n', 'utf8');
  const out = parseSession(text, { transcriptBytes: bytes });
  assert.equal(out.transcriptHash, crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('transcriptHash differs on a one-byte difference', () => {
  const a = parseSession(asst([{ type: 'text', text: 'x' }]));
  const b = parseSession(asst([{ type: 'text', text: 'y' }]));
  assert.notEqual(a.transcriptHash, b.transcriptHash);
});

test('thinking blocks produce per-block digests with turn and length', () => {
  const text = asst([
    { type: 'thinking', thinking: 'consider the options' },
    { type: 'tool_use', name: 'Read', id: 't1', input: { file_path: 'x' } }
  ]);
  const out = parseSession(text);
  assert.ok(Array.isArray(out.session.thinkingBlocks));
  assert.equal(out.session.thinkingBlocks.length, 1);
  const b = out.session.thinkingBlocks[0];
  assert.match(b.digest, /^[0-9a-f]{16}$/);
  assert.equal(b.length, 'consider the options'.length);
  assert.equal(typeof b.turn, 'number');
  // the tool_use beside it still parsed
  assert.equal(out.counts.toolCalls, 1);
});

test('a transcript with no thinking blocks has NO thinkingBlocks field', () => {
  const out = parseSession(asst([{ type: 'tool_use', name: 'Read', id: 't1', input: {} }]));
  assert.equal(out.session.thinkingBlocks, undefined);
});

test('empty thinking blocks are skipped, not recorded as zero-length', () => {
  const out = parseSession(asst([{ type: 'thinking', thinking: '' }]));
  assert.equal(out.session.thinkingBlocks, undefined);
});

test('thinking digests are stable across repeated parses', () => {
  const text = asst([{ type: 'thinking', thinking: 'same thought' }]);
  assert.equal(
    parseSession(text).session.thinkingBlocks[0].digest,
    parseSession(text).session.thinkingBlocks[0].digest
  );
});

test('item.text fallback is honored when item.thinking is absent', () => {
  const out = parseSession(asst([{ type: 'thinking', text: 'fallback shape' }]));
  assert.equal(out.session.thinkingBlocks.length, 1);
});
