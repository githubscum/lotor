/**
 * KNOWN-LIMITS 74: `query_receipts({ sessionId })` dropped every gate row.
 *
 * WHAT WAS WRONG
 *   Limit 35 (closed 2026-09-07) made every `gated-action` receipt carry
 *   `sessionId`, and the pre-tool-use hook had already put it on the
 *   `both-layers-permissive` policy-warn. The chain was attributable. The
 *   reader was not: `summarizeEntry` built the `gated-action` and
 *   `policy-warn` summaries without `sessionId`, and `handleQueryReceipts`
 *   filters on the summaries, so a session-filtered query returned only the
 *   `session` and `session-open` rows. On 2026-09-28 a session's own Bash
 *   denial (seq 24910, "no approval token provided", sessionId on the payload)
 *   was missing from `query_receipts({ sessionId })`, and the session read as
 *   having done nothing gated. Absent is not zero, one surface over.
 *
 * THE RULE BEING TESTED
 *   The summary reports `sessionId` as written. Three states, not two:
 *     key absent  the row predates limit 35, or its writer never sets one
 *     null        the writer set the key and had no id to put in it
 *     a string    the session that caused the row
 *   The first two are different facts and must stay different. Collapsing
 *   null into absent hides that the hook ran without an id; inventing an id
 *   for either would be attribution by guess, which limit 35 refused.
 *
 * FAIL-FIRST (2026-07-24 rule)
 *   Written first and run against the unpatched server.js on branch
 *   query-session-filter, 2026-09-28. RED, 6 of 9:
 *     - the filter returns exactly the target session's rows      failed
 *     - gated-action summary carries the id and the rule          failed
 *     - policy-warn summary carries the id                        failed
 *     - null stays null through the summary and the JSON          failed
 *     - a session with only gate rows is not reported as empty    failed
 *     - default branch keeps a null id rather than dropping it    failed
 *   The three that passed are the CONTROLs and say so in their names: the
 *   absent-key row, exclusion from another session's view, and the shapes
 *   that never carry an id. They must hold on both sides of the fix; a
 *   control that failed against the break would be testing the wrong thing.
 *   GREEN, 9 of 9, after the fix.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store/index.js';

// Point the server's singleton store at a temp home BEFORE importing it, the
// same way mcp.test.js does. The import is dynamic because static imports are
// hoisted above the assignment.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-l74-'));
process.env.LOTOR_HOME = TEST_HOME;

const { handleQueryReceipts, summarizeEntry } = await import('../src/mcp/server.js');

const TARGET = 'sess-target-74';
const OTHER = 'sess-other-74';

/**
 * The fixture, in chain order. Each payload is the shape its writer produces
 * (src/gate/index.js, bin/hook-pre-tool-use.js, bin/hook-post-tool-use.js,
 * bin/hook-session-start.js, src/ingest, src/grant/issue.js), trimmed to the
 * fields that matter here. `label` is test-side only and never written.
 */
