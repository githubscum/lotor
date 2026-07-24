/**
 * test/approval-token-concurrency.test.js
 *
 * S2-1 (Fable re-review 2026-07-24): a SINGLE-USE approval token was
 * double-spendable under concurrency. `verifyApproval`'s nonce check and
 * `recordNonce` ran outside any lock, so N concurrent PreToolUse hook processes
 * each passed the check and each recorded, approving one token N times.
 *
 * The fix moved the nonce check-and-record inside `withLock(baseDir)` in
 * `gatedAction` (src/gate/index.js), mirroring the grant-ceiling fix
 * (KNOWN-LIMITS 20). This test fires N real hook processes at ONE wall-clock
 * instant, all presenting the SAME single-use token, and asserts exactly 1
 * approval and exactly 1 nonce recorded.
 *
 * Load-bearing, both got wrong on earlier concurrency work in this repo:
 *   1. The children must run CONCURRENTLY (async spawn + Promise.all), or each
 *      runs to completion before the next and they never overlap.
 *   2. They must OVERLAP the read-then-write window: each busy-waits to a shared
 *      START_AT, and the chain keypair is pre-primed in before() so no child
 *      pays a keypair-gen lock that would stagger it past the window.
 * Fable confirmed this harness records 2-3 approvals against the pre-fix
 * no-lock path, so the barrier genuinely overlaps and the lock is what closes
 * the double-spend (the "prove the test fails first" discipline, 2026-07-24).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalizeRequest } from '../src/gate/sign.js';
import { createStore } from '../src/store/index.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO, 'bin', 'hook-pre-tool-use.js');

const COMMAND = 'git push origin main';          // gates in herded mode
const ACTION = { action: 'Bash', params: { command: COMMAND } };
const CHILDREN = 6;

let home;

function writeApprovalPub(dir, publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  const fp = crypto.createHash('sha256').update(jwk.x).digest('hex').slice(0, 32);
  fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'keys', 'approval.pub'), `ed25519:${jwk.x}:fingerprint:${fp}\n`);
}

// A valid single-use owner-signed token for ACTION. Mirrors verifyApproval's
// signData shape: JSON of { request, nonce, timestamp } with sorted keys.
function makeToken(privateKey) {
  const request = canonicalizeRequest(ACTION);
  const nonce = 'tok-nonce-cc';
  const timestamp = Date.now();
  const signData = { request, nonce, timestamp };
  const signBuf = Buffer.from(JSON.stringify(signData, Object.keys(signData).sort()), 'utf8');
  const signature = crypto.sign(null, signBuf, privateKey).toString('hex');
  return { request, nonce, timestamp, signature };
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-tok-'));
  fs.writeFileSync(path.join(home, 'policy.json'), JSON.stringify({ version: 1, mode: 'herded' }));

  const kp = crypto.generateKeyPairSync('ed25519');
  writeApprovalPub(home, kp.publicKey);

  const token = makeToken(kp.privateKey);
  fs.mkdirSync(path.join(home, 'pending-approvals'), { recursive: true });
  fs.writeFileSync(path.join(home, 'pending-approvals', 'token.json'), JSON.stringify(token));

  // Pre-prime the chain (genesis + chain keypair) so the burst children do not
  // stagger on keypair generation and genuinely overlap the nonce window.
  createStore(home).appendReceipt({ type: 'test-genesis-primer', timestamp: 1 });
});

after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

function countNonces() {
  const f = path.join(home, 'keys', 'approval-nonces.log');
  if (!fs.existsSync(f)) return 0;
  return fs.readFileSync(f, 'utf8').split('\n').map(l => l.trim()).filter(Boolean).length;
}

describe('single-use approval token under a barrier-synchronised burst (S2-1)', () => {
  it(`approves exactly 1 of ${CHILDREN} simultaneous uses of one token`, async () => {
    const payload = JSON.stringify({ session_id: 'cc-test', tool_name: 'Bash', tool_input: { command: COMMAND } });
    const startAt = Date.now() + 1500;

    // Each child busy-waits to startAt, then runs the hook once, exiting with
    // the hook's own status (0 approved, 2 denied). Launched concurrently and
    // aligned on startAt, not on launch order.
    const child = [
      'const {execFileSync}=require("child_process");',
      'const s=Number(process.env.START_AT);',
      'while(Date.now()<s){}',
      'try{execFileSync(process.execPath,[process.env.HOOK,process.env.PAYLOAD],{stdio:"ignore",env:process.env});process.exit(0);}',
      'catch(e){process.exit(typeof e.status==="number"?e.status:1);}'
    ].join('');

    const run = () => new Promise(res => {
      const p = spawn(process.execPath, ['-e', child], {
        env: { ...process.env, LOTOR_HOME: home, HOOK, PAYLOAD: payload, START_AT: String(startAt) }
      });
      p.on('close', code => res(code));
    });
    const codes = await Promise.all(Array.from({ length: CHILDREN }, run));

    const approved = codes.filter(c => c === 0).length;
    const denied = codes.filter(c => c === 2).length;
    const nonces = countNonces();

    assert.strictEqual(approved, 1, `exactly 1 use may be approved, got ${approved}`);
    assert.strictEqual(nonces, 1, `exactly 1 nonce must be recorded, got ${nonces}`);
    assert.strictEqual(approved + denied, CHILDREN, `every call must approve or deny cleanly (${approved} + ${denied} of ${CHILDREN})`);
  });
});
