import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../store/index.js';

/**
 * src/reasoning/index.js
 *
 * V3-04, rung R3: the reasoning trace, chained per step.
 *
 * Until this module, R3 reached the chain only at session end: a transcript
 * hash and a thoughts/1 sidecar of usage rows. Nothing bound an ACTION to
 * the reasoning that preceded it. This module does that. At each tool call
 * (PostToolUse), it reads the transcript forward from the last recorded byte
 * offset, collects the assistant's thinking and text blocks emitted since the
 * previous action, and appends one `reasoning-step` receipt for that action:
 * digests, counts, lengths, and the KIND of reasoning the runtime exposed.
 *
 * WHAT IT NEVER DOES
 *   - Store reasoning text on the chain. Digests only (full SHA-256), plus
 *     lengths and counts. The transcript is the text's only home; a reader
 *     holding it can recompute every digest and check it against the chain.
 *     The cursor file under <home>/reasoning/ holds digests only, too.
 *   - Judge intent. It records what was exposed and of which kind. Whether
 *     the reasoning is faithful to the computation is the meter's question,
 *     and the answer is never assumed here (spec §4).
 *   - Infer the kind from what was REQUESTED (a think flag, a model id). The
 *     kind is read from the blocks that actually landed (V3-01: "the think
 *     flag is a request, not a switch").
 *   - Throw into a hook. Every entry point returns a result object.
 *
 * KIND TAXONOMY (per block, then per step)
 *   thinking-unsigned     readable thinking text with no vendor signature.
 *                         Seen from Ollama-routed models (glm, minimax). The
 *                         runtime handed over the text as emitted; nothing on
 *                         the record says it was processed. Closest to "full
 *                         thinking" the record can show, and still not proof.
 *   thinking-signed       readable thinking text carrying a vendor signature
 *                         (Claude). Full or vendor-summarized CANNOT be told
 *                         apart from the transcript: no marker distinguishes
 *                         them. Lotor therefore never asserts "full" for it.
 *   thinking-redacted     thinking happened but nothing readable was exposed:
 *                         a `redacted_thinking` block, or a `thinking` block
 *                         whose text is empty and whose signature is not. The
 *                         digest is taken over the opaque payload.
 *   text-inline-reasoning visible text carrying <think> / </think> markers:
 *                         R3 that leaked into the R0 channel (V3-01's glm
 *                         finding). Filed as reasoning, flagged as leaked.
 *   text-only             visible assistant text, no reasoning block exposed.
 *   none                  nothing between the previous action and this one.
 *   unrecorded            the step could not be read (transcript missing,
 *                         not yet flushed, unreadable). NEVER reported as none.
 *
 *   A step's `kind` is the deepest kind present, in the order above; `kinds`
 *   lists every kind present so a mixed step loses nothing.
 *
 * SEGMENTS
 *   A step's segment is every reasoning block after the previous tool_use and
 *   before this one. Tool calls issued together in one assistant message
 *   (parallel calls) share that message's segment and carry a batch index. A
 *   real human prompt closes the open segment: reasoning that ended a turn
 *   without an action is counted as unattributed, not credited to the next
 *   turn's first action. Sidechain (subagent) lines are skipped.
 *
 * THE RACE
 *   A hook can fire before the harness has flushed the tool_use line. Then
 *   the step is appended as status `unrecorded`, reason
 *   `tool-use-not-in-transcript`, and the session-end pass (traceTranscript +
 *   reconcileTrace, called from src/ingest) fills it in as `late`.
 */

export const STEP_SCHEMA = 'reasoning-step/1';
export const TRACE_SCHEMA = 'reasoning-trace/1';
const CURSOR_SCHEMA = 'reasoning-cursor/1';

// Deepest first. A step's kind is the first of these present in its segment.
export const KIND_ORDER = Object.freeze([
  'thinking-unsigned',
  'thinking-signed',
  'text-inline-reasoning',
  'thinking-redacted',
  'text-only'
]);

const HEAD_BYTES = 4096;        // rewrite detection: digest of the file head
const MAX_UNCLAIMED = 512;      // segments seen but not yet claimed by a hook
const MAX_CLAIMED = 4096;       // ids already recorded, so a reset never doubles
const MAX_DIGEST_ROWS = 64;     // per receipt; segmentDigest still covers all
const THINK_TAG = /<\/?think>/i;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Canonical (sorted-key) JSON digest, for the name+input fallback match. */
function canonicalDigest(value) {
  const canon = v => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(canon);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k]);
    return out;
  };
  if (value === undefined || value === null) return 'empty';
  return sha256(JSON.stringify(canon(value)));
}