const FIXTURE = [
  { label: 'open-target', payload: {
    type: 'session-open', sessionId: TARGET, source: 'startup', cwd: '/work'
  } },
  // The live case: a denial carrying the session id since limit 35.
  { label: 'deny-target', payload: {
    type: 'gated-action', decision: 'denied', action: 'Bash', ruleId: 'self-mod',
    sessionId: TARGET, paramsDigestCanonical: 'd'.repeat(64), heldMs: 314,
    reason: 'no approval token provided', timestamp: 1790573118054
  } },
  { label: 'approve-target', payload: {
    type: 'gated-action', decision: 'approved', action: 'Edit', ruleId: 'self-mod',
    sessionId: TARGET, paramsDigestCanonical: 'e'.repeat(64), heldMs: 9000,
    approvalNonce: 'n0nce', timestamp: 1790573119000
  } },
  // The one policy-warn shape that carries the id (both-layers-permissive).
  { label: 'warn-target', payload: {
    type: 'policy-warn', ruleId: 'both-layers-permissive', sessionId: TARGET,
    tool: 'Bash', lotorMode: 'loose', harnessMode: 'bypassPermissions', timestamp: 1790573120000
  } },
  // Controls: another session's gate rows must stay out of the target's view.
  { label: 'deny-other', payload: {
    type: 'gated-action', decision: 'denied', action: 'Write', ruleId: 'self-mod',
    sessionId: OTHER, reason: 'no approval token provided', timestamp: 1790573121000
  } },
  { label: 'warn-other', payload: {
    type: 'policy-warn', ruleId: 'both-layers-permissive', sessionId: OTHER,
    tool: 'Bash', timestamp: 1790573122000
  } },
  // Written before 2026-09-07: no sessionId key at all.
  { label: 'deny-prelimit35', payload: {
    type: 'gated-action', decision: 'denied', action: 'PowerShell',
    reason: 'no approval token provided', timestamp: 1785000000000
  } },
  // Written after limit 35 by a hook that had no session id: the key is null.
  { label: 'deny-null', payload: {
    type: 'gated-action', decision: 'denied', action: 'Bash', ruleId: 'egress-other',
    sessionId: null, reason: 'no approval token provided', timestamp: 1790573123000
  } },
  // The ordinary warn shape never carries the key.
  { label: 'warn-nokey', payload: {
    type: 'policy-warn', ruleId: 'push-force', tool: 'Bash',
    paramsDigest: 'f'.repeat(16), timestamp: 1790573124000
  } },
  // Default branch: egress-event has no id; delegation-grant carries one.
  { label: 'egress-nokey', payload: {
    type: 'egress-event', ruleId: 'egress-other', tool: 'Bash',
    paramsDigest: 'a'.repeat(16), responseOk: true, timestamp: 1790573125000
  } },
  { label: 'grant-target', payload: {
    type: 'delegation-grant', grantId: 'g-74', sessionId: TARGET,
    maxActions: 2, timestamp: 1790573126000
  } },
  // Default branch with an explicit null, synthetic: a future typed row whose
  // writer had no id. Reported as null, not dropped.
  { label: 'future-null', payload: {
    type: 'future-row', sessionId: null, timestamp: 1790573127000
  } },
  // The session receipt closes the target session.
  { label: 'close-target', payload: {
    session: { id: TARGET, model: 'test-model', subsession: 0 },
    ran: [], touched: [], failed: [], cost: {},
    counts: { turns: 3, toolCalls: 2, failures: 0 }
  } }
];

/** label -> seq, filled once the fixture is on a real, signed chain. */
const SEQ = {};

before(() => {
  const store = createStore(TEST_HOME);
  for (const row of FIXTURE) {
    const entry = store.appendReceipt(row.payload);
    SEQ[row.label] = entry.seq;
  }
});

/** The unfiltered summary for one fixture row, found by seq. */
function summaryOf(label) {
  const all = handleQueryReceipts({}).receipts;
  const s = all.find(r => r.seq === SEQ[label]);
  assert.ok(s, `fixture row ${label} is missing from the unfiltered query`);
  return s;
}

