/**
 * test/thought-channel-view.test.js
 *
 * WO-L54-VIEW: the session receipt's THOUGHT CHANNEL section. The parser
 * writes session.thinkingBlocks only when at least one non-empty thinking
 * block exists; absence is "unrecorded", never "no thoughts".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSessionReceipt } from '../src/views/index.js';

function buildPayload(thinkingBlocks) {
  const session = { id: 's', model: 'm' };
  if (arguments.length > 0) {
    session.thinkingBlocks = thinkingBlocks;
  }
  return {
    session,
    ran: [],
    touched: [],
    failed: [],
    cost: {},
    sent: { items: [] },
    counts: {}
  };
}

test('two thinking blocks render counts and total length, not unrecorded', () => {
  const out = renderSessionReceipt(
    buildPayload([
      { turn: 1, digest: 'aaaa0000aaaa0000', length: 10 },
      { turn: 2, digest: 'bbbb1111bbbb1111', length: 32 }
    ])
  );
  assert.ok(out.includes('THOUGHT CHANNEL'));
  assert.ok(out.includes('Stated-reasoning blocks: 2'));
  assert.ok(out.includes('Total length (chars):    42'));
  assert.ok(out.includes('self-report'));
  assert.ok(!out.includes('(unrecorded)'));
});

test('absent thinkingBlocks field renders unrecorded, never zero thoughts', () => {
  const out = renderSessionReceipt(buildPayload());
  assert.ok(out.includes('THOUGHT CHANNEL'));
  assert.ok(out.includes('(unrecorded)'));
  assert.ok(out.includes('never read as "no thoughts"'));
  assert.ok(!out.includes('Stated-reasoning blocks'));
});

test('empty array renders unrecorded (not a parser output, not zero thoughts)', () => {
  const out = renderSessionReceipt(buildPayload([]));
  assert.ok(out.includes('(unrecorded)'));
  assert.ok(out.includes('never read as "no thoughts"'));
  assert.ok(!out.includes('Stated-reasoning blocks'));
});

test('thinking digests never appear in the rendered receipt', () => {
  const digest = 'abcdef0123456789';
  const out = renderSessionReceipt(
    buildPayload([{ turn: 1, digest, length: 10 }])
  );
  assert.ok(!out.includes(digest));
});

test('section order: COST, then THOUGHT CHANNEL, then FAILURES', () => {
  const out = renderSessionReceipt(
    buildPayload([{ turn: 1, digest: 'cccc2222cccc2222', length: 7 }])
  );
  const idxCost = out.indexOf('COST');
  const idxThought = out.indexOf('THOUGHT CHANNEL');
  const idxFailures = out.indexOf('FAILURES');
  assert.ok(idxCost !== -1);
  assert.ok(idxThought !== -1);
  assert.ok(idxFailures !== -1);
  assert.ok(idxCost < idxThought);
  assert.ok(idxThought < idxFailures);
});