/**
 * Classify one assistant content block. Returns a row with NO text in it,
 * or null when the block exposes nothing (a tool_use, an empty text, an
 * unsigned empty thinking block).
 */
export function classifyBlock(b) {
  if (!b || typeof b !== 'object') return null;
  if (b.type === 'redacted_thinking') {
    const data = typeof b.data === 'string' ? b.data : '';
    return { block: 'thinking-redacted', sha256: sha256(data), length: 0, over: 'data' };
  }
  if (b.type === 'thinking') {
    const t = typeof b.thinking === 'string' ? b.thinking
      : (typeof b.text === 'string' ? b.text : '');
    const signed = typeof b.signature === 'string' && b.signature.length > 0;
    if (t.trim().length > 0) {
      return { block: signed ? 'thinking-signed' : 'thinking-unsigned', sha256: sha256(t), length: t.length };
    }
    if (signed) {
      return { block: 'thinking-redacted', sha256: sha256(b.signature), length: 0, over: 'signature' };
    }
    return null;
  }
  if (b.type === 'text') {
    const t = typeof b.text === 'string' ? b.text : '';
    if (t.trim().length === 0) return null;
    return { block: THINK_TAG.test(t) ? 'text-inline-reasoning' : 'text', sha256: sha256(t), length: t.length };
  }
  return null;
}

function blockKind(block) {
  return block === 'text' ? 'text-only' : block;
}

/** Summarize a segment's rows: kind, kinds, counts, chars, binding digest. */
export function summarizeRows(rows) {
  const present = new Set(rows.map(r => blockKind(r.block)));
  const kinds = KIND_ORDER.filter(k => present.has(k));
  const blocks = { thinkingUnsigned: 0, thinkingSigned: 0, thinkingRedacted: 0, textInlineReasoning: 0, text: 0 };
  const chars = { thinking: 0, text: 0 };
  for (const r of rows) {
    if (r.block === 'thinking-unsigned') { blocks.thinkingUnsigned++; chars.thinking += r.length; }
    else if (r.block === 'thinking-signed') { blocks.thinkingSigned++; chars.thinking += r.length; }
    else if (r.block === 'thinking-redacted') { blocks.thinkingRedacted++; }
    else if (r.block === 'text-inline-reasoning') { blocks.textInlineReasoning++; chars.text += r.length; }
    else if (r.block === 'text') { blocks.text++; chars.text += r.length; }
  }
  return {
    kind: kinds.length ? kinds[0] : 'none',
    kinds: kinds.length ? kinds : ['none'],
    blocks,
    chars,
    segmentDigest: rows.length ? sha256(rows.map(r => `${r.block}:${r.sha256}`).join('\n')) : 'empty'
  };
}

function freshState() {
  return {
    pending: [],          // rows since the previous action
    batch: null,          // { messageId, rows, count } for parallel tool calls
    unattributed: 0,      // rows closed out by a human prompt, never acted on
    malformedLines: 0
  };
}

function isHumanPrompt(entry) {
  if (entry.isMeta === true) return false;
  const c = entry.message?.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (Array.isArray(c)) return c.length > 0 && !c.some(i => i && i.type === 'tool_result');
  return false;
}

/**
 * Advance the scan state by one parsed transcript line. Calls onToolUse(seg)
 * for every tool_use block, with the segment that preceded it.
 */
function scanEntry(entry, state, onToolUse) {
  if (!entry || typeof entry !== 'object' || entry.isSidechain === true) return;
  const msg = entry.message;
  if (!msg || typeof msg !== 'object') return;
  if (msg.role === 'user') {
    if (isHumanPrompt(entry)) {
      state.unattributed += state.pending.length;
      state.pending = [];
      state.batch = null;
    }
    return;
  }
  if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return;
  const messageId = typeof msg.id === 'string' && msg.id ? msg.id
    : (typeof entry.requestId === 'string' ? entry.requestId : null);
  for (const b of msg.content) {
    if (b && b.type === 'tool_use') {
      let rows, batchIndex;
      if (state.batch && messageId && state.batch.messageId === messageId && state.pending.length === 0) {
        rows = state.batch.rows;
        batchIndex = ++state.batch.count;
      } else {
        rows = state.pending;
        batchIndex = 0;
        state.batch = { messageId, rows, count: 0 };
      }
      state.pending = [];
      onToolUse({
        toolUseId: typeof b.id === 'string' ? b.id : null,
        tool: typeof b.name === 'string' ? b.name : 'unknown',
        inputDigest: canonicalDigest(b.input),
        batchIndex,
        rows
      });
      continue;
    }
    const row = classifyBlock(b);
    if (row) {
      state.pending.push(row);
      state.batch = null;
    }
  }
}