describe('KNOWN-LIMITS 74: query_receipts session filter keeps gate rows', () => {
  it('the filter returns exactly the target session\'s rows, gate rows included, most recent first', () => {
    const got = handleQueryReceipts({ sessionId: TARGET }).receipts.map(r => r.seq);
    const want = ['open-target', 'deny-target', 'approve-target', 'warn-target',
      'grant-target', 'close-target'].map(l => SEQ[l]).sort((a, b) => b - a);
    assert.deepEqual(got, want,
      'a session-filtered query must include that session\'s gated-action and ' +
      'policy-warn rows. Before the fix it returned only session-open and the ' +
      'session receipt, so the session read as having done nothing gated.');
  });

  it('gated-action summary carries the id and the rule, as written', () => {
    const s = summaryOf('deny-target');
    assert.equal(s.type, 'gated-action');
    assert.equal(s.sessionId, TARGET);
    assert.equal(s.decision, 'denied');
    assert.equal(s.action, 'Bash');
    assert.equal(s.reason, 'no approval token provided');
    // The payload has carried ruleId since the 2026-08-15 enrichment; the
    // summary said there was none.
    assert.equal(s.ruleId, 'self-mod');
    // Still a summary: digests and timings stay on the chain.
    assert.ok(!('paramsDigestCanonical' in s));
    assert.ok(!('heldMs' in s));
    assert.ok(!('toolCalls' in s), 'absent is not zero: a gate row has no counts');

    const a = summaryOf('approve-target');
    assert.equal(a.sessionId, TARGET, 'the approved shape carries it too');
    assert.equal(a.decision, 'approved');
  });

  it('policy-warn summary carries the id when the payload has it', () => {
    const s = summaryOf('warn-target');
    assert.equal(s.type, 'policy-warn');
    assert.equal(s.ruleId, 'both-layers-permissive');
    assert.equal(s.sessionId, TARGET);
  });

  it('null stays null through the summary and through the JSON the tool returns', () => {
    const s = summaryOf('deny-null');
    assert.ok('sessionId' in s, 'the key was written, so the summary reports it');
    assert.equal(s.sessionId, null, 'and reports it as null, never an invented id');
    const wire = JSON.parse(JSON.stringify(s));
    assert.ok('sessionId' in wire && wire.sessionId === null,
      'null must survive serialisation, or the wire collapses it into absent');
  });

  it('CONTROL: a pre-limit-35 row has no key, and the summary does not invent one', () => {
    const s = summaryOf('deny-prelimit35');
    assert.ok(!('sessionId' in s), 'absent on the payload is absent in the summary');
    assert.ok(!('sessionId' in JSON.parse(JSON.stringify(s))));
    assert.ok(!('ruleId' in s), 'pre-enrichment row: no rule id recorded, none reported');
    assert.equal(s.decision, 'denied');
  });

  it('CONTROL: the other session\'s rows, and rows with no id, are excluded from the target\'s view', () => {
    const got = new Set(handleQueryReceipts({ sessionId: TARGET }).receipts.map(r => r.seq));
    for (const l of ['deny-other', 'warn-other', 'deny-prelimit35', 'deny-null',
      'warn-nokey', 'egress-nokey', 'future-null']) {
      assert.ok(!got.has(SEQ[l]), `${l} must not match ${TARGET}`);
    }
  });

  it('a session with only gate rows is not reported as empty', () => {
    // The other session has no open and no close in the fixture, only a denial
    // and a warn. Before the fix its filtered view was [], which is the exact
    // "did nothing" misreading this entry is about.
    const other = handleQueryReceipts({ sessionId: OTHER }).receipts.map(r => r.seq);
    assert.deepEqual(other, [SEQ['warn-other'], SEQ['deny-other']],
      'the other session sees exactly its own two gate rows');
  });

  it('default branch keeps a null id rather than dropping it', () => {
    const s = summaryOf('future-null');
    assert.equal(s.type, 'future-row');
    assert.ok('sessionId' in s);
    assert.equal(s.sessionId, null);
    // And a string id on a default-branch row still matches (delegation-grant).
    assert.equal(summaryOf('grant-target').sessionId, TARGET);
  });

  it('CONTROL: shapes that never carry an id still omit it', () => {
    assert.ok(!('sessionId' in summaryOf('warn-nokey')), 'ordinary policy-warn');
    assert.ok(!('sessionId' in summaryOf('egress-nokey')), 'egress-event');
    // A ledger-head row (kind-discriminated, snake_case, no id in either
    // spelling on the live chain) is summarised without one.
    const lh = summarizeEntry({
      seq: 727, timestamp: 1785000000000, hash: 'c'.repeat(64),
      payload: { kind: 'ledger-head', limit_id: 11, entry_count: 1, head_hash: 'b'.repeat(64) }
    });
    assert.equal(lh.type, 'ledger-head');
    assert.ok(!('sessionId' in lh));
  });
});
