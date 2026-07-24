/**
 * test/grant-verify.test.js
 *
 * The grant verifier, after the 2026-07-23 rework from enumerated file
 * paths to enumerated action requests.
 *
 * The property under test throughout: a grant is N single-use tokens with
 * one signature, one expiry, and one ceiling. It must be exactly as strict
 * as a token on each individual request, and strict in three further ways a
 * token does not need to be (session, clock, count).
 *
 * Inputs are written out literally. An earlier file in this directory drew
 * every case from the module's own exported list, so it could not fail.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { checkGrant, requestRefusalReason } from '../src/grant/verify.js';
import { buildGrant, BuildGrantError } from '../src/grant/issue.js';
import { signGrant } from '../src/grant/grant-schema.js';

const NOW = 1_000_000;
const SESSION = 'sess-1';

// The two shapes that matter in practice: a file edit and a shell command.
// Bash is the one the path-based design could not express at all, and it is
// the one that generates most of the measured friction.
const EDIT_REQ = { action: 'Edit', params: { file_path: 'src/mcp/server.js' } };
const BASH_REQ = { action: 'Bash', params: { command: 'git push -u origin feat/x' } };

function keypair() {
  return crypto.generateKeyPairSync('ed25519');
}

function makeGrant(kp, overrides = {}) {
  return buildGrant({
    grantId: 'g-1',
    sessionId: SESSION,
    requests: [EDIT_REQ, BASH_REQ],
    maxActions: 5,
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    nonce: 'n1',
    ...overrides
  }, kp.privateKey);
}

const check = (grant, kp, actionRequest, over = {}) => checkGrant(grant, {
  sessionId: 'sessionId' in over ? over.sessionId : SESSION,
  actionRequest,
  now: over.now ?? NOW,
  usesSoFar: over.usesSoFar ?? 0
}, 'publicKey' in over ? over.publicKey : kp.publicKey);

describe('an enumerated request is allowed', () => {
  it('allows a file edit that was enumerated', () => {
    const kp = keypair();
    const r = check(makeGrant(kp), kp, EDIT_REQ);
    assert.strictEqual(r.allow, true, `reason=${r.reason}`);
    assert.strictEqual(r.matchIndex, 0);
  });

  it('allows a shell command that was enumerated', () => {
    // The case the path-scoped design could not express. This is the whole
    // reason for the rework: the measured friction is Bash, not Edit.
    const kp = keypair();
    const r = check(makeGrant(kp), kp, BASH_REQ);
    assert.strictEqual(r.allow, true, `reason=${r.reason}`);
    assert.strictEqual(r.matchIndex, 1);
  });

  it('allows the same request repeatedly, up to the ceiling', () => {
    const kp = keypair();
    const g = makeGrant(kp);
    for (const uses of [0, 1, 2, 3, 4]) {
      assert.strictEqual(check(g, kp, EDIT_REQ, { usesSoFar: uses }).allow, true);
    }
  });
});

describe('anything not enumerated is refused', () => {
  it('refuses a different file', () => {
    const kp = keypair();
    const r = check(makeGrant(kp), kp, { action: 'Edit', params: { file_path: 'src/mcp/other.js' } });
    assert.strictEqual(r.allow, false);
    assert.match(r.reason, /not one of the requests/);
  });

  it('refuses a different action on the same file', () => {
    const kp = keypair();
    assert.strictEqual(check(makeGrant(kp), kp, { action: 'Write', params: { file_path: 'src/mcp/server.js' } }).allow, false);
  });

  it('refuses a command differing by one character', () => {
    // Exact equality, not similarity. A grant for one command is not a
    // grant for commands that resemble it.
    const kp = keypair();
    assert.strictEqual(check(makeGrant(kp), kp, { action: 'Bash', params: { command: 'git push -u origin feat/y' } }).allow, false);
  });

  it('refuses an extra parameter on an otherwise matching request', () => {
    const kp = keypair();
    assert.strictEqual(check(makeGrant(kp), kp, { action: 'Bash', params: { command: 'git push -u origin feat/x', cwd: '/tmp' } }).allow, false);
  });
});

describe('the three limits a single-use token does not have', () => {
  it('refuses in a different session', () => {
    const kp = keypair();
    const r = check(makeGrant(kp), kp, EDIT_REQ, { sessionId: 'other' });
    assert.strictEqual(r.allow, false);
    assert.match(r.reason, /session/i);
  });

  it('refuses one millisecond past expiry', () => {
    const kp = keypair();
    const r = check(makeGrant(kp), kp, EDIT_REQ, { now: NOW + 60_001 });
    assert.strictEqual(r.allow, false);
    assert.match(r.reason, /expired/i);
  });

  it('refuses use number maxActions + 1', () => {
    const kp = keypair();
    const r = check(makeGrant(kp, { maxActions: 2 }), kp, EDIT_REQ, { usesSoFar: 2 });
    assert.strictEqual(r.allow, false);
    assert.match(r.reason, /ceiling/i);
  });
});

describe('signature integrity', () => {
  it('refuses a grant signed by the wrong key', () => {
    const kp = keypair();
    const r = check(makeGrant(keypair()), kp, EDIT_REQ);
    assert.strictEqual(r.allow, false);
    assert.match(r.reason, /signature/i);
  });

  it('refuses when any field of the grant is changed', () => {
    const kp = keypair();
    const g = makeGrant(kp);
    for (const mutate of [
      x => ({ ...x, maxActions: x.maxActions + 1 }),
      x => ({ ...x, expiresAt: x.expiresAt + 1 }),
      x => ({ ...x, sessionId: SESSION + ' ' }),
      x => ({ ...x, requests: [...x.requests, { action: 'Bash', params: { command: 'curl evil.example' } }] })
    ]) {
      assert.strictEqual(check(mutate(g), kp, EDIT_REQ).allow, false, 'a mutated grant must not verify');
    }
  });

  it('refuses an unsigned grant', () => {
    const kp = keypair();
    const { signature, ...unsigned } = makeGrant(kp);
    assert.strictEqual(check(unsigned, kp, EDIT_REQ).allow, false);
  });

  it('refuses with no public key', () => {
    const kp = keypair();
    assert.strictEqual(check(makeGrant(kp), kp, EDIT_REQ, { publicKey: null }).allow, false);
  });
});

describe('a grant carrying a request it may not is refused wholesale', () => {
  it('refuses even when the request being asked about is fine', () => {
    // Hand-signed to simulate a grant reaching the verifier without passing
    // issue-time checks. The bad entry must not be quietly skipped while a
    // good one matches: a tainted grant is evidence about the grant, not
    // about the one request being asked about.
    const kp = keypair();
    const tainted = signGrant({
      type: 'delegation-grant',
      grantId: 'g-tainted',
      sessionId: SESSION,
      requests: [EDIT_REQ, { action: 'Edit', params: { file_path: 'src/gate/index.js' } }],
      maxActions: 5,
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
      nonce: 'n2'
    }, kp.privateKey);

    const r = check(tainted, kp, EDIT_REQ);
    assert.strictEqual(r.allow, false, 'a tainted grant must be refused entirely');
    assert.match(r.reason, /may not/);
  });

  it('names core paths and escaping paths as refusable', () => {
    assert.ok(requestRefusalReason({ action: 'Edit', params: { file_path: 'src/gate/sign.js' } }));
    assert.ok(requestRefusalReason({ action: 'Edit', params: { file_path: '../elsewhere/x.js' } }));
    assert.strictEqual(requestRefusalReason(EDIT_REQ), null);
  });

  it('does not pretend to analyse shell commands', () => {
    // What a command touches is not knowable from its text. This function
    // says so by not claiming otherwise: a Bash request passes here, and
    // the control is that a human read the exact string before signing it.
    assert.strictEqual(requestRefusalReason({ action: 'Bash', params: { command: 'anything at all' } }), null);
  });
});

describe('it refuses rather than throwing, whatever it is handed', () => {
  it('never throws on junk', () => {
    const kp = keypair();
    const g = makeGrant(kp);
    for (const bad of [undefined, null, 0, 'x', [], {}, { requests: null }]) {
      assert.doesNotThrow(() => {
        assert.strictEqual(checkGrant(bad, { sessionId: SESSION, actionRequest: EDIT_REQ, now: NOW, usesSoFar: 0 }, kp.publicKey).allow, false);
        assert.strictEqual(checkGrant(g, bad, kp.publicKey).allow, false);
        assert.strictEqual(check(g, kp, bad).allow, false);
      });
    }
  });

  it('refuses a grant that enumerates nothing', () => {
    const kp = keypair();
    const empty = signGrant({
      type: 'delegation-grant', grantId: 'g-empty', sessionId: SESSION,
      requests: [], maxActions: 1, issuedAt: NOW, expiresAt: NOW + 1000, nonce: 'n3'
    }, kp.privateKey);
    const r = check(empty, kp, EDIT_REQ);
    assert.strictEqual(r.allow, false);
    assert.match(r.reason, /enumerates no requests/);
  });
});

describe('issue-time guards refuse while the signer can still fix it', () => {
  const kp = keypair();
  const bad = (input, re) => {
    assert.throws(() => buildGrant({
      sessionId: SESSION, requests: [EDIT_REQ], maxActions: 2,
      issuedAt: NOW, expiresAt: NOW + 1000, ...input
    }, kp.privateKey), re);
  };

  it('refuses a core path at issue time, not at use time', () => {
    bad({ requests: [{ action: 'Edit', params: { file_path: 'src/policy/index.js' } }] }, BuildGrantError);
  });

  it('refuses an empty request list', () => bad({ requests: [] }, BuildGrantError));
  it('refuses a missing session', () => bad({ sessionId: '' }, BuildGrantError));
  it('refuses a non-positive ceiling', () => bad({ maxActions: 0 }, BuildGrantError));
  it('refuses an expiry already past', () => bad({ expiresAt: NOW - 1 }, BuildGrantError));

  it('refuses a ceiling lower than the number of enumerated requests', () => {
    // Listing more capabilities than the ceiling can cover is almost
    // certainly a mistake, and one the signer would otherwise discover only
    // mid-session when a request they thought they had authorised is denied.
    bad({ requests: [EDIT_REQ, BASH_REQ], maxActions: 1 }, /lower than the number/);
  });
});
