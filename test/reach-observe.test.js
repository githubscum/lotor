/*
 * test/reach-observe.test.js
 *
 * Synthetic fixtures only: every response body below is built inline.
 * Covers the 11 cases in WO V3-05 plus the 12th from WO V3-05b (an error
 * body that also carries message content and a logprobs array must still
 * report observed [] and logprobs null), and review fixes E-G (think levels,
 * a null inside top_logprobs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUNG_ORDER, CAPABILITY_RUNGS, observeRungs, reachReport } from '../src/reach/index.js';

function lpEntry(token, logprob, top) {
  return top
    ? { token, logprob, top_logprobs: top }
    : { token, logprob };
}

test('1. local qwen-shaped body: R0 + R4 true, R3 false, count/min/mean correct', () => {
  const body = {
    model: 'qwen3:8b',
    message: { content: 'The port is 8080.' },
    logprobs: [
      lpEntry('The', -0.5, [{ token: 'The', logprob: -0.5 }, { token: 'A', logprob: -2.1 }]),
      lpEntry(' port', -1.0, [{ token: ' port', logprob: -1.0 }, { token: ' value', logprob: -3.4 }]),
      lpEntry(' is', -1.5, [{ token: ' is', logprob: -1.5 }, { token: ' was', logprob: -2.2 }])
    ]
  };
  const obs = observeRungs(body);
  assert.equal(obs.rungs.R0, true);
  assert.equal(obs.rungs.R4, true);
  assert.equal(obs.rungs.R3, false);
  assert.equal(obs.logprobs.count, 3);
  assert.ok(obs.logprobs.digest.startsWith('sha256:'));
  assert.equal(obs.logprobs.minLogprob, -1.5);
  assert.ok(Math.abs(obs.logprobs.meanLogprob - (-1.0)) < 1e-12);
  assert.equal(obs.rungs.R1, false);
});

test('2. cloud glm-shaped body with think/logprobs/tools requested: R4 silently dropped', () => {
  const body = {
    model: 'glm-5.3-flash',
    message: {
      content: 'answer text',
      thinking: 'hidden reasoning',
      tool_calls: [{ function: { name: 'f', arguments: '{}' } }]
    }
  };
  const request = { think: true, logprobs: true, tools: [{}] };
  const report = reachReport(request, body);
  assert.deepEqual(report.observed, ['R0', 'R1', 'R3']);
  assert.deepEqual(report.silentlyDropped, ['R4']);
  assert.equal(report.deepest, 'R3');
});

test('3. think:false leak: content marker </think> alone makes R3 true', () => {
  const body = {
    model: 'glm-5.3-flash',
    message: { content: 'reasoning text\n</think>\nThe port is 8080' }
  };
  const obs = observeRungs(body);
  assert.equal(obs.rungs.R3, true);
  assert.deepEqual(obs.r3Sources, ['content-markers']);
});

test('4. both R3 sources: thinking field and <think> marker in content, in fixed order', () => {
  const body = {
    model: 'm',
    message: { content: 'the plan\n<think>quiet part</think>\nfinal answer', thinking: 'quiet reasoning' }
  };
  const obs = observeRungs(body);
  assert.deepEqual(obs.r3Sources, ['thinking', 'content-markers']);
  assert.equal(obs.rungs.R3, true);
});

test('5. error body with request asking R4: observed [], silentlyDropped [], error set', () => {
  const body = { error: 'logprobs is not supported with tools + stream', model: 'm' };
  const request = { logprobs: true, tools: [{}], think: true };
  const report = reachReport(request, body);
  assert.equal(report.error, 'logprobs is not supported with tools + stream');
  assert.deepEqual(report.observed, []);
  assert.deepEqual(report.silentlyDropped, []);
  assert.equal(report.deepest, null);
  assert.equal(report.logprobs, null);
  assert.deepEqual(report.r3Sources, []);
});

test('6. digest tamper: a 0.001 change shifts the digest; unchanged body reproduces it', () => {
  const entries = [
    lpEntry('a', -0.1, [{ token: 'a', logprob: -0.1 }]),
    lpEntry('b', -0.2),
    lpEntry('c', -0.3)
  ];
  const base = observeRungs({ model: 'm', message: { content: 'x' }, logprobs: entries });
  const tampered = observeRungs({
    model: 'm',
    message: { content: 'x' },
    // Only the logprob moves; the top_logprobs array is carried over intact,
    // so the digest change can only come from the 0.001 shift.
    logprobs: entries.map((e, i) => (i === 0 ? lpEntry('a', e.logprob - 0.001, e.top_logprobs) : e))
  });
  const repeat = observeRungs({ model: 'm', message: { content: 'x' }, logprobs: entries });
  assert.notEqual(base.logprobs.digest, tampered.logprobs.digest);
  assert.equal(base.logprobs.digest, repeat.logprobs.digest);
});

test('7. no token leak: secret canary token never appears in the serialized report', () => {
  const body = {
    model: 'm',
    message: { content: 'x' },
    logprobs: [
      lpEntry('ghp_SECRETCANARY123', -0.1, [{ token: 'ghp_SECRETCANARY123', logprob: -0.1 }]),
      lpEntry('b', -0.2)
    ]
  };
  const report = reachReport(null, body);
  assert.equal(report.logprobs !== null, true);
  assert.ok(!JSON.stringify(report).includes('SECRETCANARY'));
  assert.match(report.logprobs.digest, /^sha256:[0-9a-f]{64}$/);
});

test('8. request independence: request null vs request asking everything, identical observed', () => {
  const body = {
    model: 'm',
    message: { content: 'x', tool_calls: [{ function: { name: 'f', arguments: '{}' } }], thinking: 'why' },
    logprobs: [lpEntry('x', -0.4)]
  };
  const a = reachReport(null, body);
  const b = reachReport({ think: true, logprobs: true, tools: [{}] }, body);
  assert.deepEqual(a.observed, b.observed);
  assert.deepEqual(a.observed, ['R0', 'R1', 'R3', 'R4']);
});

test('9. malformed logprobs: one entry missing logprob -> R4 false, logprobs null', () => {
  const body = {
    model: 'm',
    message: { content: 'x' },
    logprobs: [lpEntry('a', -0.1), { token: 'b' }]
  };
  const obs = observeRungs(body);
  assert.equal(obs.rungs.R4, false);
  assert.equal(obs.logprobs, null);
});

test('10. empty logprobs array -> R4 false, logprobs null', () => {
  const body = { model: 'm', message: { content: 'x' }, logprobs: [] };
  const obs = observeRungs(body);
  assert.equal(obs.rungs.R4, false);
  assert.equal(obs.logprobs, null);
});

test('11. whitespace-only content -> R0 false', () => {
  const body = { model: 'm', message: { content: ' \n\t  ' } };
  const obs = observeRungs(body);
  assert.equal(obs.rungs.R0, false);
});

test('12. WO V3-05b: error body that also has message.content and a logprobs array still reports observed [] and logprobs null', () => {
  const body = {
    model: 'qwen3:8b',
    error: 'logprobs is not supported with tools + stream',
    message: { content: 'looks like an answer' },
    logprobs: [lpEntry('a', -0.1), lpEntry('b', -0.2), lpEntry('c', -0.3)]
  };
  const obs = observeRungs(body);
  assert.equal(obs.error, 'logprobs is not supported with tools + stream');
  assert.deepEqual(obs.rungs, { R0: false, R1: false, R3: false, R4: false });
  assert.deepEqual(obs.r3Sources, []);
  assert.equal(obs.logprobs, null);
  assert.equal(obs.model, 'qwen3:8b');

  const report = reachReport({ logprobs: true }, body);
  assert.deepEqual(report.observed, []);
  assert.deepEqual(report.silentlyDropped, []);
  assert.equal(report.logprobs, null);
});

test('RUNG_ORDER is frozen and in spec order', () => {
  assert.deepEqual([...RUNG_ORDER], ['R0', 'R1', 'R3', 'R4']);
  assert.throws(() => { 'use strict'; RUNG_ORDER.push('R5'); });
});

test('A. pure tool call, empty content: R0 not silently dropped, observed R1 only', () => {
  const body = {
    model: 'm',
    message: {
      content: '',
      tool_calls: [{ function: { name: 'f', arguments: '{}' } }]
    }
  };
  const request = { tools: [{}] };
  const report = reachReport(request, body);
  assert.deepEqual(report.silentlyDropped, []);
  assert.deepEqual(report.observed, ['R1']);
});

test('B. text answer when tools were offered: R1 not silently dropped, still requested', () => {
  const body = {
    model: 'm',
    message: { content: 'answering in text instead of calling a tool' }
  };
  const request = { tools: [{}] };
  const report = reachReport(request, body);
  assert.deepEqual(report.silentlyDropped, []);
  assert.ok(report.requested.includes('R1'));
});

test('C. think/logprobs requested but body has neither: silentlyDropped R3 and R4', () => {
  const body = {
    model: 'm',
    message: { content: 'plain answer, no thinking, no logprobs' }
  };
  const request = { think: true, logprobs: true };
  const report = reachReport(request, body);
  assert.deepEqual(report.silentlyDropped, ['R3', 'R4']);
});

test('D. CAPABILITY_RUNGS is frozen and equals R3, R4', () => {
  assert.deepEqual([...CAPABILITY_RUNGS], ['R3', 'R4']);
  assert.throws(() => { 'use strict'; CAPABILITY_RUNGS.push('R5'); });
});

test('E. think as a level ("low"/"medium"/"high") requests R3; withheld reasoning lands in silentlyDropped', () => {
  const body = { model: 'm', message: { content: 'plain answer, no reasoning channel' } };
  for (const level of ['low', 'medium', 'high']) {
    const report = reachReport({ think: level }, body);
    assert.ok(report.requested.includes('R3'), `think:${level} requests R3`);
    assert.deepEqual(report.silentlyDropped, ['R3'], `think:${level} withheld is a silent drop`);
  }
  assert.ok(!reachReport({ think: false }, body).requested.includes('R3'));
  assert.ok(!reachReport({}, body).requested.includes('R3'));
});

test('F. think level with reasoning returned: R3 observed, not dropped', () => {
  const body = { model: 'm', message: { content: 'answer', thinking: 'reasoning' } };
  const report = reachReport({ think: 'high' }, body);
  assert.deepEqual(report.silentlyDropped, []);
  assert.ok(report.observed.includes('R3'));
});

test('G. a null inside top_logprobs is recorded, not thrown', () => {
  const body = {
    model: 'm',
    message: { content: 'x' },
    logprobs: [
      lpEntry('a', -0.1, [{ token: 'a', logprob: -0.1 }, null]),
      lpEntry('b', -0.2, [null])
    ]
  };
  let obs;
  assert.doesNotThrow(() => { obs = observeRungs(body); });
  assert.equal(obs.rungs.R4, true);
  assert.equal(obs.logprobs.count, 2);
  assert.deepEqual(obs.logprobs.malformedTopLogprobs, [{ entry: 0, index: 1 }, { entry: 1, index: 0 }]);
  assert.match(obs.logprobs.digest, /^sha256:[0-9a-f]{64}$/);
  // The malformed slot still feeds the digest: replacing it changes the hash.
  const fixed = observeRungs({
    ...body,
    logprobs: [lpEntry('a', -0.1, [{ token: 'a', logprob: -0.1 }, { token: 'z', logprob: -4 }]), lpEntry('b', -0.2, [null])]
  });
  assert.notEqual(obs.logprobs.digest, fixed.logprobs.digest);
  assert.deepEqual(fixed.logprobs.malformedTopLogprobs, [{ entry: 1, index: 0 }]);
  // A well-formed body reports an empty list.
  const clean = observeRungs({ model: 'm', message: { content: 'x' }, logprobs: [lpEntry('a', -0.1)] });
  assert.deepEqual(clean.logprobs.malformedTopLogprobs, []);
});

// WO-REACH-TOPLP: a top_logprobs that is present but not an array is
// malformed at the entry level and must move the digest away from the
// absent case, instead of vanishing into the same canonical [].
test('H. string top_logprobs: entry-level malformed with index null, R4 still true', () => {
  const stringBody = {
    model: 'm',
    message: { content: 'x' },
    logprobs: [{ token: 'a', logprob: -0.1, top_logprobs: 'garbage' }]
  };
  const obs = observeRungs(stringBody);
  assert.equal(obs.rungs.R4, true);
  assert.deepEqual(obs.logprobs.malformedTopLogprobs, [{ entry: 0, index: null }]);
  assert.match(obs.logprobs.digest, /^sha256:[0-9a-f]{64}$/);
});

test('I. string top_logprobs vs the same body with the field removed: different digests', () => {
  const stringBody = {
    model: 'm',
    message: { content: 'x' },
    logprobs: [{ token: 'a', logprob: -0.1, top_logprobs: 'garbage' }]
  };
  const absentBody = {
    model: 'm',
    message: { content: 'x' },
    logprobs: [{ token: 'a', logprob: -0.1 }]
  };
  const withString = observeRungs(stringBody);
  const absent = observeRungs(absentBody);
  assert.notEqual(withString.logprobs.digest, absent.logprobs.digest);
  assert.deepEqual(absent.logprobs.malformedTopLogprobs, []);
});

test('J. top_logprobs null counts as absent: no malformed report, digest equal to absent case', () => {
  const nullBody = {
    model: 'm',
    message: { content: 'x' },
    logprobs: [{ token: 'a', logprob: -0.1, top_logprobs: null }]
  };
  const absentBody = {
    model: 'm',
    message: { content: 'x' },
    logprobs: [{ token: 'a', logprob: -0.1 }]
  };
  const withNull = observeRungs(nullBody);
  const absent = observeRungs(absentBody);
  assert.deepEqual(withNull.logprobs.malformedTopLogprobs, []);
  assert.equal(withNull.logprobs.digest, absent.logprobs.digest);
});

test('K. mixed: entry 0 non-array object, entry 1 array with a non-object element', () => {
  const body = {
    model: 'm',
    message: { content: 'x' },
    logprobs: [
      { token: 'a', logprob: -0.1, top_logprobs: { t: 'a', l: -0.1 } },
      lpEntry('b', -0.2, [null])
    ]
  };
  const obs = observeRungs(body);
  assert.equal(obs.rungs.R4, true);
  assert.deepEqual(
    obs.logprobs.malformedTopLogprobs,
    [{ entry: 0, index: null }, { entry: 1, index: 0 }]
  );
});
