import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * V3-04, rung R3: reasoning trace chained per step.
 *
 * Synthetic fixtures only. Every reasoning string carries a canary so the
 * leak test can prove no reasoning text reaches the chain, the cursor, or
 * the sidecar. LOTOR_HOME points at a throwaway dir before any import.
 */

let home;
let mod;
let createStore;
let ingestSession;
let tmp;

const sha = t => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const L = o => JSON.stringify(o) + '\n';
const CANARY = 'CANARY-7f3e-REASONING-TEXT';

function assistant(id, content, extra = {}) {
  return L({ type: 'assistant', sessionId: 'sess-1', message: { id, role: 'assistant', model: 'synthetic', content }, ...extra });
}
function toolResult(toolUseId) {
  return L({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] } });
}
function human(text) {
  return L({ type: 'user', message: { role: 'user', content: text } });
}
function thinking(text, signature) {
  return signature === undefined ? { type: 'thinking', thinking: text } : { type: 'thinking', thinking: text, signature };
}
function toolUse(id, name = 'Read', input = { file_path: '/x' }) {
  return { type: 'tool_use', id, name, input };
}

function newTranscript(name) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, '');
  return p;
}
function append(p, text) { fs.appendFileSync(p, text); }
function hookPayload(transcriptPath, toolUseId, extra = {}) {
  return { session_id: extra.session_id || 'sess-1', transcript_path: transcriptPath, tool_use_id: toolUseId, tool_name: 'Read', tool_input: { file_path: '/x' }, ...extra };
}
function chainSteps(sessionId = 'sess-1') {
  return createStore(home).entries.filter(e => e.payload?.type === 'reasoning-step' && e.payload.sessionId === sessionId);
}

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-r3-home-'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-r3-tx-'));
  process.env.LOTOR_HOME = home;
  mod = await import('../src/reasoning/index.js');
  ({ createStore } = await import('../src/store/index.js'));
  ({ ingestSession } = await import('../src/ingest/index.js'));
});

