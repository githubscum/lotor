/**
 * test/grant-concurrency.test.js
 *
 * Finding 6 (KNOWN-LIMITS 20 / 21): the grant action ceiling must hold under
 * concurrency. The earlier hook counted prior uses from a pre-lock snapshot and
 * appended after the lock, so overlapping calls under one grant could each read
 * the same count and each proceed, exceeding maxActions.
 *
 * The test fires N real hook invocations at ONE wall-clock instant against a
 * grant with maxActions = 2, and asserts exactly 2 are approved and exactly 2
 * grant-use entries land on the chain.
 *
 * Two things are load-bearing and both were got wrong on the first pass:
 *   1. The children must run CONCURRENTLY. spawnSync in a loop blocks: each
 *      child runs to completion before the next starts, so they never overlap
 *      and the test passes against the buggy code for the wrong reason. Uses
 *      async spawn + Promise.all.
 *   2. The children must OVERLAP in the read-then-write window. Each busy-waits
 *      to a shared START_AT (the barrier), and the chain keypair is pre-created
 *      in before() (via recordGrantOnChain) so no child pays a keypair-gen lock
 *      that would stagger it past the window.
 * Verified out-of-band that this harness makes the pre-fix non-atomic path
 * record 8 uses against maxActions=1, i.e. the barrier genuinely overlaps.
 * (2026-07-22 lesson: a concurrency test that is not barrier-synchronised is
 * worthless; 2026-07-24 corollary: nor is one whose processes never overlap.)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signGrant } from '../src/grant/grant-schema.js';
import { recordGrantOnChain } from '../src/grant/issue.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO, 'bin', 'hook-pre-tool-use.js');

const SESSION = 'cc-test';
const COMMAND = 'git push origin main';          // egress-other; gates in herded
const ACTION = { action: 'Bash', params: { command: COMMAND } };
const MAX = 2;
const CHILDREN = 6;

let home;

function writeApprovalPub(dir, publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  const fp = crypto.createHash('sha256').update(jwk.x).digest('hex').slice(0, 32);
  fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'keys', 'approval.pub'), `ed25519:${jwk.x}:fingerprint:${fp}\n`);
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-cc-'));
  // Herded, so egress-other gates and the grant path is reached.
  fs.writeFileSync(path.join(home, 'policy.json'), JSON.stringify({ version: 1, mode: 'herded' }));

  const kp = crypto.generateKeyPairSync('ed25519');
  writeApprovalPub(home, kp.publicKey);

  const grant = signGrant({
    type: 'delegation-grant',
    grantId: 'g-cc',
    sessionId: SESSION,
    requests: [ACTION],
    maxActions: MAX,
    issuedAt: 1,
    expiresAt: Date.now() + 3_600_000,
    nonce: 'cc-nonce'
  }, kp.privateKey);
  fs.mkdirSync(path.join(home, 'grants'), { recursive: true });
  fs.writeFileSync(path.join(home, 'grants', 'g-cc.json'), JSON.stringify(grant));

  // Record the grant on the chain (matches real issuance; establishes genesis).
  recordGrantOnChain(home, grant);
});

after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

function countGrantUses() {
  const f = path.join(home, 'receipts', 'chain.jsonl');
  if (!fs.existsSync(f)) return 0;
  return fs.readFileSync(f, 'utf8').trim().split('\n')
    .map(l => { try { return JSON.parse(l).payload; } catch { return null; } })
    .filter(p => p && p.type === 'grant-use' && p.grantId === 'g-cc').length;
}

describe('grant ceiling under a barrier-synchronised burst', () => {
  it(`approves exactly ${MAX} of ${CHILDREN} simultaneous uses`, async () => {
    const payload = JSON.stringify({ session_id: SESSION, tool_name: 'Bash', tool_input: { command: COMMAND } });
    const startAt = Date.now() + 1500;

    // Each child busy-waits to startAt, then runs the hook once, exiting with
    // the hook's own status (0 approved, 2 denied). Children are launched
    // concurrently (async spawn) and align on startAt, not on launch order.
    const child = [
      'const {execFileSync}=require("child_process");',
      'const s=Number(process.env.START_AT);',
      'while(Date.now()<s){}',                       // barrier
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
    const uses = countGrantUses();

    assert.strictEqual(uses, MAX, `chain must record exactly ${MAX} grant-uses, got ${uses}`);
    assert.strictEqual(approved, MAX, `exactly ${MAX} calls may be approved, got ${approved}`);
    assert.strictEqual(approved + denied, CHILDREN, `every call must approve or deny cleanly (${approved} approved + ${denied} denied of ${CHILDREN})`);
  });
});