function parseLines(text, state) {
  const out = [];
  for (let line of text.split('\n')) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim() === '') continue;
    try { out.push(JSON.parse(line)); } catch (e) { state.malformedLines++; }
  }
  return out;
}

/**
 * Whole-transcript trace, for the session-end pass. Pure: no I/O.
 * @returns {{ schema, rows: Array, unattributedBlocks: number, trailing: object, malformedLines: number }}
 */
export function traceTranscript(jsonlText) {
  const state = freshState();
  const rows = [];
  for (const entry of parseLines(String(jsonlText || ''), state)) {
    scanEntry(entry, state, seg => {
      const s = summarizeRows(seg.rows);
      rows.push({
        toolUseId: seg.toolUseId,
        tool: seg.tool,
        batchIndex: seg.batchIndex,
        kind: s.kind,
        kinds: s.kinds,
        blocks: s.blocks,
        chars: s.chars,
        segmentDigest: s.segmentDigest
      });
    });
  }
  const trailing = summarizeRows(state.pending);
  return {
    schema: TRACE_SCHEMA,
    rows,
    unattributedBlocks: state.unattributed,
    trailing: { kind: trailing.kind, blocks: state.pending.length, segmentDigest: trailing.segmentDigest },
    malformedLines: state.malformedLines
  };
}

/**
 * Compare a session's trace with the reasoning-step receipts already on the
 * chain. Each row is `matched` (step recorded, same digest), `mismatched`
 * (recorded, different digest: the transcript and the per-step record
 * disagree, which is evidence and is surfaced, never smoothed), or `late`
 * (the step was unrecorded or never fired, e.g. the race or a denied call;
 * this row is the reconciled value).
 */
export function reconcileTrace(trace, chainEntries, sessionId) {
  const steps = new Map();
  for (const e of chainEntries || []) {
    const p = e?.payload;
    if (p && p.type === 'reasoning-step' && p.sessionId === sessionId && p.toolUseId) {
      const prev = steps.get(p.toolUseId);
      if (!prev || prev.status !== 'recorded') steps.set(p.toolUseId, p);
    }
  }
  const counts = { matched: 0, late: 0, mismatched: 0 };
  const kinds = {};
  const mismatchedIds = [];
  const rows = trace.rows.map(r => {
    const step = r.toolUseId ? steps.get(r.toolUseId) : undefined;
    let reconcile;
    if (step && step.status === 'recorded') {
      reconcile = step.segmentDigest === r.segmentDigest ? 'matched' : 'mismatched';
    } else {
      reconcile = 'late';
    }
    counts[reconcile]++;
    if (reconcile === 'mismatched' && mismatchedIds.length < 32) mismatchedIds.push(r.toolUseId);
    kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    return { ...r, reconcile };
  });
  return { rows, counts, kinds, mismatchedIds };
}

/**
 * Session-end binding (called by src/ingest inside the chain lock). Returns
 * the receipt field and the exact sidecar text its digest binds.
 */
export function reasoningBinding(jsonlText, chainEntries, sessionId) {
  const trace = traceTranscript(jsonlText);
  const rec = reconcileTrace(trace, chainEntries, sessionId);
  const sidecarText = rec.rows.length ? rec.rows.map(r => JSON.stringify(r)).join('\n') + '\n' : '';
  return {
    sidecarText,
    field: {
      schema: TRACE_SCHEMA,
      steps: rec.rows.length,
      kinds: rec.kinds,
      matched: rec.counts.matched,
      late: rec.counts.late,
      mismatched: rec.counts.mismatched,
      mismatchedIds: rec.mismatchedIds,
      unattributedBlocks: trace.unattributedBlocks,
      trailing: trace.trailing,
      malformedLines: trace.malformedLines,
      digest: sha256(sidecarText)
    }
  };
}

