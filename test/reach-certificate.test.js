/**
 * test/reach-certificate.test.js
 *
 * Lotor v3, work order V3-02: the reach certificate.
 *
 * The spec's rule (LOTOR-V3-SPEC-2026-10-18, "The reach certificate"): each
 * session states the model, the runtime and the deepest rung recorded,
 * MEASURED, NOT DECLARED, so a later finding can never claim more depth than
 * its record had. V3-01 measured the failure this guards against: Ollama
 * cloud accepts a logprobs request, answers HTTP 200, and silently leaves the
 * field out. A recorder that trusted the request would certify R4 it never
 * received.
 *
 * What is asserted here, in order:
 *   1. The open half states only what is known at open, and never a rung.
 *   2. The close half is computed from what came back and what was kept:
 *      a rung is "recorded" only when the receipt holds a per-item record of
 *      it AND the transcript carried it; "observed" when the transcript
 *      carried it and this build keeps no per-item record; "unrecorded"
 *      otherwise, with no count at all (absence never reads as zero).
 *   3. The ceiling: no input, declared or forged, can make a certificate
 *      state a deeper rung than was observed.
 *   4. Chain fidelity (eval E2): the certificate lands on the session
 *      receipt, verifies on the chain, and tampering with it breaks
 *      verification.
 *
 * LOTOR_HOME is pointed at a throwaway dir before src/ingest is imported,
 * so nothing here touches the real store.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  REACH_SCHEMA,
  RUNGS,
  UNRECORDED,
  NOT_YET_MEASURED,
  MULTIPLE_MODELS,
  MEASUREMENT_FAILED,
  buildOpenCertificate,
  measureCloseCertificate,
  failedCloseCertificate,
  attachOpenReference,
  checkCertificate
} from '../src/reach/certificate.js';
import { parseSession } from '../src/parser/index.js';
import { verifyChain } from '../src/chain/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const START_HOOK = path.join(HERE, '..', 'bin', 'hook-session-start.js');

// ---------- transcript fixtures ----------

function line(obj) { return JSON.stringify(obj); }

let msgSeq = 0;
function assistant(sessionId, model, content, extra = {}) {
  msgSeq++;
  return line({
    type: 'assistant',
    sessionId,
    version: '3.0.1',
    timestamp: `2026-10-22T12:00:${String(msgSeq % 60).padStart(2, '0')}.000Z`,
    ...extra,
    message: {
      id: `msg-${msgSeq}`,
      role: 'assistant',
      model,
      content,
      usage: { input_tokens: 10, output_tokens: 5 },
      ...(extra.message || {})
    }
  });
}

function toolResult(sessionId, toolUseId, text = 'ok') {
  return line({
    type: 'user',
    sessionId,
    version: '3.0.1',
    timestamp: '2026-10-22T12:01:00.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] }
  });
}

function userText(sessionId, text = 'go') {
  return line({
    type: 'user',
    sessionId,
    version: '3.0.1',
    timestamp: '2026-10-22T11:59:59.000Z',
    message: { role: 'user', content: text }
  });
}

/** A Claude-shaped session: text, thinking, one tool call and its result. */
function claudeSession(sessionId, model = 'claude-test-1') {
  return [
    userText(sessionId),
    assistant(sessionId, model, [
      { type: 'thinking', thinking: 'the port is in the config; read it', signature: 'sig' }
    ]),
    assistant(sessionId, model, [{ type: 'text', text: 'Reading the config.' }]),
    assistant(sessionId, model, [
      { type: 'tool_use', id: `tu-${sessionId}`, name: 'Read', input: { file_path: '/repo/config/app.json' } }
    ]),
    toolResult(sessionId, `tu-${sessionId}`, '{"port": 8080}'),
    assistant(sessionId, model, [{ type: 'text', text: 'Port 8080.' }])
  ].join('\n') + '\n';
}

function measure(text) {
  return measureCloseCertificate(parseSession(text), text);
}

/** The per-model entry for one model id (byModel is a list, never a keyed object). */
function forModel(cert, id) {
  return cert.byModel.find(e => e.model === id);
}

/**
 * Snapshot of the shared builtins a transcript-controlled key could reach:
 * a plain-object lookup of "__proto__" lands on Object.prototype,
 * "constructor" on Object, "toString" / "hasOwnProperty" on functions.
 */
