/**
 * test/grant-check.test.js
 *
 * The runtime grant resolver: src/grant/check.js
 *
 * This is the module the enforcement hook consults after no single-use
 * token was found. Its only job is to answer "does a signed grant cover
 * this?" and it must always answer, never throw, because the caller is a
 * deny path and an escaping exception would be read by the hook's outer
 * handler as an engine error and silently ALLOW.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveGrant, countUses } from '../src/grant/check.js';
import { signGrant } from '../src/grant/grant-schema.js';

const NOW = 1_000_000;
const SESSION = 'sess-abc';
const EDIT_REQ = { action: 'Edit', params: { file_path: 'src/mcp/server.js' } };
const BASH_REQ = { action: 'Bash', params: { command: 'git push -u origin feat/x' } };

let home;
let keys;

/** Write an approval public key file in the format the gate expects. */
function writePubkey(dir, publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  const fp = crypto.createHash('sha256').update(jwk.x).digest('hex').slice(0, 32);
  fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'keys', 'approval.pub'), `ed25519:${jwk.x}:fingerprint:${fp}\n`);
}

function makeGrant(privateKey, overrides = {}) {
  return signGrant({
    type: 'delegation-grant',
    grantId: overrides.grantId || 'g-1',
    sessionId: overrides.sessionId || SESSION,
    requests: overrides.requests || [EDIT_REQ, BASH_REQ],
    maxActions: overrides.maxActions ?? 3,
    issuedAt: NOW,
    expiresAt: overrides.expiresAt ?? NOW + 60_000,
    nonce: overrides.nonce || 'n1'
  }, privateKey);
}

function putGrant(grant, name = 'g.json') {
  fs.mkdirSync(path.join(home, 'grants'), { recursive: true });
  fs.writeFileSync(path.join(home, 'grants', name), JSON.stringify(grant));
}

function clearGrants() {
  try { fs.rmSync(path.join(home, 'grants'), { recursive: true, force: true }); } catch { /* ok */ }
}

const ask = (over = {}) => resolveGrant({
  actionRequest: 'actionRequest' in over ? over.actionRequest : EDIT_REQ,
  sessionId: 'sessionId' in over ? over.sessionId : SESSION,
  home,
  // `in` rather than `||`: an explicit null is a case under test (an
  // unreadable chain) and `|| []` would quietly turn it into the happy
  // path, so the test would pass without reaching the code it names.
  chainEntries: 'chainEntries' in over ? over.chainEntries : [],
  now: over.now ?? NOW
});

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-grant-check-'));
  keys = crypto.generateKeyPairSync('ed25519');
  writePubkey(home, keys.publicKey);
});

after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('a valid grant covers the enumerated request', () => {
  it('allows an enumerated file edit', () => {
    clearGrants();
    putGrant(makeGrant(keys.privateKey));
    const r = ask();
    assert.strictEqual(r.allow, true, `reason=${r.reason}`);
    assert.strictEqual(r.grantId, 'g-1');
    assert.strictEqual(r.useIndex, 1, 'first use is index 1');
  });

  it('allows an enumerated shell command', () => {
    // Bash was refused outright by the previous, path-scoped version. It is
    // allowed now because the comparison is byte equality over the gate's
    // own canonical form, identical to what a single-use token does, so
    // there is no matcher left to get it wrong.
    clearGrants();
    putGrant(makeGrant(keys.privateKey));
    const r = ask({ actionRequest: BASH_REQ });
    assert.strictEqual(r.allow, true, `reason=${r.reason}`);
  });

  it('refuses a request that is not enumerated', () => {
    clearGrants();
    putGrant(makeGrant(keys.privateKey));
    const r = ask({ actionRequest: { action: 'Bash', params: { command: 'rm -rf /' } } });
    assert.strictEqual(r.allow, false);
  });
});

describe('the ceilings hold', () => {
  it('refuses once maxActions uses are on the chain', () => {
    clearGrants();
    putGrant(makeGrant(keys.privateKey, { maxActions: 2 }));
    const used = [
      { payload: { type: 'grant-use', grantId: 'g-1' } },
      { payload: { type: 'grant-use', grantId: 'g-1' } }
    ];
    const r = ask({ chainEntries: used });
    assert.strictEqual(r.allow, false);
    assert.match(r.reason, /ceiling/i);
  });

  it('refuses after expiry', () => {
    clearGrants();
    putGrant(makeGrant(keys.privateKey));
    const r = ask({ now: NOW + 120_000 });
    assert.strictEqual(r.allow, false);
    assert.match(r.reason, /expired/i);
  });

  it('refuses in a different session', () => {
    clearGrants();
    putGrant(makeGrant(keys.privateKey));
    const r = ask({ sessionId: 'someone-else' });
    assert.strictEqual(r.allow, false);
    assert.match(r.reason, /session/i);
  });
});

describe('the use count comes from the chain, not a counter file', () => {
  it('counts only grant-use entries for the same grantId', () => {
    const entries = [
      { payload: { type: 'grant-use', grantId: 'g-1' } },
      { payload: { type: 'grant-use', grantId: 'g-OTHER' } },
      { payload: { type: 'session-open', grantId: 'g-1' } },
      { payload: { type: 'grant-use', grantId: 'g-1' } }
    ];
    assert.strictEqual(countUses(entries, 'g-1'), 2);
  });

  it('treats an unreadable chain as unlimited use, and so refuses', () => {
    // If the count cannot be established the ceiling cannot be enforced.
    // Unknown must not read as zero.
    assert.strictEqual(countUses(null, 'g-1'), Number.POSITIVE_INFINITY);
    clearGrants();
    putGrant(makeGrant(keys.privateKey));
    const r = ask({ chainEntries: null });
    assert.strictEqual(r.allow, false, 'an unknown use count must refuse');
  });
});

describe('it refuses rather than throwing, on every bad input', () => {
  it('refuses with no session id', () => {
    clearGrants();
    putGrant(makeGrant(keys.privateKey));
    const r = ask({ sessionId: undefined });
    assert.strictEqual(r.allow, false);
    assert.match(r.reason, /session-bound/);
  });

  it('refuses with no grants on file', () => {
    clearGrants();
    const r = ask();
    assert.strictEqual(r.allow, false);
    assert.match(r.reason, /no grants on file/);
  });

  it('refuses a forged grant', () => {
    clearGrants();
    const other = crypto.generateKeyPairSync('ed25519');
    putGrant(makeGrant(other.privateKey));
    const r = ask();
    assert.strictEqual(r.allow, false);
    assert.match(r.reason, /signature/i);
  });

  it('skips a corrupt grant file without dying', () => {
    clearGrants();
    fs.mkdirSync(path.join(home, 'grants'), { recursive: true });
    fs.writeFileSync(path.join(home, 'grants', 'broken.json'), '{ not json');
    putGrant(makeGrant(keys.privateKey));
    const r = ask();
    assert.strictEqual(r.allow, true, `a corrupt neighbour must not disable a valid grant; reason=${r.reason}`);
  });

  it('never throws, whatever it is handed', () => {
    clearGrants();
    putGrant(makeGrant(keys.privateKey));
    for (const bad of [undefined, null, {}, { action: 'Edit' }, { params: null }, 'x', 7]) {
      assert.doesNotThrow(() => {
        const r = resolveGrant({ actionRequest: bad, sessionId: SESSION, home, chainEntries: [], now: NOW });
        assert.strictEqual(r.allow, false);
      });
    }
  });
});
