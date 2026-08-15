// make-demo-chain.mjs — generate tower/demo/demo-chain.jsonl
//
// A synthetic receipt chain for the blank-page case: a fresh install has
// no receipts, and an empty UI teaches nothing. This sample is shaped
// after the double-blind test behind "The Bones Do Remember" (Row A /
// Row B / Row C sessions, a gate that denies and approves, a warn-mode
// day, a loose day with egress) so a first-time reader sees every
// receipt type the UI can render, populated with obviously-fake paths.
//
// SYNTHETIC BY CONSTRUCTION. Every path is under C:\demo\. Every hash is
// really computed (the hash-links verify, so the integrity banner reads
// honestly), but the signing key is a throwaway derived at generation
// time and the sessions never happened. The server marks everything
// derived from this file with `demo: true` and the pages banner it.
//
// Run:  node tower/demo/make-demo-chain.mjs
// Writes: tower/demo/demo-chain.jsonl (idempotent: same content shape,
// fresh hashes, each run).

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GENESIS = '0'.repeat(64);
const DAY = 86400000;
// Fixed epoch so the demo reads the same for everyone: three days ending
// "recently" relative to generation time, rounded to local midnight.
const now = Date.now();
const d0 = now - 2 * DAY;

const sha = s => createHash('sha256').update(s).digest('hex');
const dig16 = s => sha(s).slice(0, 16);
const MATCHER = dig16('demo-matcher-build');
const PARSER = dig16('demo-parser-build');

let seq = 0;
let prevHash = GENESIS;
const entries = [];
function add(ts, payload) {
  const e = { seq: seq++, timestamp: ts, payload, prevHash };
  e.hash = sha(prevHash + '\n' + JSON.stringify(payload));
  prevHash = e.hash;
  entries.push(e);
}

function open(ts, id, mode, cwd) {
  add(ts, {
    type: 'session-open', sessionId: id, openIndex: 0, source: 'startup',
    cwd, transcriptPath: `C:\\demo\\.claude\\projects\\demo\\${id}.jsonl`,
    chainHeadAtOpen: seq ? { seq: seq - 1, hash: prevHash } : null,
    chainLengthAtOpen: seq,
    verifiedAtOpen: { ok: true },
    policy: { version: 2, mode, modes: { 'self-mod': 'gate', 'egress-other': mode === 'herded' ? 'gate' : 'warn' }, digest: dig16('demo-policy-' + mode) },
    hooks: { readable: true, preToolUse: true, postToolUse: true, sessionEnd: true },
    toolPins: null, toolDefs: null, toolPinDiff: null,
    toolPinDiffSummary: 'harness exposed no tool listing at session-open',
    toolPinSchemaVersion: 'tp/1',
    observer: {
      schema: 'observer/1', packageVersion: '0.0.0-demo',
      matcher: { schema: 'matcher/1', hash: MATCHER },
      parser: { schema: 'parser/1', hash: PARSER }
    },
    harness: { name: 'claude-code', basis: 'declared' },
    lotorVersion: 1, timestamp: ts
  });
}

function gate(ts, decision, action, ruleId, extra = {}) {
  add(ts, {
    type: 'gated-action', decision, action,
    ruleId, paramsDigestCanonical: sha('demo-params-' + action + ts),
    heldMs: extra.heldMs ?? null, matcherHash: MATCHER,
    ...(decision === 'approved' ? { approvalNonce: 'demo-' + dig16(String(ts)) } : {}),
    ...(extra.reason ? { reason: extra.reason } : {}),
    timestamp: ts
  });
}

function warn(ts, ruleId, tool) {
  add(ts, { type: 'policy-warn', ruleId, tool, paramsDigest: dig16('w' + ts), matcherHash: MATCHER, timestamp: ts });
}

function egress(ts, ruleId, tool) {
  add(ts, { type: 'egress-event', ruleId, tool, paramsDigest: dig16('e' + ts), responseDigest: dig16('r' + ts), responseOk: true, matcherHash: MATCHER, timestamp: ts });
}