function builtinsSnapshot() {
  const targets = {
    'Object.prototype': Object.prototype,
    Object,
    'Object.prototype.toString': Object.prototype.toString,
    'Object.prototype.hasOwnProperty': Object.prototype.hasOwnProperty,
    'Function.prototype': Function.prototype
  };
  const out = {};
  for (const [name, t] of Object.entries(targets)) out[name] = Reflect.ownKeys(t).map(String).sort();
  return out;
}

const HOSTILE_MODEL_IDS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];

function hostileSession(sessionId, model) {
  return [
    userText(sessionId),
    assistant(sessionId, model, [{ type: 'thinking', thinking: 'plan it' }]),
    assistant(sessionId, model, [{ type: 'text', text: 'running' }]),
    assistant(sessionId, model, [{ type: 'tool_use', id: `tu-${sessionId}`, name: 'Bash', input: { command: 'ls' } }]),
    toolResult(sessionId, `tu-${sessionId}`)
  ].join('\n') + '\n';
}

// ---------- 1. the open half ----------

describe('reach certificate, open half: what is known at open, never a rung', () => {
  const harness = { name: 'claude-code', basis: 'inferred', evidence: ['session_id'], schema: 'harness/1' };

  it('states model and runtime with their basis, and leaves the rung not yet measured', () => {
    const cert = buildOpenCertificate({ session_id: 's', model: 'claude-opus-5-5' }, harness);
    assert.equal(cert.schema, REACH_SCHEMA);
    assert.equal(cert.phase, 'open');
    assert.deepEqual(cert.model, { id: 'claude-opus-5-5', basis: 'harness-payload' });
    assert.equal(cert.runtime.harness, 'claude-code');
    assert.equal(cert.runtime.basis, 'inferred', 'the harness basis travels with the name');
    assert.equal(cert.deepestRecorded, NOT_YET_MEASURED);
    assert.equal(cert.rungs, NOT_YET_MEASURED);
    assert.equal(cert.measuredOn, 'close');
  });

  it('accepts an object-shaped model ({ id }) the way some harness payloads send it', () => {
    const cert = buildOpenCertificate({ model: { id: 'glm-5.3-flash:cloud', display_name: 'GLM' } }, harness);
    assert.equal(cert.model.id, 'glm-5.3-flash:cloud');
  });

  it('records an absent model as unrecorded, never a guess and never empty', () => {
    const cert = buildOpenCertificate({ session_id: 's' }, harness);
    assert.deepEqual(cert.model, { id: UNRECORDED, basis: 'none' });
    const blank = buildOpenCertificate({ model: '   ' }, harness);
    assert.equal(blank.model.id, UNRECORDED);
  });

  it('records an absent harness as unrecorded', () => {
    const cert = buildOpenCertificate({}, null);
    assert.equal(cert.runtime.harness, UNRECORDED);
    assert.equal(cert.runtime.basis, 'unknown');
  });

  it('ignores any rung the payload declares: an open certificate never states one', () => {
    for (const claim of [{ reach: 'R6' }, { deepestRung: 'R4' }, { logprobs: true }, { rungs: { R4: 'recorded' } }]) {
      const cert = buildOpenCertificate({ session_id: 's', ...claim }, harness);
      assert.equal(cert.deepestRecorded, NOT_YET_MEASURED, `declared ${JSON.stringify(claim)} must not move it`);
      assert.equal(checkCertificate(cert).ok, true);
    }
  });

  it('caps a hostile model id so it cannot bloat the entry', () => {
    const cert = buildOpenCertificate({ model: 'x'.repeat(5000) }, harness);
    assert.equal(cert.model.id, 'x'.repeat(128), 'capped, not dropped');
  });
});

// ---------- 2. the close half, measured ----------

