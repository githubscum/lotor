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
    assert.strictEqual(kindOf([{ type: 'text', text: `<think>${CANARY} opening tag only` }]), 'text-inline-reasoning',
      'a bare opening tag is a leak too');
  });
  it('plain visible text is text-only; nothing is none', () => {
    assert.strictEqual(kindOf([{ type: 'text', text: `${CANARY} hi` }]), 'text-only');
    assert.strictEqual(kindOf([]), 'none');
  });
  it('an unsigned empty or blank thinking block is thinking-empty, never none', () => {
    assert.strictEqual(kindOf([thinking('')]), 'thinking-empty');
    assert.strictEqual(kindOf([thinking('  \n ')]), 'thinking-empty', 'whitespace-only: the parser counts it as a block, so must the step');
    const s = mod.summarizeRows([thinking('')].map(mod.classifyBlock));
    assert.strictEqual(s.blocks.thinkingEmpty, 1);
    assert.notStrictEqual(s.segmentDigest, 'empty');
    // Shallowest kind: visible text alongside it still reads as text-only.
    assert.strictEqual(kindOf([thinking(''), { type: 'text', text: 'x' }]), 'text-only');
  });
  it('KIND_ORDER matches the documented precedence, every adjacent pair pinned', () => {
    assert.deepStrictEqual([...mod.KIND_ORDER],
      ['thinking-unsigned', 'thinking-signed', 'thinking-redacted', 'text-inline-reasoning', 'text-only', 'thinking-empty']);
    const one = {
      'thinking-unsigned': thinking('u'),
      'thinking-signed': thinking('s', 'sig'),
      'thinking-redacted': { type: 'redacted_thinking', data: 'opaque' },
      'text-inline-reasoning': { type: 'text', text: 'a</think>b' },
      'text-only': { type: 'text', text: 'plain' },
      'thinking-empty': thinking('')
    };
    for (let i = 0; i + 1 < mod.KIND_ORDER.length; i++) {
      const deeper = mod.KIND_ORDER[i];
      const shallower = mod.KIND_ORDER[i + 1];
      // Shallower block first, so input order cannot decide the answer.
      assert.strictEqual(kindOf([one[shallower], one[deeper]]), deeper, `${deeper} must outrank ${shallower}`);
    }
  });
  it('a mixed step reports the deepest kind and lists every kind present', () => {
    const s = mod.summarizeRows([thinking('', 'sig'), { type: 'text', text: 'x' }, thinking('y', 'sig')].map(mod.classifyBlock));
    assert.strictEqual(s.kind, 'thinking-signed');
    assert.deepStrictEqual(s.kinds, ['thinking-signed', 'thinking-redacted', 'text-only']);
    // The pair the review flagged: redacted thinking plus leaked inline reasoning.
    const r = mod.summarizeRows([{ type: 'text', text: 'leak</think>' }, thinking('', 'sig')].map(mod.classifyBlock));
    assert.strictEqual(r.kind, 'thinking-redacted');
    assert.deepStrictEqual(r.kinds, ['thinking-redacted', 'text-inline-reasoning']);
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
    // The closed segment is counted, not credited: session-end shows it.
    const text = fs.readFileSync(tx, 'utf8').replace(/"sessionId":"sess-1"/g, '"sessionId":"sess-turn"');
    assert.strictEqual(mod.traceTranscript(text).unattributedBlocks, 1);
  });

  it('harness-injected user lines (system-reminder, local-command-*) do not close the segment', () => {
    // Shape as Claude Code writes them: a user line whose only text is a
    // harness wrapper, between the model's thinking and its tool_use.
    const harness = text => L({ type: 'user', sessionId: 'sess-noise', message: { role: 'user', content: [{ type: 'text', text }] } });
    const tx = newTranscript('noise.jsonl');
    const a = `${CANARY} reasoning before a reminder`;
    append(tx, assistant('m1', [thinking(a, 'sig')]));
    append(tx, harness('<system-reminder>\nThis is harness noise, not the operator.\n</system-reminder>'));
    append(tx, L({ type: 'user', sessionId: 'sess-noise', message: { role: 'user', content: '<local-command-caveat>Caveat: generated by a local command.</local-command-caveat>' } }));
    append(tx, harness('<local-command-stdout>ok</local-command-stdout>\n<local-command-stderr></local-command-stderr>'));
    append(tx, assistant('m1', [toolUse('n1')]));
    const p = mod.recordReasoningStep(hookPayload(tx, 'n1', { session_id: 'sess-noise' }), { home }).entry.payload;
    assert.strictEqual(p.status, 'recorded');
    assert.strictEqual(p.kind, 'thinking-signed', 'the reasoning survives harness noise; it is not filed as none');
    assert.deepStrictEqual(p.digests.map(d => d.sha256), [sha(a)]);
    assert.strictEqual(mod.traceTranscript(fs.readFileSync(tx, 'utf8')).unattributedBlocks, 0);
  });

  it('operator text next to a harness wrapper still closes the segment', () => {
    const tx = newTranscript('noise-plus-prompt.jsonl');
    append(tx, assistant('m1', [thinking(`${CANARY} turn one`)]));
    append(tx, L({ type: 'user', message: { role: 'user', content: [
      { type: 'text', text: '<system-reminder>noise</system-reminder>' },
      { type: 'text', text: 'actually do the other thing' }
    ] } }));
    append(tx, assistant('m2', [toolUse('n2')]));
    const p = mod.recordReasoningStep(hookPayload(tx, 'n2', { session_id: 'sess-noise-2' }), { home }).entry.payload;
    assert.strictEqual(p.kind, 'none');
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
    assert.strictEqual(p.transcript.partialLineBytes, 40, 'the partial line is left unconsumed, every byte counted');

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

  // Pins the lastNl === -1 case review S3 raised: chunk.length - (-1 + 1) is
  // chunk.length, so there is no off-by-one; this keeps it that way.
  it('a chunk with no newline at all reports every byte as partial (no off-by-one)', () => {
    const tx = newTranscript('no-newline.jsonl');
    append(tx, '{"type":"assistant","message":{"id":"m1"');
    const size = fs.statSync(tx).size;
    const p = mod.recordReasoningStep(hookPayload(tx, 'nn1', { session_id: 'sess-no-nl' }), { home }).entry.payload;
    assert.strictEqual(p.status, 'unrecorded');
    assert.strictEqual(p.transcript.bytesRead, size);
    assert.strictEqual(p.transcript.partialLineBytes, size);
    assert.strictEqual(p.transcript.toOffset, 0, 'nothing consumed');
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
    // Same byte length as before, different head: the rewrite detector fires.
    assert.strictEqual(p.transcript.cursorReset, 'transcript-rewritten');
    assert.strictEqual(p.status, 'recorded');
    assert.deepStrictEqual(p.digests.map(d => d.sha256), [sha(`${CANARY} two`)]);

    // Shorter than the recorded offset: the truncation detector fires.
    fs.writeFileSync(tx, assistant('m3', [toolUse('r3')]));
    const t = mod.recordReasoningStep(hookPayload(tx, 'r3', { session_id: 'sess-reset' }), { home }).entry.payload;
    assert.strictEqual(t.transcript.cursorReset, 'transcript-truncated');
    assert.strictEqual(t.status, 'recorded');
  });

  it('a resumed session on a new transcript path resets the cursor and never re-records a claimed step', () => {
    const tx1 = newTranscript('resume-a.jsonl');
    append(tx1, assistant('m1', [thinking(`${CANARY} first`), toolUse('rs1')]));
    mod.recordReasoningStep(hookPayload(tx1, 'rs1', { session_id: 'sess-resume' }), { home });
    const tx2 = newTranscript('resume-b.jsonl');
    append(tx2, fs.readFileSync(tx1, 'utf8'));
    append(tx2, assistant('m2', [thinking(`${CANARY} second`), toolUse('rs2')]));
    const p = mod.recordReasoningStep(hookPayload(tx2, 'rs2', { session_id: 'sess-resume' }), { home }).entry.payload;
    assert.strictEqual(p.transcript.cursorReset, 'transcript-path-changed');
    assert.strictEqual(p.status, 'recorded');
    assert.deepStrictEqual(p.digests.map(d => d.sha256), [sha(`${CANARY} second`)]);
    const again = mod.recordReasoningStep(hookPayload(tx2, 'rs1', { session_id: 'sess-resume' }), { home }).entry.payload;
    assert.strictEqual(again.status, 'unrecorded', 'rs1 was claimed before the reset and is not recorded twice');
  });

  it('a payload without a session id is unrecorded, not none', () => {
    const tx = newTranscript('no-session.jsonl');
    append(tx, assistant('m1', [thinking(`${CANARY} ns`), toolUse('ns1')]));
    const p = mod.recordReasoningStep({ transcript_path: tx, tool_use_id: 'ns1', tool_name: 'Read' }, { home }).entry.payload;
    assert.strictEqual(p.status, 'unrecorded');
    assert.strictEqual(p.reason, 'no-session-id');
  });

  it('a hook payload that is not JSON returns ok:false and never throws', () => {
    assert.strictEqual(mod.recordReasoningStep('{bad', { home }).ok, false);
    assert.strictEqual(mod.recordReasoningStep('', { home }).ok, false);
  });
});

describe('chain fidelity (E2) and privacy', () => {
  it('reasoning-step entries verify, and tampering with one breaks verification', () => {
    // Own fixture, so the test holds under --test-name-pattern isolation too.
    const tx = newTranscript('tamper.jsonl');
    append(tx, assistant('m1', [thinking(`${CANARY} tamper`), toolUse('tm1')]));
    assert.ok(mod.recordReasoningStep(hookPayload(tx, 'tm1', { session_id: 'sess-tamper' }), { home }).ok);
    const store = createStore(home);
    assert.ok(chainSteps('sess-tamper').length >= 1);
    assert.deepStrictEqual(store.verify(), { ok: true });
    const entries = store.entries.map(e => JSON.parse(JSON.stringify(e)));
    const i = entries.findIndex(e => e.payload?.type === 'reasoning-step' && e.payload.status === 'recorded');
    assert.ok(i >= 0, 'a recorded reasoning-step exists to tamper with (test is self-contained)');
    entries[i].payload.kind = entries[i].payload.kind === 'none' ? 'text-only' : 'none';
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