// ---------- per-step capture (the hook path) ----------

function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
}

function cursorPath(home, sessionId) {
  return path.join(home, 'reasoning', 'cursors', `${safeId(sessionId)}.json`);
}

function loadCursor(home, sessionId) {
  try {
    const c = JSON.parse(fs.readFileSync(cursorPath(home, sessionId), 'utf8'));
    if (c && c.schema === CURSOR_SCHEMA) return c;
  } catch (e) { /* absent or unreadable: start fresh */ }
  return null;
}

function saveCursor(home, sessionId, cursor) {
  const file = cursorPath(home, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cursor), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function newCursor(sessionId, transcriptPath) {
  return {
    schema: CURSOR_SCHEMA,
    sessionId,
    transcriptPath,
    offset: 0,
    headLen: 0,
    headDigest: null,
    state: freshState(),
    unclaimed: [],   // [{ toolUseId, tool, inputDigest, batchIndex, rows }]
    claimed: []      // toolUseIds already on the chain
  };
}

function readBytes(fd, start, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, start + got);
    if (n === 0) break;
    got += n;
  }
  return got === len ? buf : buf.subarray(0, got);
}

/**
 * Bring the cursor up to date with the transcript. Reads ONLY the bytes after
 * the recorded offset, and only up to the last complete line: a partial
 * trailing line is left for the next call. Returns io facts for the receipt.
 */
function advanceCursor(cursor, transcriptPath) {
  const io = { fromOffset: cursor.offset, toOffset: cursor.offset, bytesRead: 0, partialLineBytes: 0, cursorReset: null };
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let reset = null;
    if (cursor.transcriptPath !== transcriptPath) reset = 'transcript-path-changed';
    else if (size < cursor.offset) reset = 'transcript-truncated';
    else if (cursor.headLen > 0 && cursor.headDigest) {
      const head = readBytes(fd, 0, cursor.headLen);
      if (head.length !== cursor.headLen || crypto.createHash('sha256').update(head).digest('hex') !== cursor.headDigest) {
        reset = 'transcript-rewritten';
      }
    }
    if (reset) {
      const claimed = cursor.claimed;
      Object.assign(cursor, newCursor(cursor.sessionId, transcriptPath));
      cursor.claimed = claimed;   // never record the same step twice after a reset
      io.cursorReset = reset;
      io.fromOffset = 0;
    }
    if (size > cursor.offset) {
      const chunk = readBytes(fd, cursor.offset, size - cursor.offset);
      io.bytesRead = chunk.length;
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl >= 0) {
        const text = chunk.subarray(0, lastNl + 1).toString('utf8');
        const claimedSet = new Set(cursor.claimed);
        for (const entry of parseLines(text, cursor.state)) {
          scanEntry(entry, cursor.state, seg => {
            if (seg.toolUseId && claimedSet.has(seg.toolUseId)) return;
            cursor.unclaimed.push(seg);
          });
        }
        cursor.offset += lastNl + 1;
      }
      io.partialLineBytes = chunk.length - (lastNl + 1);
    }
    if (cursor.headLen < HEAD_BYTES && cursor.offset > cursor.headLen) {
      const len = Math.min(HEAD_BYTES, cursor.offset);
      cursor.headLen = len;
      cursor.headDigest = crypto.createHash('sha256').update(readBytes(fd, 0, len)).digest('hex');
    }
    io.toOffset = cursor.offset;
  } finally {
    fs.closeSync(fd);
  }
  if (cursor.unclaimed.length > MAX_UNCLAIMED) cursor.unclaimed.splice(0, cursor.unclaimed.length - MAX_UNCLAIMED);
  return io;
}

function claim(cursor, { toolUseId, toolName, toolInput }) {
  let idx = -1;
  let matchedBy = null;
  if (toolUseId) {
    idx = cursor.unclaimed.findIndex(s => s.toolUseId === toolUseId);
    if (idx >= 0) matchedBy = 'tool_use_id';
  } else if (toolName) {
    const d = canonicalDigest(toolInput);
    idx = cursor.unclaimed.findIndex(s => s.tool === toolName && s.inputDigest === d);
    if (idx >= 0) matchedBy = 'name+input';
  }
  if (idx < 0) return null;
  const [seg] = cursor.unclaimed.splice(idx, 1);
  if (seg.toolUseId) {
    cursor.claimed.push(seg.toolUseId);
    if (cursor.claimed.length > MAX_CLAIMED) cursor.claimed.splice(0, cursor.claimed.length - MAX_CLAIMED);
  }
  return { seg, matchedBy };
}