describe('reach certificate, close half: measured from what came back and what was kept', () => {
  it('a Claude-shaped session: R1 and R3 recorded, R0 and R2 observed, R4 to R6 unrecorded', () => {
    const cert = measure(claudeSession('s-claude'));
    assert.equal(cert.schema, REACH_SCHEMA);
    assert.equal(cert.phase, 'close');
    assert.equal(cert.model.id, 'claude-test-1');
    assert.equal(cert.model.basis, 'transcript-messages');

    assert.deepEqual(cert.rungs.R0, { status: 'observed', observed: 2 });
    assert.deepEqual(cert.rungs.R1, { status: 'recorded', observed: 1, recorded: 1, field: 'ran' });
    assert.deepEqual(cert.rungs.R2, { status: 'observed', observed: 1 });
    assert.deepEqual(cert.rungs.R3, { status: 'recorded', observed: 1, recorded: 1, field: 'session.thinkingBlocks' });
    for (const r of ['R4', 'R5', 'R6']) {
      assert.deepEqual(cert.rungs[r], { status: UNRECORDED }, `${r}: absence carries no count`);
    }
    assert.equal(cert.deepestRecorded, 'R3');
    assert.equal(cert.deepestObserved, 'R3');
    assert.equal(checkCertificate(cert).ok, true, JSON.stringify(checkCertificate(cert).problems));
  });

  it('absence reads as unrecorded, never as zero: no rung ever carries a count of 0', () => {
    const text = [userText('s-empty'), assistant('s-empty', 'm', [{ type: 'text', text: 'hello' }])].join('\n');
    const cert = measure(text);
    for (const r of RUNGS) {
      const entry = cert.rungs[r];
      for (const k of ['observed', 'recorded']) {
        assert.notEqual(entry[k], 0, `${r}.${k} must be absent, not 0`);
      }
    }
    assert.deepEqual(cert.rungs.R1, { status: UNRECORDED });
    assert.deepEqual(cert.rungs.R3, { status: UNRECORDED });
    assert.equal(cert.deepestRecorded, UNRECORDED, 'nothing recorded per item: unrecorded, not "R0" and not null');
    assert.equal(cert.deepestObserved, 'R0');
  });

  it('a transcript with no assistant model records the model as unrecorded', () => {
    const cert = measure(userText('s-nomodel') + '\n');
    assert.equal(cert.model.id, UNRECORDED);
    assert.equal(cert.deepestRecorded, UNRECORDED);
    assert.equal(cert.deepestObserved, UNRECORDED);
  });

  it('the V3-01 silent drop: logprobs requested, field absent, R4 stays unrecorded', () => {
    // The request side says logprobs; the response side carries none: a
    // request-only line (dropped, it has no message), a request echo beside
    // the message, a null and an empty array on the message itself. None of
    // them may count. The line-level case is pinned separately below.
    const text = [
      userText('s-drop'),
      line({ type: 'request', sessionId: 's-drop', options: { logprobs: true, top_logprobs: 3 } }),
      assistant('s-drop', 'glm-5.3-flash:cloud', [{ type: 'text', text: 'port 8080' }],
        { requested: { logprobs: true }, message: { logprobs: null } }),
      assistant('s-drop', 'glm-5.3-flash:cloud', [{ type: 'text', text: 'done' }],
        { message: { logprobs: [] } })
    ].join('\n');
    const cert = measure(text);
    assert.deepEqual(cert.rungs.R4, { status: UNRECORDED }, 'a request, a null and an empty array are not R4');
  });

  it('a logprobs field on the transcript LINE, outside the message, is not read as R4', () => {
    // Line-level: response or request echo cannot be told apart from the
    // shape, so it is never read. Only the message and its content items are.
    const text = [
      userText('s-linelp'),
      assistant('s-linelp', 'm', [{ type: 'text', text: '8080' }],
        { logprobs: [{ token: '80', logprob: -0.01 }] })
    ].join('\n');
    const cert = measure(text);
    assert.deepEqual(cert.rungs.R4, { status: UNRECORDED });
    assert.equal(cert.deepestObserved, 'R0');
  });

  it('logprobs that actually came back read as observed R4, and still not as recorded', () => {
    const text = [
      userText('s-lp'),
      assistant('s-lp', 'qwen2.5:7b', [{ type: 'text', text: '8080' }],
        { message: { logprobs: [{ token: '80', logprob: -0.01, top_logprobs: [] }] } })
    ].join('\n');
    const cert = measure(text);
    assert.deepEqual(cert.rungs.R4, { status: 'observed', observed: 1 });
    assert.equal(cert.deepestObserved, 'R4');
    assert.equal(cert.deepestRecorded, UNRECORDED,
      'this build keeps no per-token record; observing R4 is not recording it');
  });

  it('per model: a two-model session states each model\'s own reach', () => {
    const text = [
      userText('s-two'),
      assistant('s-two', 'model-a', [{ type: 'thinking', thinking: 'plan' }]),
      assistant('s-two', 'model-a', [{ type: 'tool_use', id: 'tu-a', name: 'Bash', input: { command: 'ls' } }]),
      toolResult('s-two', 'tu-a'),
      assistant('s-two', 'model-b', [{ type: 'text', text: 'summary' }])
    ].join('\n');
    const cert = measure(text);
    assert.deepEqual(cert.model.models, ['model-a', 'model-b']);
    assert.deepEqual(cert.byModel.map(e => e.model), ['model-a', 'model-b'], 'one entry per model, sorted');
    assert.equal(forModel(cert, 'model-a').deepestRecorded, 'R3');
    assert.equal(forModel(cert, 'model-b').deepestRecorded, UNRECORDED);
    assert.equal(forModel(cert, 'model-b').deepestObserved, 'R0');
    assert.deepEqual(forModel(cert, 'model-b').rungs.R3, { status: UNRECORDED });
    assert.equal(forModel(cert, 'model-a').rungs.R2.status, 'observed', 'a tool result is attributed to the model that called it');
  });

  it('a two-model session never pairs one model\'s id with the session\'s deepest rung', () => {
    // Review F2: model.id was the LAST model, deepestRecorded the session
    // union, so "model-b, R3" read as model-b recorded to R3. It was not.
    const text = [
      userText('s-pair'),
      assistant('s-pair', 'model-a', [{ type: 'thinking', thinking: 'plan' }]),
      assistant('s-pair', 'model-b', [{ type: 'text', text: 'summary' }])
    ].join('\n');
    const cert = measure(text);
    assert.equal(cert.deepestRecorded, 'R3', 'the session-level rung is the union');
    assert.equal(cert.model.id, MULTIPLE_MODELS, 'with more than one model, no single id stands beside it');
    assert.equal(cert.model.lastSeen, 'model-b', 'the last model is still stated, under a name that says what it is');
    assert.equal(checkCertificate(cert).ok, true, JSON.stringify(checkCertificate(cert).problems));

    const misleading = structuredClone(cert);
    misleading.model.id = 'model-b';
    const res = checkCertificate(misleading);
    assert.equal(res.ok, false);
    assert.ok(res.problems.some(p => /model\.id/.test(p)), res.problems.join('; '));

    const single = measure(claudeSession('s-single'));
    assert.equal(single.model.id, 'claude-test-1', 'one model: the id and the rung belong to it');
    assert.equal(single.model.lastSeen, 'claude-test-1');
  });

  it('caps hostile model ids and harness version on the close half too', () => {
    // Review F6: cleanId capped the open half only; the close half put raw
    // transcript strings into model.models and the per-model entries.
    const big = 'y'.repeat(5000);
    // The parser takes the version from the first line that has one.
    const text = [
      assistant('s-bigclose', big, [{ type: 'text', text: 'hi' }], { version: 'v'.repeat(5000) })
    ].join('\n');
    const cert = measure(text);
    assert.deepEqual(cert.model.models, ['y'.repeat(128)]);
    assert.equal(cert.model.id, 'y'.repeat(128));
    assert.deepEqual(cert.byModel.map(e => e.model), ['y'.repeat(128)]);
    assert.equal(cert.runtime.harnessVersion, 'v'.repeat(128));
    assert.ok(JSON.stringify(cert).length < 4096, 'the certificate stays small whatever the transcript wrote');
    assert.equal(checkCertificate(cert).ok, true, JSON.stringify(checkCertificate(cert).problems));
  });

  it('the recorded counts re-derive from the receipt itself', () => {
    const text = claudeSession('s-rederive');
    const summary = parseSession(text);
    const cert = measureCloseCertificate(summary, text);
    const receipt = { ...summary, reach: cert };
    assert.equal(checkCertificate(cert, receipt).ok, true);
    assert.equal(cert.rungs.R1.recorded, receipt.ran.length);
    assert.equal(cert.rungs.R3.recorded, receipt.session.thinkingBlocks.length);
  });
});

