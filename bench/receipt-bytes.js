#!/usr/bin/env node
/**
 * bench/receipt-bytes.js
 *
 * On-disk byte price of one signed chain entry per v3 rung (eval E5, storage
 * half). Depth has a storage price; this prints it, per row, as the bytes of
 * the whole signed entry line `JSON.stringify(entry) + '\n'` on a scratch
 * chain, and the delta against R0.
 *
 * Not part of `npm test` (node --test only collects files under test/ and
 * *.test.js). Run it by hand:
 *
 *     node bench/receipt-bytes.js
 *
 * THE SYNTHETIC TOOL CALL (fixed, so the numbers reproduce)
 *   One Bash call, identical in every row: a `git push --force` command of
 *   exactly 200 chars, and a fixed literal "tool response" of exactly 2048
 *   bytes. Timestamps and nonces in the entry envelope change per run but
 *   their printed width does not; the one field that can move by a byte or
 *   two between runs is the reasoning step's captured `captureMs`, so every
 *   row is the MEDIAN of SAMPLES fresh appends rather than a single one.
 *   Every entry is measured at seq 0 on a fresh chain, the way each hook
 *   process meets a fresh tail-read; a live chain adds log10(seq) digits,
 *   identically to every row.
 *
 * WHERE EVERY FIELD COMES FROM (the work order: real code in src/, never a
 * hand-written imitation of the shape)
 *
 *   R0    The baseline receipt for a tool call, built by the REAL builder: the
 *         gate's `gatedAction` (src/gate/index.js) on the no-token deny path,
 *         chained through a real store adapter exactly as bin/hook-pre-tool-use.js
 *         passes it. This is the only tool-call receipt builder in the tree
 *         that lives in src and can be called in isolation. The warn-shape
 *         (`policy-warn`) and the legacy egress receipt (`egress-event` without
 *         v3 fields) are assembled INLINE in bin/hook-pre-tool-use.js and
 *         bin/hook-post-tool-use.js; their helpers `digestParams` and
 *         `digestResponse` are duplicated per hook file and are NOT exported
 *         from src/parser, so calling them needs either a bin spawn (work
 *         order hard rule 3 forbids) or copying their bodies (the work order
 *         forbids that too). This bench therefore measures R0 at the real src
 *         builder rather than printing a hand-written look-alike.
 *
 *   R1    The same receipt. The v3 "actions/params" digest piece —
 *         `digestParamsCanonical` (src/parser) — is ALREADY a field of the
 *         real baseline builder's receipt (the 2026-08-15 gate enrichment),
 *         so the R1 row is the same signed entry: the canonical params digest
 *         rides inside the baseline receipt at zero incremental bytes. That
 *         zero is the measured answer, not a skipped row.
 *
 *   R2    The same receipt plus the V3-03 response record: `toolIo`, built by
 *         the real `describeToolResponse` (src/toolio/index.js) over the fixed
 *         2048-byte response. The live post hook attaches this same field to
 *         its egress receipt. DISCLOSED undercount: the live egress receipt
 *         also carries the legacy `responseDigest` and `responseOk` fields
 *         (bin-only builders, see R0); both are fixed-width per tri-state, so
 *         the deltas here undercount the live receipt by roughly 60 bytes.
 *         The ruleId on these rows comes from the real matchers
 *         (src/policy/index.js) dispatched the way bin/hook-post-tool-use.js
 *         dispatches them — four lines, the matchers themselves untouched.
 *
 *   R3    A real V3-04 reasoning-step receipt, end to end:
 *         `recordReasoningStep` (src/reasoning/index.js) with `{ home }` on a
 *         scratch home and a small synthetic transcript (one assistant line:
 *         a thinking block and the tool_use; one tool_result line), the same
 *         fixture shape test/reasoning-per-step.test.js uses. The module
 *         scans the transcript, writes its cursor under the scratch home, and
 *         appends; nothing here is stubbed.
 *
 *   cert  The session reach certificate, open half (V3-02):
 *         `buildOpenCertificate` (src/reach/certificate.js) over a synthetic
 *         SessionStart payload, harness resolved by the real `resolveHarness`
 *         (src/harness.js). On a live chain this object rides INSIDE a
 *         session-open receipt; this row prices the certificate alone, as its
 *         own row, per the work order.
 *
 * If any row's builder cannot be called (an import fails, a scratch home
 * cannot be made), that row prints `UNMEASURED: <reason>` and the rest keep
 * going — the work order's instruction. None should fire below: every builder
 * used here is importable and runs against scratch state only.
 *
 * Scratch homes and the scratch transcript go under os.tmpdir() and are
 * removed afterwards. The real Lotor home is never read, written, or
 * referenced: nothing here imports src/home.js or reads LOTOR_HOME.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../src/store/index.js';
import { digestParamsCanonical } from '../src/parser/index.js';
import { describeToolResponse } from '../src/toolio/index.js';
import {
  matcherVersionHash,
  isPushForce,
  isPushProtected,
  isPublish,
  isEgressOther
} from '../src/policy/index.js';
import { gatedAction } from '../src/gate/index.js';
import { recordReasoningStep } from '../src/reasoning/index.js';
import { buildOpenCertificate } from '../src/reach/certificate.js';
import { resolveHarness } from '../src/harness.js';

const SAMPLES = 15;
const COMMAND_LEN = 200;
const RESPONSE_LEN = 2048;

const HOME_TAG = 'lotor-bench-receipt-bytes-';
const TX_TAG = 'lotor-bench-receipt-bytes-tx-';

// ---------- the fixed synthetic tool call ----------

const TOOL = 'Bash';
const SESSION_ID = 'sess-e5-receipt-bytes';
const CMD_HEAD = 'git push --force origin feature/eval-e5-';
const COMMAND = CMD_HEAD + 'x'.repeat(COMMAND_LEN - CMD_HEAD.length);
const TOOL_INPUT = { command: COMMAND, description: 'bench: fixed synthetic egress push' };
const RESPONSE_TEXT = 'abcdefgh'.repeat(RESPONSE_LEN / 8); // exactly RESPONSE_LEN chars
const TOOL_RESPONSE = { stdout: RESPONSE_TEXT, stderr: '', is_error: false };
const ACTION_REQUEST = { action: TOOL, params: { command: COMMAND } };

/** The four-line matchEgress dispatch of bin/hook-post-tool-use.js, over the real src matchers. */
function matchEgress(input) {
  if (isPushForce(input)) return 'push-force';
  if (isPushProtected(input)) return 'push-protected';
  if (isPublish(input)) return 'publish';
  if (isEgressOther(input)) return 'egress-other';
  return null;
}
const RULE_ID = matchEgress(TOOL_INPUT);