function close(ts, id, model, opts) {
  add(ts, {
    session: {
      id, model, startedAt: new Date(opts.start).toISOString(),
      endedAt: new Date(ts).toISOString(), subsession: 0
    },
    counts: { turns: opts.turns, toolCalls: opts.tools, failures: opts.failures ?? 0, transcriptEntries: opts.turns * 3, assistantMessages: opts.turns },
    cost: {
      inputTokens: opts.turns * 900, outputTokens: opts.out, cacheCreationTokens: 0, cacheReadTokens: opts.turns * 4000,
      note: 'tokens only; no USD in source', schema: 'cost/3',
      byModel: { [model]: { inputTokens: opts.turns * 900, outputTokens: opts.out, cacheCreationTokens: 0, cacheReadTokens: opts.turns * 4000, messages: opts.turns } }
    },
    receiptSchema: 'receipt/2',
    transcriptHash: sha('demo-transcript-' + id),
    ran: opts.ran.map((t, i) => ({ tool: t, id: 'demo-' + i, paramsDigest: dig16(t + i), paramsDigestCanonical: sha(t + i) })),
    touched: opts.touched.map(p => ({ path: p, via: 'edit' })),
    failed: [],
    sent: { items: [], captureNote: 'self-attested; outbound not fully derivable from JSONL' },
    timestamp: ts
  });
}

// ---- Day 1: Row A (cloud model), herded. The gate denies twice, Isaac
// signs once, the work lands. One stale signature so the enum shows.
const a = 'demo-row-a-0001-4bones-000000000001';
open(d0 + 9 * 3600000, a, 'herded', 'C:\\demo\\project');
gate(d0 + 9.2 * 3600000, 'denied', 'Edit', 'self-mod', { reason: 'no approval token provided', heldMs: 0 });
gate(d0 + 9.4 * 3600000, 'stale_signature', 'Edit', 'self-mod', { reason: 'approval token is stale (signed 63 min ago; ceiling is 60 min)', heldMs: 3780000 });
gate(d0 + 9.5 * 3600000, 'approved', 'Edit', 'self-mod', { heldMs: 91000 });
close(d0 + 11 * 3600000, a, 'demo-cloud-frontier', {
  start: d0 + 9 * 3600000, turns: 24, tools: 31, out: 18400,
  ran: ['Read', 'Read', 'Edit', 'Bash', 'Edit'],
  touched: ['C:\\demo\\project\\src\\app.js', 'C:\\demo\\project\\test\\app.test.js']
});

// ---- Day 2: Row B (local model), grazing. Warns record, nothing stops.
const b = 'demo-row-b-0002-4bones-000000000002';
open(d0 + DAY + 10 * 3600000, b, 'grazing', 'C:\\demo\\project');
warn(d0 + DAY + 10.3 * 3600000, 'opaque-exec', 'Bash');
warn(d0 + DAY + 10.8 * 3600000, 'egress-other', 'WebFetch');
close(d0 + DAY + 12 * 3600000, b, 'demo-local-14b', {
  start: d0 + DAY + 10 * 3600000, turns: 41, tools: 26, failures: 2, out: 9100,
  ran: ['Read', 'Bash', 'Edit', 'WebFetch'],
  touched: ['C:\\demo\\project\\src\\app.js']
});

// ---- Day 3: Row C, loose. Egress recorded; a session that never closed
// (the abnormal-exit case the open-receipt design exists for).
const c = 'demo-row-c-0003-4bones-000000000003';
open(d0 + 2 * DAY + 9 * 3600000, c, 'loose', 'C:\\demo\\project');
egress(d0 + 2 * DAY + 9.4 * 3600000, 'egress-other', 'WebFetch');
gate(d0 + 2 * DAY + 9.6 * 3600000, 'approved', 'PowerShell', 'opaque-exec', { heldMs: 42000 });
close(d0 + 2 * DAY + 10.5 * 3600000, c, 'demo-cloud-frontier', {
  start: d0 + 2 * DAY + 9 * 3600000, turns: 12, tools: 14, out: 6200,
  ran: ['Read', 'PowerShell', 'Write'],
  touched: ['C:\\demo\\project\\docs\\report.md']
});
const dGhost = 'demo-crashed-0004-neverclosed-0004';
open(d0 + 2 * DAY + 11 * 3600000, dGhost, 'loose', 'C:\\demo\\scratch');
// no close for dGhost, on purpose: an open with no close IS the signal.

writeFileSync(join(HERE, 'demo-chain.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
console.log(`wrote ${entries.length} demo receipts to demo-chain.jsonl (head ${prevHash.slice(0, 16)}...)`);
