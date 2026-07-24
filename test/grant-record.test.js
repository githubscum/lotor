/**
 * test/grant-record.test.js
 *
 * CL-005: the grant must be recorded on the chain at issue time.
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS SHAPED LIKE THIS
 *   The first build wrote a grant to a file and recorded nothing. Only
 *   `grant-use` entries reached the chain, so the log could say something
 *   was authorised under grant X and used twice, and could not say WHAT
 *   that grant authorised. That lived solely in a deletable file.
 *
 *   The design document specified the behaviour in plain language: "the
 *   chain holds what was authorized and what was done with it, separately
 *   and in order; those two can be diffed." Only the second half was built,
 *   and 338 tests passed, because every one of them asked whether the
 *   verifier behaves correctly and none asked whether the artefact the
 *   design promised exists.
 *
 *   So the central test here is not "does recordGrantOnChain append a
 *   row". It is "can the diff the design named actually be performed, from
 *   the chain alone, with every grant file deleted". A test that only
 *   checked the function would have missed the point the same way the
 *   implementation did.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildGrant, recordGrantOnChain } from '../src/grant/issue.js';
import { verifyGrantSignature } from '../src/grant/grant-schema.js';
import { createStore } from '../src/store/index.js';

const NOW = 1_000_000;
const SESSION = 'sess-record';
const EDIT_REQ = { action: 'Edit', params: { file_path: 'src/mcp/server.js' } };
const BASH_REQ = { action: 'Bash', params: { command: 'git push -u origin feat/x' } };

let home;
let kp;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-grant-record-'));
  kp = crypto.generateKeyPairSync('ed25519');
});

after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

function issue(overrides = {}) {
  return buildGrant({
    grantId: overrides.grantId || 'g-rec-1',
    sessionId: SESSION,
    requests: [EDIT_REQ, BASH_REQ],
    maxActions: 4,
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    nonce: overrides.nonce || 'nrec',
    ...overrides
  }, kp.privateKey);
}

/** Everything on the chain right now, newest last. */
function chainPayloads() {
  return createStore(home).entries.map(e => e.payload).filter(Boolean);
}

describe('the authorisation reaches the chain, not just a file', () => {
  it('appends one entry when a grant is issued', () => {
    const grant = issue({ grantId: 'g-a', nonce: 'na' });
    const entry = recordGrantOnChain(home, grant);
    assert.ok(entry, 'an entry must be returned');
    assert.ok(Number.isInteger(entry.seq), 'the entry must have a sequence number');

    const recorded = chainPayloads().filter(p => p.type === 'delegation-grant' && p.grantId === 'g-a');
    assert.strictEqual(recorded.length, 1);
  });

  it('records the enumerated requests in full, not a digest', () => {
    // A digest would let someone verify a grant file they still have. It
    // would not let them reconstruct what was authorised once the file is
    // gone, and reconstruction is the requirement.
    const grant = issue({ grantId: 'g-b', nonce: 'nb' });
    recordGrantOnChain(home, grant);
    const p = chainPayloads().find(x => x.type === 'delegation-grant' && x.grantId === 'g-b');

    assert.deepStrictEqual(p.requests, [EDIT_REQ, BASH_REQ]);
    assert.match(JSON.stringify(p.requests), /git push -u origin feat\/x/, 'the exact command must be readable');
  });

  it('records the ceiling, the window and the session binding', () => {
    const grant = issue({ grantId: 'g-c', nonce: 'nc' });
    recordGrantOnChain(home, grant);
    const p = chainPayloads().find(x => x.type === 'delegation-grant' && x.grantId === 'g-c');
    assert.strictEqual(p.sessionId, SESSION);
    assert.strictEqual(p.maxActions, 4);
    assert.strictEqual(p.expiresAt, NOW + 60_000);
  });
});