after(() => {
  delete process.env.LOTOR_HOME;
  for (const d of [home, tmp]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

describe('R3 kinds, read from what landed', () => {
  const kindOf = blocks => mod.summarizeRows(blocks.map(mod.classifyBlock).filter(Boolean)).kind;

  it('readable thinking without a signature is thinking-unsigned', () => {
    assert.strictEqual(kindOf([thinking(`${CANARY} a`)]), 'thinking-unsigned');
  });
  it('readable thinking with a vendor signature is thinking-signed (fidelity not asserted)', () => {
    assert.strictEqual(kindOf([thinking(`${CANARY} b`, 'sig-abc')]), 'thinking-signed');
  });
  it('signature with empty text is thinking-redacted, not absent', () => {
    assert.strictEqual(kindOf([thinking('', 'sig-only')]), 'thinking-redacted');
    assert.strictEqual(kindOf([{ type: 'redacted_thinking', data: 'opaque' }]), 'thinking-redacted');
  });
  it('<think> markers in visible text are text-inline-reasoning (R3 leaked into R0)', () => {
    assert.strictEqual(kindOf([{ type: 'text', text: `${CANARY} reasoning</think> answer` }]), 'text-inline-reasoning');
  });
  it('plain visible text is text-only; nothing is none', () => {
    assert.strictEqual(kindOf([{ type: 'text', text: `${CANARY} hi` }]), 'text-only');
    assert.strictEqual(kindOf([]), 'none');
    assert.strictEqual(kindOf([thinking('')]), 'none', 'unsigned empty thinking exposes nothing');
  });
  it('a mixed step reports the deepest kind and lists every kind present', () => {
    const s = mod.summarizeRows([thinking('', 'sig'), { type: 'text', text: 'x' }, thinking('y', 'sig')].map(mod.classifyBlock));
    assert.strictEqual(s.kind, 'thinking-signed');
    assert.deepStrictEqual(s.kinds, ['thinking-signed', 'thinking-redacted', 'text-only']);
  });
});

describe('per-step binding through the hook entry point', () => {
  it('reasoning between action 1 and action 2 lands on action 2, not 1', () => {
    const tx = newTranscript('bind.jsonl');
    const a = `${CANARY} before-one`;
    const b = `${CANARY} before-two`;
    append(tx, assistant('m1', [thinking(a, 'sig1')]));
    append(tx, assistant('m1', [toolUse('tu1')]));
    const r1 = mod.recordReasoningStep(hookPayload(tx, 'tu1'), { home });
    assert.ok(r1.ok, r1.reason);
    append(tx, toolResult('tu1'));
    append(tx, assistant('m2', [thinking(b, 'sig2')]));
    append(tx, assistant('m2', [{ type: 'text', text: `${CANARY} visible` }]));
    append(tx, assistant('m2', [toolUse('tu2')]));
    const r2 = mod.recordReasoningStep(hookPayload(tx, 'tu2'), { home });
    assert.ok(r2.ok, r2.reason);

    const p1 = r1.entry.payload;
    const p2 = r2.entry.payload;
    assert.strictEqual(p1.status, 'recorded');
    assert.deepStrictEqual(p1.digests.map(d => d.sha256), [sha(a)]);
    assert.deepStrictEqual(p2.digests.map(d => d.sha256), [sha(b), sha(`${CANARY} visible`)]);
    assert.strictEqual(p2.kind, 'thinking-signed');
    assert.ok(!p2.digests.some(d => d.sha256 === sha(a)), 'action 1 reasoning must not repeat on action 2');
    assert.ok(p2.transcript.fromOffset > 0 && p2.transcript.fromOffset === p1.transcript.toOffset,
      'second hook reads from the recorded offset, not from byte 0');
  });

  it('parallel tool calls in one message share the segment, with a batch index', () => {
    const tx = newTranscript('batch.jsonl');
    append(tx, assistant('m1', [thinking(`${CANARY} plan`)]));
    append(tx, assistant('m1', [toolUse('pa')]));
    append(tx, assistant('m1', [toolUse('pb')]));
    const ra = mod.recordReasoningStep(hookPayload(tx, 'pa', { session_id: 'sess-batch' }), { home }).entry.payload;
    const rb = mod.recordReasoningStep(hookPayload(tx, 'pb', { session_id: 'sess-batch' }), { home }).entry.payload;
    assert.strictEqual(ra.segmentDigest, rb.segmentDigest);
    assert.strictEqual(ra.batchIndex, 0);
    assert.strictEqual(rb.batchIndex, 1);
    assert.strictEqual(rb.kind, 'thinking-unsigned');
  });

  it('a human prompt closes the open segment; turn-end text is not credited to the next action', () => {
    const tx = newTranscript('turn.jsonl');
    append(tx, assistant('m1', [{ type: 'text', text: `${CANARY} final answer` }]));
    append(tx, human('next question'));
    append(tx, assistant('m2', [toolUse('t1')]));
    const p = mod.recordReasoningStep(hookPayload(tx, 't1', { session_id: 'sess-turn' }), { home }).entry.payload;
    assert.strictEqual(p.kind, 'none');
    assert.strictEqual(p.status, 'recorded');
  });

  it('without tool_use_id, falls back to tool name + canonical input', () => {
    const tx = newTranscript('fallback.jsonl');
    append(tx, assistant('m1', [thinking(`${CANARY} fb`), toolUse('fb1', 'Grep', { b: 2, a: 1 })]));
    const payload = { session_id: 'sess-fb', transcript_path: tx, tool_name: 'Grep', tool_input: { a: 1, b: 2 } };
    const p = mod.recordReasoningStep(payload, { home }).entry.payload;
    assert.strictEqual(p.status, 'recorded');
    assert.strictEqual(p.matchedBy, 'name+input');
    assert.strictEqual(p.toolUseId, 'fb1');
  });
});

describe('absence and the race are recorded as unrecorded, never as none', () => {
  it('hook fires before the tool_use line is flushed -> unrecorded; session end reconciles it as late', () => {
    const tx = newTranscript('race.jsonl');
    append(tx, assistant('m1', [thinking(`${CANARY} race`, 'sig')]));
    // tool_use line written WITHOUT its newline: a partial, unflushed line.
    const partial = JSON.stringify({ type: 'assistant', sessionId: 'sess-race', message: { id: 'm1', role: 'assistant', content: [toolUse('tr1')] } });
    append(tx, partial.slice(0, 40));
    const p = mod.recordReasoningStep(hookPayload(tx, 'tr1', { session_id: 'sess-race' }), { home }).entry.payload;
    assert.strictEqual(p.status, 'unrecorded');
    assert.strictEqual(p.kind, 'unrecorded');
    assert.strictEqual(p.reason, 'tool-use-not-in-transcript');
    assert.ok(p.transcript.partialLineBytes > 0, 'the partial line is left unconsumed');

    append(tx, partial.slice(40) + '\n');
    const text = fs.readFileSync(tx, 'utf8').replace(/"sessionId":"sess-1"/g, '"sessionId":"sess-race"');
    const res = ingestSession(text);
    const r = res.entry.payload.reasoning;
    assert.strictEqual(r.schema, 'reasoning-trace/1');
    assert.strictEqual(r.steps, 1);
    assert.strictEqual(r.late, 1);
    assert.deepStrictEqual(r.kinds, { 'thinking-signed': 1 });
    const sidecar = path.join(home, 'reasoning', 'sess-race-s0.jsonl');
    assert.strictEqual(sha(fs.readFileSync(sidecar, 'utf8')), r.digest, 'sidecar bytes bind to the digest');
  });

  it('missing transcript and missing path are unrecorded with a reason', () => {
    const a = mod.recordReasoningStep(hookPayload(path.join(tmp, 'nope.jsonl'), 'x'), { home }).entry.payload;
    assert.strictEqual(a.kind, 'unrecorded');
    assert.strictEqual(a.reason, 'transcript-missing');
    const b = mod.recordReasoningStep({ session_id: 'sess-1', tool_use_id: 'x', tool_name: 'Read' }, { home }).entry.payload;
    assert.strictEqual(b.reason, 'no-transcript-path');
  });

  it('malformed lines are counted and skipped; CRLF lines parse', () => {
    const tx = newTranscript('crlf.jsonl');
    append(tx, '{not json\r\n');
    append(tx, assistant('m1', [thinking(`${CANARY} crlf`)]).replace('\n', '\r\n'));
    append(tx, assistant('m1', [toolUse('c1')]).replace('\n', '\r\n'));
    const p = mod.recordReasoningStep(hookPayload(tx, 'c1', { session_id: 'sess-crlf' }), { home }).entry.payload;
    assert.strictEqual(p.status, 'recorded');
    assert.strictEqual(p.kind, 'thinking-unsigned');
    assert.strictEqual(p.transcript.malformedLines, 1);
  });

  it('a truncated or rewritten transcript resets the cursor instead of reading garbage', () => {
    const tx = newTranscript('reset.jsonl');
    append(tx, assistant('m1', [thinking(`${CANARY} one`), toolUse('r1')]));
    mod.recordReasoningStep(hookPayload(tx, 'r1', { session_id: 'sess-reset' }), { home });
    fs.writeFileSync(tx, assistant('m9', [thinking(`${CANARY} two`), toolUse('r2')]));
    const p = mod.recordReasoningStep(hookPayload(tx, 'r2', { session_id: 'sess-reset' }), { home }).entry.payload;
    assert.ok(['transcript-truncated', 'transcript-rewritten'].includes(p.transcript.cursorReset));
    assert.strictEqual(p.status, 'recorded');
    assert.deepStrictEqual(p.digests.map(d => d.sha256), [sha(`${CANARY} two`)]);
  });

  it('a hook payload that is not JSON returns ok:false and never throws', () => {
    assert.strictEqual(mod.recordReasoningStep('{bad', { home }).ok, false);
    assert.strictEqual(mod.recordReasoningStep('', { home }).ok, false);
  });
});

describe('chain fidelity (E2) and privacy', () => {
  it('reasoning-step entries verify, and tampering with one breaks verification', () => {
    const store = createStore(home);
    assert.ok(chainSteps().length >= 2);
    assert.deepStrictEqual(store.verify(), { ok: true });
    const entries = store.entries.map(e => JSON.parse(JSON.stringify(e)));
    const i = entries.findIndex(e => e.payload?.type === 'reasoning-step' && e.payload.status === 'recorded');
    entries[i].payload.kind = 'none';
    const tamperedChainFile = path.join(home, 'receipts', 'chain.jsonl');
    const original = fs.readFileSync(tamperedChainFile, 'utf8');
    try {
      fs.writeFileSync(tamperedChainFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
      const v = createStore(home).verify();
      assert.strictEqual(v.ok, false, 'a rewritten kind must break the chain');
    } finally {
      fs.writeFileSync(tamperedChainFile, original);
    }
  });

  it('no reasoning text reaches the chain, the cursors, or the sidecar', () => {
    const files = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } };
    walk(home);
    assert.ok(files.some(f => f.endsWith('chain.jsonl')));
    assert.ok(files.some(f => f.includes(`${path.sep}cursors${path.sep}`)));
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      assert.ok(!text.includes(CANARY), `reasoning text leaked into ${path.relative(home, f)}`);
    }
  });
});
