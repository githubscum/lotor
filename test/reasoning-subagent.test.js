/**
 * test/reasoning-subagent.test.js
 *
 * WO-AGENT-ID (2026-10-22): attribute subagent tool calls in the reasoning
 * trace. PostToolUse fires for calls made INSIDE a subagent with the parent's
 * session_id and transcript_path, plus agent_id/agent_type. Before this
 * module read agent_id, a child's call was recorded as a reasoning step of
 * the parent AND advanced the parent's cursor past bytes the parent never
 * produced.
 *
 * Unit tests against src/reasoning/index.js (GRANTABLE, Isaac 2026-10-22):
 * fixtures are built in a temp dir and recordReasoningStep is called with a
 * temp home. No chain lock contention, no forked processes.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordReasoningStep, reconcileTrace, traceTranscript } from '../src/reasoning/index.js';

let home, tmp;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-r3-subagent-home-'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-r3-subagent-tx-'));
});
after(() => {
  for (const d of [home, tmp]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

const asLine = o => JSON.stringify(o) + '\n';

/** One assistant transcript line. opts: { id, thinking, signature, toolUse: { id, name, input } } */
function assistantLine(opts, sidechain = false) {
  const content = [];
  if (typeof opts.thinking === 'string') {
    content.push(opts.signature === undefined
      ? { type: 'thinking', thinking: opts.thinking }
      : { type: 'thinking', thinking: opts.thinking, signature: opts.signature });
  }
  if (opts.toolUse) {
    content.push({ type: 'tool_use', id: opts.toolUse.id, name: opts.toolUse.name, input: opts.toolUse.input || {} });
  }
  return asLine({
    type: 'assistant',
    ...(sidechain ? { isSidechain: true } : {}),
    message: { id: opts.id || 'm', role: 'assistant', content }
  });
}

/** Agent-transcript helper: every line carries isSidechain: true, as the harness writes them. */
const agentLine = (opts) => assistantLine(opts, true);

function writeParent(sessionId, lines) {
  const dir = path.join(tmp, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join(''));
  return file;
}

function writeChild(parentPath, agentId, lines) {
  // The convention src/ingest/subagents.js (collectSubagents) reads:
  // <dirname>/<sessionId>/subagents/agent-<agentId>.jsonl
  const dir = path.join(path.dirname(parentPath), path.basename(parentPath, '.jsonl'), 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  fs.writeFileSync(file, lines.join(''));
  return file;
}

const call = (payload) => recordReasoningStep(
  { tool_input: {}, ...payload },
  { home }
).entry.payload;

const cursorFile = (key) => path.join(home, 'reasoning', 'cursors', `${key}.json`);

/** Same safeId the module applies internally (not exported; replicated here). */
const testSafeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);

/** Child cursor location (WO-AGENT-ID-FIX1): cursors/agents/<safe session>/<sha256(agent) 32 hex>.json */
const childCursorFile = (sessionId, agentId) => path.join(
  home, 'reasoning', 'cursors', 'agents',
  testSafeId(sessionId),
  `${crypto.createHash('sha256').update(String(agentId), 'utf8').digest('hex').slice(0, 32)}.json`
);