// ---------- helpers ----------

function entryBytes(entry) {
  return Buffer.byteLength(JSON.stringify(entry) + '\n');
}

function median(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function withFreshHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), HOME_TAG));
  try {
    return fn(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Run fn SAMPLES times, each on a fresh scratch chain; fn returns the entry. */
function sampleEntries(fn) {
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) samples.push(withFreshHome(fn));
  return samples;
}

/**
 * One baseline receipt, built by the real src gate builder on the no-token
 * deny path, chained through a real store on a scratch home — the exact
 * adapter bin/hook-pre-tool-use.js passes to gatedAction. Returns the entry;
 * optionally copies the payload out for the R2 row.
 */
function baselineEntry(home, wantPayload) {
  const store = createStore(home);
  const chain = { entries: store.entries, append: store.appendReceipt.bind(store) };
  gatedAction(ACTION_REQUEST, null, chain, home, { ruleId: RULE_ID, heldMs: null, sessionId: SESSION_ID });
  const entry = store.entries[store.entries.length - 1];
  const out = { entry, ok: createStore(home).verify().ok === true };
  if (wantPayload) out.payload = JSON.parse(JSON.stringify(entry.payload));
  return out;
}

// ---------- scratch transcript for R3 ----------

const l = (o) => JSON.stringify(o) + '\n';
const THINKING_TEXT = 'thinking bench: ' + 'z'.repeat(280);
const TRANSCRIPT_LINES =
  l({
    type: 'assistant',
    sessionId: SESSION_ID,
    message: {
      id: 'msg-e5-0',
      role: 'assistant',
      model: 'synthetic-e5',
      content: [
        { type: 'thinking', thinking: THINKING_TEXT },
        { type: 'tool_use', id: 'tu-e5-0', name: TOOL, input: { command: COMMAND } }
      ]
    }
  }) +
  l({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-e5-0', content: 'ok' }] }
  });

const txDir = fs.mkdtempSync(path.join(os.tmpdir(), TX_TAG));
const TRANSCRIPT_PATH = path.join(txDir, 'tx.jsonl');
fs.writeFileSync(TRANSCRIPT_PATH, TRANSCRIPT_LINES, 'utf8');

/**
 * The SessionStart payload the certificate row is computed from. The
 * transcript_path is the scratch fixture above; buildOpenCertificate never
 * reads it, resolveHarness only reads its shape.
 */
const OPEN_PAYLOAD = {
  session_id: SESSION_ID,
  source: 'startup',
  transcript_path: TRANSCRIPT_PATH,
  cwd: os.tmpdir(),
  model: 'synthetic-e5'
};
const HARNESS = resolveHarness(OPEN_PAYLOAD);
const CERT_PAYLOAD = buildOpenCertificate(OPEN_PAYLOAD, HARNESS);

// ---------- measure each row ----------

const rows = [];

function addRow(rung, what, samples, verified) {
  const bytes = median(samples);
  rows.push({ rung, what, bytes, verified });
}

function unmeasured(rung, what, reason) {
  rows.push({ rung, what, reason });
}

try {
  // R0: the real src baseline builder, deny path, fresh chain each sample.
  let basePayload = null;
  try {
    const samples = [];
    let ok = true;
    for (let i = 0; i < SAMPLES; i++) {
      withFreshHome((home) => {
        const got = baselineEntry(home, i === 0);
        samples.push(entryBytes(got.entry));
        if (!got.ok) ok = false;
        if (got.payload) basePayload = got.payload;
      });
    }
    if (!basePayload) throw new Error('gatedAction appended nothing');
    addRow('R0', 'gated-action denial (real src gate builder, no v3 fields)', samples, ok);
  } catch (e) {
    unmeasured('R0', 'gated-action denial', `real builder failed: ${e.message}`);
  }

  // R1: the same receipt — the canonical params digest is already on it.
  // Asserted here so the zero can never become a silent lie: if a future
  // build drops the field from the baseline builder, this row goes UNMEASURED
  // rather than claiming a duplicate.
  try {
    if (!rows[0] || rows[0].bytes === undefined) throw new Error('R0 not measured');
    if (typeof basePayload.paramsDigestCanonical !== 'string' ||
        basePayload.paramsDigestCanonical !== digestParamsCanonical(ACTION_REQUEST.params)) {
      throw new Error('the baseline builder no longer carries digestParamsCanonical');
    }
    const r0 = rows.find(r => r.rung === 'R0');
    rows.push({
      rung: 'R1',
      what: 'same receipt: digestParamsCanonical (v3 params piece) ridden by the baseline builder',
      bytes: r0.bytes,
      delta: 0,
      verified: r0.verified
    });
  } catch (e) {
    unmeasured('R1', 'same receipt + canonical params digest', e.message);
  }

  // R2: the same receipt + toolIo, from the real describeToolResponse.
  try {
    if (!basePayload) throw new Error('no baseline payload to extend');
    const toolIo = describeToolResponse(TOOL_RESPONSE);
    if (!toolIo.response || toolIo.response.recorded !== true ||
        toolIo.response.bytes < RESPONSE_LEN) {
      // describeToolResponse digests the canonical serialization of the WHOLE
      // tool_response object, so its byte count covers the fixed stdout plus
      // the wrapper; it can never equal the 2048-char stdout alone, but it
      // must at least cover that stdout.
      throw new Error(`describeToolResponse recorded ${toolIo && toolIo.response ? toolIo.response.bytes : 'no'} bytes, less than the ${RESPONSE_LEN}-byte stdout`);
    }
    const payload = { ...basePayload, toolIo };
    const samples = sampleEntries((home) => {
      const store = createStore(home);
      const entry = store.appendReceipt(payload);
      return { entry, ok: store.verify().ok === true };
    });
    addRow('R2', `same receipt + toolIo/1 (describeToolResponse of the fixed response; canonical response ${toolIo.response.bytes} bytes)`,
      samples.map((s) => entryBytes(s.entry)), samples.every((s) => s.ok));
  } catch (e) {
    unmeasured('R2', 'same receipt + toolIo', `real builder failed: ${e.message}`);
  }

  // R3: the real recordReasoningStep against the scratch home and transcript.
  try {
    const hookPayload = JSON.stringify({
      session_id: SESSION_ID,
      transcript_path: TRANSCRIPT_PATH,
      tool_use_id: 'tu-e5-0',
      tool_name: TOOL,
      tool_input: { command: COMMAND }
    });
    const samples = sampleEntries((home) => {
      const r = recordReasoningStep(hookPayload, { home });
      if (!r.ok) throw new Error(`recordReasoningStep refused: ${r.reason}`);
      if (r.entry.payload.status !== 'recorded') {
        throw new Error(`step not recorded (status ${r.entry.payload.status})`);
      }
      return { entry: r.entry, ok: createStore(home).verify().ok === true };
    });
    addRow('R3', 'reasoning-step/1 (recordReasoningStep, real transcript scan)', samples.map((s) => entryBytes(s.entry)), samples.every((s) => s.ok));
  } catch (e) {
    unmeasured('R3', 'reasoning-step', `real builder failed: ${e.message}`);
  }

  // cert: the open reach certificate as its own row.
  try {
    if (!CERT_PAYLOAD || CERT_PAYLOAD.phase !== 'open') {
      throw new Error('buildOpenCertificate did not return an open certificate');
    }
    const samples = sampleEntries((home) => {
      const store = createStore(home);
      const entry = store.appendReceipt(CERT_PAYLOAD);
      return { entry, ok: store.verify().ok === true };
    });
    addRow('cert', 'session-open reach certificate, open half (buildOpenCertificate)', samples.map((s) => entryBytes(s.entry)), samples.every((s) => s.ok));
  } catch (e) {
    unmeasured('cert', 'session-open reach certificate', `real builder failed: ${e.message}`);
  }
} finally {
  fs.rmSync(txDir, { recursive: true, force: true });
}

// ---------- report ----------

const r0row = rows.find((r) => r.rung === 'R0' && r.bytes !== undefined);
const r0Bytes = r0row ? r0row.bytes : null;

console.log(`node ${process.version}, ${os.platform()} ${os.arch()}, median of ${SAMPLES} signed entries per row, each at seq 0 on a fresh scratch chain`);
console.log(`synthetic call: ${TOOL}, command ${Array.from(COMMAND).length} chars, response ${RESPONSE_LEN} bytes (fixed literals); ruleId ${RULE_ID || '(none matched)'} from the real src matchers`);
console.log('');
console.log('| rung | receipt | bytes/entry | delta vs R0 |');
console.log('|---|---|---|---|');
for (const r of rows) {
  if (r.reason !== undefined) {
    console.log(`| ${r.rung} | ${r.what} | UNMEASURED: ${r.reason} | n/a |`);
    continue;
  }
  const delta = r0Bytes === null ? 'n/a (no R0)' : (r.rung === 'R0' ? '—' : `+${r.bytes - r0Bytes}`);
  console.log(`| ${r.rung} | ${r.what} | ${r.bytes} | ${delta} |`);
}
console.log('');
console.log(`every appended chain verified: ${rows.filter((r) => r.verified !== undefined).every((r) => r.verified) ? 'ok' : 'FAILED'}`);
console.log('disclosed omissions: the legacy paramsDigest/responseDigest/responseOk fields of the live hook receipts are built only inside bin/ (not exportable, not spawnable here); R2 therefore undercounts the live post receipt by their fixed width (~60 bytes at these values), and R0 measures the src gate builder the pre hook actually calls.');
if (!r0Bytes) {
  console.log('UNMEASURED: R0 (the baseline row) has no measurement, so no delta is a real number.');
}