function unrecordedPayload(base, reason, io) {
  return {
    ...base,
    status: 'unrecorded',
    reason,
    kind: 'unrecorded',
    kinds: ['unrecorded'],
    ...(io ? { transcript: io } : {})
  };
}

/**
 * Build (but do not append) the reasoning-step payload for one tool call,
 * updating the session's cursor. Exported for tests; the hook path is
 * recordReasoningStep below, which runs this under the chain lock.
 */
export function captureStep({ home, sessionId, transcriptPath, toolUseId, toolName, toolInput, now = Date.now }) {
  const started = process.hrtime.bigint();
  const base = {
    type: 'reasoning-step',
    schema: STEP_SCHEMA,
    sessionId: sessionId || null,
    toolUseId: toolUseId || null,
    tool: toolName || 'unknown'
  };
  const finish = p => ({ ...p, captureMs: Number(process.hrtime.bigint() - started) / 1e6, timestamp: now() });

  if (!sessionId) return finish(unrecordedPayload(base, 'no-session-id'));
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return finish(unrecordedPayload(base, 'no-transcript-path'));
  if (!fs.existsSync(transcriptPath)) return finish(unrecordedPayload(base, 'transcript-missing'));

  const cursor = loadCursor(home, sessionId) || newCursor(sessionId, transcriptPath);
  let io;
  try {
    io = advanceCursor(cursor, transcriptPath);
  } catch (e) {
    return finish(unrecordedPayload(base, `transcript-unreadable: ${e.code || 'error'}`));
  }
  io.malformedLines = cursor.state.malformedLines;
  const hit = claim(cursor, { toolUseId, toolName, toolInput });
  saveCursor(home, sessionId, cursor);

  if (!hit) return finish(unrecordedPayload(base, 'tool-use-not-in-transcript', io));

  const s = summarizeRows(hit.seg.rows);
  const digests = hit.seg.rows.slice(0, MAX_DIGEST_ROWS)
    .map(r => (r.over ? { block: r.block, sha256: r.sha256, length: r.length, over: r.over }
                      : { block: r.block, sha256: r.sha256, length: r.length }));
  return finish({
    ...base,
    toolUseId: hit.seg.toolUseId || base.toolUseId,
    status: 'recorded',
    matchedBy: hit.matchedBy,
    kind: s.kind,
    kinds: s.kinds,
    blocks: s.blocks,
    chars: s.chars,
    digests,
    ...(hit.seg.rows.length > MAX_DIGEST_ROWS ? { digestsTruncated: hit.seg.rows.length } : {}),
    segmentDigest: s.segmentDigest,
    batchIndex: hit.seg.batchIndex,
    transcript: io
  });
}

/**
 * Hook entry point. Takes the raw PostToolUse payload (JSON string or
 * object), appends one reasoning-step receipt, and never throws.
 *
 * The cursor read-advance-write runs INSIDE the chain lock, so parallel tool
 * calls whose hooks fire together cannot interleave cursor updates, and the
 * step lands on the chain in the same critical section that moved the cursor.
 *
 * @returns {{ok: true, entry: object} | {ok: false, reason: string}}
 */
export function recordReasoningStep(hookPayload, { home } = {}) {
  try {
    let p = hookPayload;
    if (typeof p === 'string') {
      if (p.trim() === '') return { ok: false, reason: 'empty payload' };
      p = JSON.parse(p);
    }
    if (!p || typeof p !== 'object') return { ok: false, reason: 'payload not an object' };
    if (!home) return { ok: false, reason: 'no home' };
    const args = {
      home,
      sessionId: typeof p.session_id === 'string' && p.session_id.trim() ? p.session_id : null,
      transcriptPath: typeof p.transcript_path === 'string' ? p.transcript_path : null,
      toolUseId: typeof p.tool_use_id === 'string' && p.tool_use_id ? p.tool_use_id : null,
      toolName: typeof p.tool_name === 'string' ? p.tool_name : null,
      toolInput: p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : undefined
    };
    const store = createStore(home);
    const entry = store.appendReceiptGuarded(() => captureStep(args));
    return { ok: true, entry };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}