describe('reasoning steps from subagent tool calls (WO-AGENT-ID)', () => {
  it('a. a child step records from the child transcript and leaves the parent cursor untouched', () => {
    const parent = writeParent('sess-a', [
      assistantLine({ id: 'pa1', thinking: 'parent before tu1', signature: 'sig', toolUse: { id: 'tu1', name: 'Bash' } }),
      assistantLine({ id: 'pa2', thinking: 'parent before tu2', signature: 'sig', toolUse: { id: 'tu2', name: 'Read' } })
    ]);
    writeChild(parent, 'a1', [
      agentLine({ id: 'ca1', thinking: 'child reasoning', toolUse: { id: 'tuChild', name: 'Bash' } })
    ]);

    // 1) parent call
    const p1 = call({ session_id: 'sess-a', transcript_path: parent, tool_use_id: 'tu1', tool_name: 'Bash' });
    assert.strictEqual(p1.status, 'recorded');
    assert.strictEqual(p1.kind, 'thinking-signed');
    assert.ok(!('agentId' in p1), 'a parent step must not carry agentId');
    assert.ok(!('agentType' in p1), 'a parent step must not carry agentType');

    const parentCursor = cursorFile('sess-a');
    assert.ok(fs.existsSync(parentCursor), 'parent cursor exists after the parent call');
    const before = fs.readFileSync(parentCursor);

    // 2) child call: same session_id, agent_id set, child transcript present
    const cs = call({
      session_id: 'sess-a', transcript_path: parent,
      agent_id: 'a1', agent_type: 'Explore',
      tool_use_id: 'tuChild', tool_name: 'Bash'
    });
    assert.strictEqual(cs.status, 'recorded', JSON.stringify(cs));
    assert.strictEqual(cs.agentId, 'a1');
    assert.strictEqual(cs.agentType, 'Explore');
    // The kind proves WHICH transcript was read: the child's thinking is
    // unsigned; the parent's are all signed.
    assert.strictEqual(cs.kind, 'thinking-unsigned');

    // The child cursor lives in its own directory under cursors/agents/,
    // unreachable by any parent-call path (WO-AGENT-ID-FIX1).
    assert.ok(fs.existsSync(childCursorFile('sess-a', 'a1')), 'child cursor file is separate');
    assert.ok(
      fs.readFileSync(parentCursor).equals(before),
      'the parent cursor file must be unchanged by the child call'
    );

    // 3) another parent call: still recorded, claims the right parent tool_use
    const p2 = call({ session_id: 'sess-a', transcript_path: parent, tool_use_id: 'tu2', tool_name: 'Read' });
    assert.strictEqual(p2.status, 'recorded');
    assert.strictEqual(p2.toolUseId, 'tu2');
    assert.strictEqual(p2.kind, 'thinking-signed');
    assert.ok(!('agentId' in p2));
  });

  it('b. a child call with no child transcript is unrecorded and touches no cursor', () => {
    const parent = writeParent('sess-b', [
      assistantLine({ id: 'pb1', thinking: 'parent reasoning', signature: 'sig', toolUse: { id: 'tb1', name: 'Bash' } })
    ]);

    // A parent call first, so there IS a parent cursor to protect.
    const p1 = call({ session_id: 'sess-b', transcript_path: parent, tool_use_id: 'tb1', tool_name: 'Bash' });
    assert.strictEqual(p1.status, 'recorded');
    const parentCursor = cursorFile('sess-b');
    assert.ok(fs.existsSync(parentCursor));
    const before = fs.readFileSync(parentCursor);

    const cs = call({
      session_id: 'sess-b', transcript_path: parent,
      agent_id: 'aNoTx', agent_type: 'Explore',
      tool_use_id: 'missing-tu', tool_name: 'Bash'
    });
    assert.strictEqual(cs.status, 'unrecorded');
    assert.strictEqual(cs.reason, 'subagent-transcript-not-found');
    assert.strictEqual(cs.agentId, 'aNoTx');
    assert.ok(!fs.existsSync(childCursorFile('sess-b', 'aNoTx')), 'no child cursor file created');
    assert.ok(
      fs.readFileSync(parentCursor).equals(before),
      'the parent cursor file must be unchanged by the failed child call'
    );
  });

  it('c. agent_transcript_path in the payload wins over the convention path', () => {
    const parent = writeParent('sess-c', [
      assistantLine({ id: 'pc1', thinking: 'parent reasoning', signature: 'sig', toolUse: { id: 'tc1', name: 'Bash' } })
    ]);
    // Two child transcripts: one at an explicit path, one at the convention
    // path with a different tool_use id. The explicit path must win.
    const customPath = path.join(tmp, 'sess-c-custom-a3.jsonl');
    fs.writeFileSync(customPath, agentLine({ id: 'cc1', thinking: 'custom place', toolUse: { id: 'tuCustom', name: 'Bash' } }));
    writeChild(parent, 'a3', [
      agentLine({ id: 'cc2', thinking: 'convention place', toolUse: { id: 'tuConv', name: 'Bash' } })
    ]);

    const cs1 = call({
      session_id: 'sess-c', transcript_path: parent,
      agent_id: 'a3', agent_type: 'Explore', agent_transcript_path: customPath,
      tool_use_id: 'tuCustom', tool_name: 'Bash'
    });
    assert.strictEqual(cs1.status, 'recorded', JSON.stringify(cs1));
    assert.strictEqual(cs1.toolUseId, 'tuCustom');

    // Without agent_transcript_path the same agent falls back to the
    // convention path and finds the other tool_use.
    const cs2 = call({
      session_id: 'sess-c', transcript_path: parent,
      agent_id: 'a3', agent_type: 'Explore',
      tool_use_id: 'tuConv', tool_name: 'Bash'
    });
    assert.strictEqual(cs2.status, 'recorded', JSON.stringify(cs2));
    assert.strictEqual(cs2.toolUseId, 'tuConv');
  });

  it('d. a payload without agent_id produces a step with no agentId/agentType keys', () => {
    const parent = writeParent('sess-d', [
      assistantLine({ id: 'pd1', thinking: 'parent reasoning', signature: 'sig', toolUse: { id: 'td1', name: 'Bash' } })
    ]);
    const p = call({
      session_id: 'sess-d', transcript_path: parent,
      agent_type: 'Explore',   // agent_type alone must NOT mark a call
      tool_use_id: 'td1', tool_name: 'Bash'
    });
    assert.strictEqual(p.status, 'recorded');
    assert.ok(!('agentId' in p), 'no agentId key without agent_id');
    assert.ok(!('agentType' in p), 'no agentType key without agent_id');

    // An empty agent_id is the same as an absent one.
    const pEmpty = call({
      session_id: 'sess-d', transcript_path: parent,
      agent_id: '', agent_type: 'Explore',
      tool_use_id: 'td1', tool_name: 'Bash'
    });
    // (already claimed, so this lands unrecorded either way; the keys matter)
    assert.ok(!('agentId' in pEmpty));

    // A whitespace-only agent_id is absent too, directly at captureStep's
    // surface (WO-AGENT-ID-FIX1; recordReasoningStep already trims, but the
    // exported captureStep must not depend on that).
    const pWs = call({
      session_id: 'sess-d', transcript_path: parent,
      agent_id: '   ', agent_type: 'Explore',
      tool_use_id: 'td1', tool_name: 'Bash'
    });
    assert.ok(!('agentId' in pWs), 'a whitespace-only agent_id must not mark the call');
  });

  it("e. reconcile: a child step is not counted for or against the parent's trace", () => {
    const parentText = [
      assistantLine({ id: 'pe1', thinking: 'parent reasoning', signature: 'sig', toolUse: { id: 'te1', name: 'Bash' } })
    ].join('');
    const trace = traceTranscript(parentText);
    assert.strictEqual(trace.rows.length, 1);
    const parentDigest = trace.rows[0].segmentDigest;

    const chainEntries = [
      // A child step whose toolUseId collides with a parent one (both share
      // the session id, and before the agent-keyed cursor fix a child could
      // claim the parent's cursor): must not turn the parent row into a
      // mismatch, and must not match in its place either.
      { payload: { type: 'reasoning-step', schema: 'reasoning-step/1', sessionId: 'sess-e', toolUseId: 'te1', agentId: 'a5', agentType: 'Explore', status: 'recorded', segmentDigest: 'deadbeef', kind: 'none', kinds: ['none'] } },
      // A sibling child step with a toolUseId the parent never made: must
      // count as nothing at all.
      { payload: { type: 'reasoning-step', schema: 'reasoning-step/1', sessionId: 'sess-e', toolUseId: 'tc-only-in-child', agentId: 'a5', agentType: 'Explore', status: 'recorded', segmentDigest: 'cafe', kind: 'none', kinds: ['none'] } },
      // The parent's own step, digest matching the parent transcript.
      { payload: { type: 'reasoning-step', schema: 'reasoning-step/1', sessionId: 'sess-e', toolUseId: 'te1', status: 'recorded', segmentDigest: parentDigest, kind: 'thinking-signed', kinds: ['thinking-signed'] } }
    ];

    const rec = reconcileTrace(trace, chainEntries, 'sess-e');
    assert.strictEqual(rec.rows.length, 1, 'only the parent row is reconciled');
    assert.strictEqual(rec.rows[0].reconcile, 'matched');
    assert.strictEqual(rec.counts.matched, 1);
    assert.strictEqual(rec.counts.mismatched, 0, 'a child step must not appear as a parent mismatch');
    assert.strictEqual(rec.counts.late, 0);
  });

  // ---- WO-AGENT-ID-FIX1 ----

  it('f. a second child call for the same agent loads the child cursor from disk and records the next tool_use', () => {
    const parent = writeParent('sess-f', [
      assistantLine({ id: 'pf1', thinking: 'parent reasoning', signature: 'sig', toolUse: { id: 'tuPF', name: 'Bash' } })
    ]);
    writeChild(parent, 'f1', [
      agentLine({ id: 'cf1', thinking: 'child first', toolUse: { id: 'tuF1', name: 'Bash' } }),
      agentLine({ id: 'cf2', thinking: 'child second', toolUse: { id: 'tuF2', name: 'Read' } })
    ]);

    const cs1 = call({
      session_id: 'sess-f', transcript_path: parent,
      agent_id: 'f1', agent_type: 'Explore',
      tool_use_id: 'tuF1', tool_name: 'Bash'
    });
    assert.strictEqual(cs1.status, 'recorded', JSON.stringify(cs1));

    const childCursor = childCursorFile('sess-f', 'f1');
    assert.ok(fs.existsSync(childCursor), 'child cursor file created by the first call');
    const onDisk = JSON.parse(fs.readFileSync(childCursor, 'utf8'));
    assert.strictEqual(onDisk.includeSidechain, true, 'includeSidechain is persisted on the child cursor');

    // The second call must LOAD that cursor, not start fresh: it reads no new
    // bytes and advances from the exact offset the first call left behind.
    const cs2 = call({
      session_id: 'sess-f', transcript_path: parent,
      agent_id: 'f1', agent_type: 'Explore',
      tool_use_id: 'tuF2', tool_name: 'Read'
    });
    assert.strictEqual(cs2.status, 'recorded', JSON.stringify(cs2));
    assert.strictEqual(cs2.toolUseId, 'tuF2');
    assert.strictEqual(cs2.kind, 'thinking-unsigned');
    assert.strictEqual(cs2.transcript.bytesRead, 0,
      'a cursor loaded from disk reads no bytes it has already read');
    assert.strictEqual(cs2.transcript.fromOffset, onDisk.offset,
      'the second call continues from the offset the first call saved');
  });

  it('g. a rewritten child transcript resets the child cursor, which still reads sidechain lines', () => {
    const parent = writeParent('sess-g', [
      assistantLine({ id: 'pg1', thinking: 'parent reasoning', signature: 'sig', toolUse: { id: 'tuPG', name: 'Bash' } })
    ]);
    writeChild(parent, 'g1', [
      agentLine({ id: 'cg1', thinking: 'child v1', toolUse: { id: 'tuG1', name: 'Bash' } })
    ]);

    const cs1 = call({
      session_id: 'sess-g', transcript_path: parent,
      agent_id: 'g1', agent_type: 'Explore',
      tool_use_id: 'tuG1', tool_name: 'Bash'
    });
    assert.strictEqual(cs1.status, 'recorded', JSON.stringify(cs1));

    // Rewrite the child transcript in place: the cursor's head digest no
    // longer matches the file, so the cursor resets (claiming is carried).
    writeChild(parent, 'g1', [
      agentLine({ id: 'cg2', thinking: 'child v2', toolUse: { id: 'tuG2', name: 'Read' } })
    ]);

    const cs2 = call({
      session_id: 'sess-g', transcript_path: parent,
      agent_id: 'g1', agent_type: 'Explore',
      tool_use_id: 'tuG2', tool_name: 'Read'
    });
    assert.strictEqual(cs2.status, 'recorded', JSON.stringify(cs2));
    assert.strictEqual(cs2.transcript.cursorReset, 'transcript-rewritten');
    assert.strictEqual(cs2.toolUseId, 'tuG2');
    // Proof the RESET cursor still reads sidechain lines: if it were scanned
    // as a parent transcript, every line (isSidechain: true) would be skipped
    // and this step would come back unrecorded, 'tool-use-not-in-transcript'.
    assert.strictEqual(cs2.kind, 'thinking-unsigned');
    const reset = JSON.parse(fs.readFileSync(childCursorFile('sess-g', 'g1'), 'utf8'));
    assert.strictEqual(reset.includeSidechain, true, 'includeSidechain survives the reset');
  });

  it('h. a legacy parent cursor file with no includeSidechain key loads and works as a parent cursor', () => {
    const parent = writeParent('sess-h', [
      assistantLine({ id: 'ph1', thinking: 'legacy parent', signature: 'sig', toolUse: { id: 'tuH', name: 'Bash' } })
    ]);
    // Hand-written legacy cursor: the exact shape the pre-subagent code
    // saved — no includeSidechain key anywhere.
    const file = cursorFile('sess-h');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schema: 'reasoning-cursor/1',
      sessionId: 'sess-h',
      transcriptPath: parent,
      offset: 0,
      headLen: 0,
      headDigest: null,
      state: { pending: [], batch: null, unattributed: 0, malformedLines: 0 },
      unclaimed: [],
      claimed: []
    }), { mode: 0o600 });

    const p = call({ session_id: 'sess-h', transcript_path: parent, tool_use_id: 'tuH', tool_name: 'Bash' });
    assert.strictEqual(p.status, 'recorded', JSON.stringify(p));
    assert.ok(!('agentId' in p));

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(!('includeSidechain' in saved), 'a parent cursor gains no includeSidechain key');
  });

  it('i. a 200-character session id: a child call leaves the parent cursor file byte-identical', () => {
    // 200 chars of safe characters: safeId truncates it to 128 — the exact
    // truncation that once made the child key equal the parent key, because
    // the child key was `<safeId(session)>--agent-<safeId(agent)>` safeId'd
    // again. Any call for this session must now use the agents/ subtree.
    const longSess = 'abcdefghij'.repeat(20);
    assert.strictEqual(longSess.length, 200);

    // Short-named files: only the session id string is long. Child transcript
    // is handed by agent_transcript_path, so nothing on disk is named after
    // the long session id.
    const parentPath = path.join(tmp, 'long-sess-parent.jsonl');
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(parentPath, assistantLine({
      id: 'pi9', thinking: 'parent reasoning', signature: 'sig', toolUse: { id: 'tuPL', name: 'Bash' }
    }));
    const childPath = path.join(tmp, 'long-sess-child.jsonl');
    fs.writeFileSync(childPath, agentLine({
      id: 'ci9', thinking: 'child reasoning', toolUse: { id: 'tuCL', name: 'Bash' }
    }));

    const p = call({ session_id: longSess, transcript_path: parentPath, tool_use_id: 'tuPL', tool_name: 'Bash' });
    assert.strictEqual(p.status, 'recorded', JSON.stringify(p));
    const parentCursor = cursorFile(testSafeId(longSess));   // safeId-truncated file name, as the module writes it
    assert.ok(fs.existsSync(parentCursor), 'parent cursor exists');
    const before = fs.readFileSync(parentCursor);

    const cs = call({
      session_id: longSess, transcript_path: parentPath,
      agent_id: 'aLong', agent_type: 'Explore', agent_transcript_path: childPath,
      tool_use_id: 'tuCL', tool_name: 'Bash'
    });
    assert.strictEqual(cs.status, 'recorded', JSON.stringify(cs));
    assert.strictEqual(cs.agentId, 'aLong');
    assert.ok(fs.existsSync(childCursorFile(longSess, 'aLong')), 'the child cursor is in the agents subtree');
    assert.ok(
      fs.readFileSync(parentCursor).equals(before),
      'the byte-compared parent cursor file must be unchanged by the child call'
    );
  });

  it('j. an agent_id shaped like a path is unrecorded (agent-id-invalid) and touches no cursor', () => {
    const parent = writeParent('sess-j', [
      assistantLine({ id: 'pj1', thinking: 'parent reasoning', signature: 'sig', toolUse: { id: 'tuJ', name: 'Bash' } })
    ]);
    const cs = call({
      session_id: 'sess-j', transcript_path: parent,
      agent_id: '../../x', agent_type: 'Explore',
      tool_use_id: 'tuJ', tool_name: 'Bash'
    });
    assert.strictEqual(cs.status, 'unrecorded');
    assert.strictEqual(cs.reason, 'agent-id-invalid');
    assert.ok(!fs.existsSync(childCursorFile('sess-j', '../../x')), 'no child cursor file created');
    assert.ok(!fs.existsSync(cursorFile('sess-j')), 'no parent cursor file created either');
  });

  it('k. an agent_transcript_path not ending in .jsonl is ignored; the convention path is used', () => {
    const parent = writeParent('sess-k', [
      assistantLine({ id: 'pk1', thinking: 'parent reasoning', signature: 'sig', toolUse: { id: 'tuPK', name: 'Bash' } })
    ]);
    writeChild(parent, 'k1', [
      agentLine({ id: 'ck1', thinking: 'from convention', toolUse: { id: 'tuKConv', name: 'Bash' } })
    ]);
    const bogus = path.join(tmp, 'sess-k-agent-k1.txt');   // not .jsonl
    fs.writeFileSync(bogus, agentLine({
      id: 'ckBad', thinking: 'from bogus file', toolUse: { id: 'tuKBad', name: 'Bash' }
    }));

    const cs = call({
      session_id: 'sess-k', transcript_path: parent,
      agent_id: 'k1', agent_type: 'Explore', agent_transcript_path: bogus,
      tool_use_id: 'tuKConv', tool_name: 'Bash'
    });
    // The tool_use id only exists in the convention transcript: had the .txt
    // file been read, this call would have come back unrecorded.
    assert.strictEqual(cs.status, 'recorded', JSON.stringify(cs));
    assert.strictEqual(cs.toolUseId, 'tuKConv');
    assert.strictEqual(cs.kind, 'thinking-unsigned');
  });

  it('l. a child call with agent_transcript_path but no transcript_path records from the agent transcript', () => {
    const parent = writeParent('sess-l', [
      assistantLine({ id: 'pl1', thinking: 'parent reasoning', signature: 'sig', toolUse: { id: 'tuPL2', name: 'Bash' } })
    ]);
    const custom = path.join(tmp, 'sess-l-agent-l1.jsonl');
    fs.writeFileSync(custom, agentLine({
      id: 'cl1', thinking: 'agent transcript only', toolUse: { id: 'tuL', name: 'Bash' }
    }));

    // No transcript_path in the payload at all.
    const cs = call({
      session_id: 'sess-l',
      agent_id: 'l1', agent_type: 'Explore', agent_transcript_path: custom,
      tool_use_id: 'tuL', tool_name: 'Bash'
    });
    assert.strictEqual(cs.status, 'recorded', JSON.stringify(cs));
    assert.strictEqual(cs.toolUseId, 'tuL');
    assert.strictEqual(cs.kind, 'thinking-unsigned');
  });
});