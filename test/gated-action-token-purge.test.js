/**
 * test/gated-action-token-purge.test.js
 *
 * KNOWN-LIMITS 30: edit tokens are fungible per file, so signing twice builds
 * a grant by hand. For Edit/Write/NotebookEdit the canonical signed request is
 * the file_path and nothing else (content deliberately unsigned, limit 27),
 * so EVERY token for a given file validates against EVERY edit to that file.
 * Tokens are single-use by nonce but interchangeable and they ACCUMULATE:
 * sign the same path twice and the surplus sits in pending-approvals/
 * silently authorizing the next edit to that file, whatever its content.
 *
 * THE FIX (the direction limit 30 itself calls "the smallest and probably the
 * right one"): spending one token for a canonical request PURGES every other
 * stored token with the same request, inside the same lock that records the
 * nonce. An operator approving an action approved THAT ACTION, not a credit
 * balance. Surplus tokens can no longer exist for a spent request.
 *
 * Fail-first discipline (2026-07-24 rule, observed):
 *   - RED  on unpatched main (2173d231): the second edit below is APPROVED
 *     through the surplus token — the accumulation the listing describes.
 *   - GREEN on the patch: the second edit is DENIED (exit 2) and no token
 *     with that request survives on disk.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalizeRequest } from '../src/gate/sign.js';
import { createStore } from '../src/store/index.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO, 'bin', 'hook-pre-tool-use.js');

// A core self-mod path (src/gate/ is in selfModFragmentsForBase), edited via
// the Edit tool so the signed request is the path alone.
const CORE_PATH = '/repo/src/gate/index.js';

function editInput(oldStr, newStr) {
  return {
    session_id: 'l30-purge-test',
    tool_name: 'Edit',
    tool_input: {
      file_path: CORE_PATH,
      old_string: oldStr,
      new_string: newStr
    }
  };
}

let home;
let keyPair;

function writeApprovalPub(dir, publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  const fp = crypto.createHash('sha256').update(jwk.x).digest('hex').slice(0, 32);
  fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'keys', 'approval.pub'), `ed25519:${jwk.x}:fingerprint:${fp}\n`);
}

/** A valid owner-signed token for the Edit request (path-only canonical form). */
function makeEditToken(nonceSuffix) {
  const request = canonicalizeRequest({ action: 'Edit', params: { file_path: CORE_PATH } });
  const nonce = `l30-purge-${nonceSuffix}`;
  const timestamp = Date.now();
  const signData = { request, nonce, timestamp };
  const signBuf = Buffer.from(JSON.stringify(signData, Object.keys(signData).sort()), 'utf8');
  const signature = crypto.sign(null, signBuf, keyPair.privateKey).toString('hex');
  return { request, nonce, timestamp, signature };
}

function writeToken(name, token) {
  const dir = path.join(home, 'pending-approvals');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(token));
}

function tokensWithRequest(request) {
  const dir = path.join(home, 'pending-approvals');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch { return null; }
    })
    .filter(t => t && t.request === request);
}

function runHook(payload) {
  return spawnSync(process.execPath, [HOOK, JSON.stringify(payload)], {
    env: { ...process.env, LOTOR_HOME: home },
    encoding: 'utf8'
  });
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-l30-purge-'));
  fs.writeFileSync(path.join(home, 'policy.json'), JSON.stringify({ version: 1, mode: 'herded' }));
  keyPair = crypto.generateKeyPairSync('ed25519');
  writeApprovalPub(home, keyPair.publicKey);
  // Prime the chain (genesis + keypair) outside the measured runs.
  createStore(home).appendReceipt({ type: 'test-genesis-primer', timestamp: 1 });
});

after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('L30: spending one token for a request purges its surplus siblings', () => {

  it('first edit spends token #1; surplus token #1b for the SAME path must NOT survive', () => {
    // Two signatures for the same path — the exact double-signing accident
    // KNOWN-LIMITS 30 was found through. Distinct nonces, identical request.
    writeToken('tok-a.json', makeEditToken('first'));
    writeToken('tok-b.json', makeEditToken('banked'));
    const request = canonicalizeRequest({ action: 'Edit', params: { file_path: CORE_PATH } });

    // First edit: legitimately covered by tok-a. Must approve.
    const r1 = runHook(editInput('const a = 1;', 'const a = 2;'));
    assert.strictEqual(r1.status, 0, `first edit should be approved, got ${r1.status}: ${r1.stderr}`);

    // THE FIX: tok-b (same request) must be gone — spent along with tok-a.
    const survivors = tokensWithRequest(request);
    assert.strictEqual(
      survivors.length, 0,
      `surplus token for the same request survived the spend: ${JSON.stringify(survivors)}`
    );

    // Second edit, different content, same path: NO live authorization may
    // remain. Unpatched behavior: approved via tok-b (the whole bug).
    const r2 = runHook(editInput('const b = 1;', 'const b = 2;'));
    assert.strictEqual(
      r2.status, 2,
      `second edit to the same path must be DENIED with no surplus token, got ${r2.status}: ${r2.stderr}`
    );
  });

  it('spending a token does NOT touch tokens for DIFFERENT requests', () => {
    // Over-purging would break the legitimate batch-signing flow the
    // findValidToken BUG FIXED comment describes (several files signed in
    // one sitting). A different path is a different request: it must survive.
    const otherPath = '/repo/src/policy/index.js';
    const otherReq = canonicalizeRequest({ action: 'Edit', params: { file_path: otherPath } });

    writeToken('tok-other.json',
      (() => {
        const nonce = 'l30-other-path';
        const timestamp = Date.now();
        const signData = { request: otherReq, nonce, timestamp };
        const signBuf = Buffer.from(JSON.stringify(signData, Object.keys(signData).sort()), 'utf8');
        return {
          request: otherReq, nonce, timestamp,
          signature: crypto.sign(null, signBuf, keyPair.privateKey).toString('hex')
        };
      })()
    );

    // Spend a token on the CORE_PATH request again (sign fresh, stage, run).
    writeToken('tok-c.json', makeEditToken('again'));
    const r = runHook(editInput('const c = 1;', 'const c = 2;'));
    assert.strictEqual(r.status, 0, `edit should be approved, got ${r.status}: ${r.stderr}`);

    const othersLeft = tokensWithRequest(otherReq);
    assert.strictEqual(othersLeft.length, 1, 'a token for a DIFFERENT request must survive the purge');
  });

  it('malformed token files are left alone by the purge', () => {
    const dir = path.join(home, 'pending-approvals');
    fs.writeFileSync(path.join(dir, 'garbage.json'), '{not json');
    writeToken('tok-d.json', makeEditToken('third'));
    const r = runHook(editInput('const d = 1;', 'const d = 2;'));
    assert.strictEqual(r.status, 0);
    assert.strictEqual(fs.existsSync(path.join(dir, 'garbage.json')), true,
      'purge must not sweep unreadable files it cannot classify');
    try { fs.unlinkSync(path.join(dir, 'garbage.json')); } catch { /* ok */ }
  });
});