describe('the recorded entry is independently verifiable', () => {
  it('carries a signature that validates against the approval key', () => {
    // Without this, an entry claiming "grant X authorised Y" would rest
    // entirely on the chain key, which KNOWN-LIMITS discloses is stored
    // unencrypted. The approval key is passphrase-derived and never on disk,
    // so including its signature means two independent keys back the record.
    const grant = issue({ grantId: 'g-d', nonce: 'nd' });
    recordGrantOnChain(home, grant);
    const p = chainPayloads().find(x => x.type === 'delegation-grant' && x.grantId === 'g-d');

    const reconstructed = {
      type: 'delegation-grant',
      grantId: p.grantId,
      sessionId: p.sessionId,
      requests: p.requests,
      maxActions: p.maxActions,
      issuedAt: p.issuedAt,
      expiresAt: p.expiresAt,
      nonce: p.nonce,
      signature: p.signature
    };
    assert.strictEqual(verifyGrantSignature(reconstructed, kp.publicKey), true,
      'the grant must be reconstructable from the chain and still verify');
  });

  it('fails to verify if the recorded requests were altered', () => {
    const grant = issue({ grantId: 'g-e', nonce: 'ne' });
    recordGrantOnChain(home, grant);
    const p = chainPayloads().find(x => x.type === 'delegation-grant' && x.grantId === 'g-e');

    const tampered = {
      type: 'delegation-grant',
      grantId: p.grantId, sessionId: p.sessionId,
      requests: [...p.requests, { action: 'Bash', params: { command: 'curl evil.example' } }],
      maxActions: p.maxActions, issuedAt: p.issuedAt, expiresAt: p.expiresAt,
      nonce: p.nonce, signature: p.signature
    };
    assert.strictEqual(verifyGrantSignature(tampered, kp.publicKey), false);
  });
});

describe('THE POINT: the diff is possible from the chain alone', () => {
  it('answers what was authorised and what was spent, with every grant file deleted', () => {
    // This is the assertion whose absence let CL-005 ship. It does not test
    // a function; it tests the property the design promised.
    const grant = issue({ grantId: 'g-audit', nonce: 'naudit', maxActions: 3 });
    recordGrantOnChain(home, grant);

    const store = createStore(home);
    store.appendReceipt({ type: 'grant-use', grantId: 'g-audit', useIndex: 1, tool: 'Bash', timestamp: NOW + 1 });
    store.appendReceipt({ type: 'grant-use', grantId: 'g-audit', useIndex: 2, tool: 'Bash', timestamp: NOW + 2 });

    // Delete every grant file. The chain must still answer both questions.
    fs.rmSync(path.join(home, 'grants'), { recursive: true, force: true });

    const payloads = chainPayloads();
    const authorised = payloads.find(p => p.type === 'delegation-grant' && p.grantId === 'g-audit');
    const spent = payloads.filter(p => p.type === 'grant-use' && p.grantId === 'g-audit');

    assert.ok(authorised, 'what was authorised must survive the file being gone');
    assert.strictEqual(authorised.requests.length, 2, 'and it must say what, specifically');
    assert.strictEqual(spent.length, 2, 'what was spent must be there too');
    assert.strictEqual(authorised.maxActions - spent.length, 1, 'the remaining headroom is derivable');

    // And the two can be compared: every use is against an authorisation
    // that is present and readable.
    for (const use of spent) {
      assert.strictEqual(use.grantId, authorised.grantId);
      assert.ok(use.useIndex <= authorised.maxActions, 'no use may exceed what was authorised');
    }
  });

  it('makes a use with no matching authorisation detectable', () => {
    // The other half of a diff: uses that cite a grant the chain never
    // recorded are visible as orphans rather than blending in.
    const store = createStore(home);
    store.appendReceipt({ type: 'grant-use', grantId: 'g-nonexistent', useIndex: 1, tool: 'Bash', timestamp: NOW + 9 });

    const payloads = chainPayloads();
    const grantIds = new Set(payloads.filter(p => p.type === 'delegation-grant').map(p => p.grantId));
    const orphans = payloads.filter(p => p.type === 'grant-use' && !grantIds.has(p.grantId));

    assert.ok(orphans.length >= 1, 'an unauthorised-looking use must stand out');
    assert.ok(orphans.some(o => o.grantId === 'g-nonexistent'));
  });
});