// ---------- 3. the ceiling ----------

describe('reach certificate, the ceiling: never deeper than observed', () => {
  it('a receipt claiming thinking records the transcript never carried cannot raise the rung', () => {
    const text = [userText('s-forge'), assistant('s-forge', 'm', [{ type: 'text', text: 'hi' }])].join('\n');
    const summary = parseSession(text);
    summary.session.thinkingBlocks = [{ turn: 1, digest: 'deadbeefdeadbeef', length: 99 }];
    summary.ran = [{ tool: 'Bash', id: 'forged', paramsDigest: '0'.repeat(16) }];
    const cert = measureCloseCertificate(summary, text);
    assert.deepEqual(cert.rungs.R3, { status: UNRECORDED });
    assert.deepEqual(cert.rungs.R1, { status: UNRECORDED });
    assert.equal(cert.deepestRecorded, UNRECORDED);
  });

  it('a transcript carrying a rung the receipt never kept is observed, not recorded', () => {
    const text = claudeSession('s-unkept');
    const summary = parseSession(text);
    delete summary.session.thinkingBlocks;
    const cert = measureCloseCertificate(summary, text);
    assert.deepEqual(cert.rungs.R3, { status: 'observed', observed: 1 });
    assert.equal(cert.deepestRecorded, 'R1');
  });

  it('declared reach anywhere in the transcript is ignored', () => {
    const text = [
      userText('s-declare'),
      line({ type: 'system', sessionId: 's-declare', reach: 'R6', deepestRecorded: 'R6', rungs: { R5: 'recorded' } }),
      assistant('s-declare', 'm', [{ type: 'text', text: 'I am recording my activations.' }],
        { reach: 'R5', message: { activations: [] } })
    ].join('\n');
    const cert = measure(text);
    assert.equal(cert.deepestRecorded, UNRECORDED);
    assert.equal(cert.deepestObserved, 'R0');
    assert.deepEqual(cert.rungs.R5, { status: UNRECORDED });
    assert.deepEqual(cert.rungs.R6, { status: UNRECORDED });
  });

  it('checkCertificate rejects a forged certificate that states a deeper rung than it holds', () => {
    const cert = measure(claudeSession('s-check'));
    const forged = structuredClone(cert);
    forged.deepestRecorded = 'R4';
    const res = checkCertificate(forged);
    assert.equal(res.ok, false);
    assert.ok(res.problems.some(p => /deepestRecorded/.test(p)), res.problems.join('; '));

    const deeperThanObserved = structuredClone(cert);
    deeperThanObserved.rungs.R4 = { status: 'recorded', recorded: 1, field: 'x' };
    deeperThanObserved.deepestRecorded = 'R4';
    assert.equal(checkCertificate(deeperThanObserved).ok, false, 'recorded without observed is an overclaim');
  });

  it('checkCertificate rejects a zero count and an open certificate that states a rung', () => {
    const cert = measure(claudeSession('s-zero'));
    const zero = structuredClone(cert);
    zero.rungs.R4 = { status: UNRECORDED, observed: 0 };
    assert.equal(checkCertificate(zero).ok, false, 'a zero must never stand in for absence');

    const open = buildOpenCertificate({ model: 'm' }, null);
    const openClaims = { ...open, deepestRecorded: 'R3' };
    assert.equal(checkCertificate(openClaims).ok, false);
  });

  it('checkCertificate rejects a per-model deepestObserved its rungs do not back', () => {
    // Review F3: the per-model loop checked deepestRecorded only.
    const cert = measure(claudeSession('s-perobs'));
    const forged = structuredClone(cert);
    forModel(forged, 'claude-test-1').deepestObserved = 'R6';
    const res = checkCertificate(forged);
    assert.equal(res.ok, false, 'a per-model overclaim must not pass');
    assert.ok(res.problems.some(p => /deepestObserved/.test(p) && /claude-test-1/.test(p)), res.problems.join('; '));
  });

  it('a failed measurement is marked failed, never "unrecorded", and is refused for that reason', () => {
    // Review F4: "unrecorded" on a measurement that never ran is the zero-for-
    // absence error at session level. Review F8: no exception text on the
    // chain, only a code and a digest.
    const err = new TypeError('boom at /home/someone/secret-project token=abc123');
    const failed = failedCloseCertificate(err);
    assert.equal(failed.schema, REACH_SCHEMA);
    assert.equal(failed.phase, 'close');
    assert.equal(failed.deepestRecorded, MEASUREMENT_FAILED);
    assert.notEqual(failed.deepestRecorded, UNRECORDED);
    assert.equal(failed.deepestObserved, MEASUREMENT_FAILED);
    assert.equal(failed.rungs, MEASUREMENT_FAILED);
    assert.equal(failed.failed.code, 'TypeError');
    assert.match(failed.failed.digest, /^[0-9a-f]{64}$/);
    const onChain = JSON.stringify(failed);
    for (const leak of ['boom', 'secret-project', 'abc123', '/home/']) {
      assert.ok(!onChain.includes(leak), `exception text must not reach the chain: ${leak}`);
    }
    const res = checkCertificate(failed);
    assert.equal(res.ok, false);
    assert.ok(res.problems.some(p => /measurement failed/.test(p)), res.problems.join('; '));

    // A hostile error name or code is not copied either.
    const odd = failedCloseCertificate({ name: 'x'.repeat(500) + '<script>', code: 'E BAD\nCODE', message: 'm' });
    assert.equal(odd.failed.code, 'Error');
    assert.equal(failedCloseCertificate('a thrown string').failed.code, 'Error');
    assert.equal(failedCloseCertificate(Object.assign(new Error('x'), { code: 'ENOENT' })).failed.code, 'ENOENT');
  });

  it('checkCertificate rejects recorded counts the receipt does not back', () => {
    const text = claudeSession('s-backing');
    const summary = parseSession(text);
    const cert = measureCloseCertificate(summary, text);
    const receipt = { ...summary, ran: [], reach: cert };
    const res = checkCertificate(cert, receipt);
    assert.equal(res.ok, false);
    assert.ok(res.problems.some(p => /R1/.test(p)), res.problems.join('; '));
  });

  it('an open reference is attached from the chain, not from the transcript', () => {
    const cert = measure(claudeSession('s-ref'));
    const entries = [
      { seq: 0, hash: 'a'.repeat(64), payload: { type: 'session-open', sessionId: 'other', harness: { name: 'x', basis: 'declared' } } },
      { seq: 1, hash: 'b'.repeat(64), payload: { type: 'session-open', sessionId: 's-ref', harness: { name: 'claude-code', basis: 'inferred' } } },
      { seq: 2, hash: 'c'.repeat(64), payload: { type: 'session-open', sessionId: 's-ref', harness: { name: 'claude-code', basis: 'inferred' } } }
    ];
    const linked = attachOpenReference(cert, entries, 's-ref');
    assert.deepEqual(linked.opened, { seq: 2, hash: 'c'.repeat(64) }, 'the latest open for this session');
    assert.equal(linked.runtime.harness, 'claude-code');
    assert.equal(linked.runtime.basis, 'inferred');

    const orphan = attachOpenReference(cert, entries, 's-none');
    assert.equal(orphan.opened, UNRECORDED);
    assert.equal(orphan.runtime.harness, UNRECORDED);
  });
});

// ---------- 3b. hostile model ids (review F1) ----------

describe('reach certificate, hostile model ids: a transcript string is never an object key', () => {
  for (const id of HOSTILE_MODEL_IDS) {
    it(`a model named "${id}" is measured like any other and leaves the builtins untouched`, () => {
      const before = builtinsSnapshot();
      const text = hostileSession(`s-hostile-${id}`, id);
      const summary = parseSession(text);
      const cert = measureCloseCertificate(summary, text);
      assert.deepEqual(builtinsSnapshot(), before, 'no transcript string may write to a shared builtin');
      assert.equal(Object.prototype.R0, undefined);
      assert.equal(Object.prototype.inputTokens, undefined);

      // The model is stated, not silently dropped.
      assert.deepEqual(cert.model.models, [id]);
      assert.equal(cert.model.id, id);
      const entry = forModel(cert, id);
      assert.ok(entry, `byModel must carry an entry for "${id}"`);
      assert.equal(entry.deepestRecorded, 'R3');
      assert.equal(entry.rungs.R2.status, 'observed', 'the tool result is attributed to it');
      assert.equal(cert.deepestRecorded, 'R3');
      assert.equal(checkCertificate(cert, { ...summary, reach: cert }).ok, true);

      // The same id survives a round trip through JSON, which is how a reader gets it.
      const back = JSON.parse(JSON.stringify(cert));
      assert.deepEqual(back.byModel.map(e => e.model), [id]);
      assert.equal(checkCertificate(back).ok, true);
      assert.deepEqual(builtinsSnapshot(), before);
    });
  }

  it('the parser\'s cost.byModel takes the same ids without touching the builtins', () => {
    for (const id of HOSTILE_MODEL_IDS) {
      const before = builtinsSnapshot();
      const summary = parseSession(hostileSession(`s-cost-${id}`, id));
      assert.deepEqual(builtinsSnapshot(), before, `cost.byModel must not write through "${id}"`);
      assert.ok(Object.prototype.hasOwnProperty.call(summary.cost.byModel, id), `cost.byModel must own a "${id}" bucket`);
      assert.deepEqual(Object.keys(summary.cost.byModel), [id]);
      assert.equal(summary.cost.byModel[id].messages, 3);
      assert.equal(summary.cost.byModel[id].inputTokens, 30);
    }
  });

  it('checkCertificate refuses a keyed byModel and reads a hostile one without writing anywhere', () => {
    const before = builtinsSnapshot();
    const cert = measure(claudeSession('s-keyed'));
    const keyed = JSON.parse(JSON.stringify({ ...cert, byModel: {} }).replace(
      '"byModel":{}',
      '"byModel":{"__proto__":{"deepestRecorded":"R6","rungs":{}},"constructor":{"deepestRecorded":"R6"}}'
    ));
    const res = checkCertificate(keyed);
    assert.equal(res.ok, false);
    assert.ok(res.problems.some(p => /byModel is not a list/.test(p)), res.problems.join('; '));
    assert.deepEqual(builtinsSnapshot(), before);
  });
});

// ---------- 4. chain fidelity (eval E2) ----------

describe('reach certificate on the chain (eval E2)', () => {
  let home;
  let ingestSession;
  let loadChain;

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-reach-'));
    process.env.LOTOR_HOME = home;
    ({ ingestSession } = await import('../src/ingest/index.js'));
    ({ loadChain } = await import('../src/store/index.js'));
  });

  after(() => {
    delete process.env.LOTOR_HOME;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  });

  function publicKey() {
    return crypto.createPublicKey(fs.readFileSync(path.join(home, 'keys', 'chain.pub'), 'utf-8'));
  }

  it('the session receipt carries a close certificate that checks against the receipt', () => {
    const result = ingestSession(claudeSession('s-chain'));
    assert.equal(result.skipped, false);
    const reach = result.entry.payload.reach;
    assert.ok(reach, 'session receipt must carry reach');
    assert.equal(reach.phase, 'close');
    assert.equal(reach.deepestRecorded, 'R3');
    assert.equal(reach.opened, UNRECORDED, 'no open on this chain for the session: says so');
    assert.equal(checkCertificate(reach, result.entry.payload).ok, true);
  });

  it('the certificate verifies on the chain, and tampering with it breaks verification', () => {
    const entries = loadChain(home);
    assert.equal(verifyChain(entries, publicKey()).ok, true);

    const target = entries.findIndex(e => e.payload?.reach?.phase === 'close');
    assert.ok(target >= 0);

    for (const tamper of [
      p => { p.reach.deepestRecorded = 'R4'; },
      p => { p.reach.rungs.R4 = { status: 'recorded', observed: 1, recorded: 1, field: 'x' }; },
      p => { p.reach.model.id = 'some-other-model'; },
      p => { delete p.reach; }
    ]) {
      const copy = structuredClone(entries);
      tamper(copy[target].payload);
      const res = verifyChain(copy, publicKey());
      assert.equal(res.ok, false, 'an edited certificate must not verify');
      assert.equal(res.brokenAt, target);
    }
  });

  it('a per-model entry for a model named "__proto__" is inside the hash: tampering with it breaks verification', () => {
    // The chain canonicaliser rebuilds objects with plain assignment, which
    // turns an own "__proto__" KEY into a prototype and drops it from the
    // hash. byModel is a list, so a model id is a value and always hashed.
    const result = ingestSession(hostileSession('s-chain-proto', '__proto__'));
    assert.equal(result.skipped, false);
    const entries = loadChain(home);
    assert.equal(verifyChain(entries, publicKey()).ok, true);
    const target = entries.findIndex(e => e.payload?.session?.id === 's-chain-proto');
    assert.ok(target >= 0);
    const copy = structuredClone(entries);
    const entry = copy[target].payload.reach.byModel.find(e => e.model === '__proto__');
    assert.ok(entry, 'the hostile model is on the chain');
    entry.deepestObserved = 'R6';
    const res = verifyChain(copy, publicKey());
    assert.equal(res.ok, false, 'an edit under a hostile model id must not verify');
    assert.equal(res.brokenAt, target);
  });

  it('the close certificate links to the session\'s open receipt on the same chain', async () => {
    // Write an open for the session through the real store, the way the
    // SessionStart hook does, then ingest its transcript.
    const { createStore } = await import('../src/store/index.js');
    const store = createStore(home);
    const open = store.appendReceiptGuarded(() => ({
      type: 'session-open',
      sessionId: 's-linked',
      harness: { name: 'claude-code', basis: 'inferred', schema: 'harness/1' },
      timestamp: Date.now()
    }));
    const result = ingestSession(claudeSession('s-linked'));
    const reach = result.entry.payload.reach;
    assert.deepEqual(reach.opened, { seq: open.seq, hash: open.hash });
    assert.equal(reach.runtime.harness, 'claude-code');
    assert.equal(verifyChain(loadChain(home), publicKey()).ok, true);
  });

  it('a grown transcript gets a fresh certificate on its subsession receipt', () => {
    const grown = claudeSession('s-chain') + [
      assistant('s-chain', 'claude-test-1', [{ type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'ls' } }]),
      toolResult('s-chain', 'tu-2')
    ].join('\n') + '\n';
    const result = ingestSession(grown);
    assert.equal(result.subsession, 1);
    assert.equal(result.entry.payload.reach.rungs.R1.recorded, 2);
  });
});

// ---------- 5. the open half on the chain, through the real hook ----------

/**
 * The SessionStart hook is core (bin/hook-*). Its two-line wiring is staged
 * as proposals/v3-02-session-open-reach.patch for the signing sitting rather
 * than applied by the lane. Until it is applied this test is marked todo, so
 * it reports without failing the suite. Remove the todo when the patch lands;
 * it must then pass.
 */
function runStart(home, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [START_HOOK], {
      env: { ...process.env, LOTOR_HARNESS: undefined, LOTOR_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
    child.stdin.end(stdin);
  });
}

describe('reach certificate on the session-open receipt (hook wiring)', () => {
  it('session-open carries an open certificate that verifies on the chain',
    { todo: 'applied at the signing sitting: proposals/v3-02-session-open-reach.patch' },
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-reach-open-'));
      try {
        const res = await runStart(home, JSON.stringify({
          session_id: 's-open', source: 'startup', cwd: '/repo',
          transcript_path: '/tmp/t.jsonl', model: 'claude-opus-5-5', reach: 'R6'
        }));
        assert.equal(res.code, 0);
        const { loadChain } = await import('../src/store/index.js');
        const entries = loadChain(home);
        const open = entries.find(e => e.payload?.type === 'session-open');
        const reach = open.payload.reach;
        assert.ok(reach, 'session-open must carry reach');
        assert.equal(reach.phase, 'open');
        assert.equal(reach.model.id, 'claude-opus-5-5');
        assert.equal(reach.deepestRecorded, NOT_YET_MEASURED, 'the declared R6 is ignored');
        assert.equal(checkCertificate(reach).ok, true);
        const pub = crypto.createPublicKey(fs.readFileSync(path.join(home, 'keys', 'chain.pub'), 'utf-8'));
        assert.equal(verifyChain(entries, pub).ok, true);
        const copy = structuredClone(entries);
        copy[0].payload.reach.model.id = 'other';
        assert.equal(verifyChain(copy, pub).ok, false);
      } finally {
        try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
      }
    });
});
