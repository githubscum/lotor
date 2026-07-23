/**
 * test/hook-pre-tool-use.test.js
 *
 * Integration tests for bin/hook-pre-tool-use.js. Each test spawns the
 * hook as a real child process with an isolated LOTOR_HOME (temp dir).
 *
 * Coverage (7 scenarios from the work order):
 *   1. Unmatched tool call: exit 0, chain unchanged.
 *   2. Warn rule: exit 0, one policy-warn receipt appended, digest present, no raw params.
 *   3. Gate rule, no token: exit 2, denial receipt appended, stderr has rule id + signing command.
 *   4. Gate rule, valid token in pending-approvals/: exit 0, approval receipt, token file deleted, nonce recorded.
 *   5. Replay: same payload with a re-instated consumed token: exit 2, denial receipt.
 *   6. Engine error fail-open: LOTOR_HOME with policy.json as a directory: exit 0, stderr notes the failure.
 *   7. Garbage stdin: exit 0.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadChain } from '../src/store/index.js';
import { canonicalizeRequest } from '../src/gate/sign.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, '..', 'bin', 'hook-pre-tool-use.js');

function runHook({ stdin = '', args = [], home }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH, ...args], {
      env: { ...process.env, LOTOR_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

// ---------- shared helpers: programmatic Ed25519 keypair for token tests ----------

let testKeyObjects = null;

function generateTestKeypair() {
  const keyPair = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  const pubKeyObj = crypto.createPublicKey(keyPair.publicKey);
  const pubJwk = pubKeyObj.export({ format: 'jwk', type: 'public' });
  testKeyObjects = {
    publicKey: pubKeyObj,
    privateKey: crypto.createPrivateKey(keyPair.privateKey)
  };
  return { publicKey: pubJwk, privateKey: keyPair.privateKey };
}

function createTestApprovalToken(actionRequest) {
  const canonical = canonicalizeRequest(actionRequest);
  const nonce = crypto.randomBytes(12).toString('base64url');
  const timestamp = Date.now();
  const signData = { request: canonical, nonce, timestamp };
  const signBuf = Buffer.from(JSON.stringify(signData, Object.keys(signData).sort()), 'utf8');
  const sig = crypto.sign(null, signBuf, testKeyObjects.privateKey);
  return { request: canonical, nonce, timestamp, signature: sig.toString('hex') };
}

function writeTestApprovalPubkey(home, keyPair) {
  const keysDir = path.join(home, 'keys');
  fs.mkdirSync(keysDir, { recursive: true });
  const pubB64 = keyPair.publicKey.x;
  const fp = crypto.createHash('sha256').update(Buffer.from(pubB64, 'base64')).digest('hex').slice(0, 32);
  fs.writeFileSync(path.join(keysDir, 'approval.pub'), `ed25519:${pubB64}:fingerprint:${fp}\n`);
  return { b64: pubB64, fp };
}

describe('bin/hook-pre-tool-use.js', () => {
  let tempDir;
  let home;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-pretool-hook-'));
    home = path.join(tempDir, 'home');
    fs.mkdirSync(home, { recursive: true });
  });

  after(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ---- 1. Unmatched tool call ----
  it('1. unmatched tool call: exit 0, chain unchanged', async () => {
    // Per default policy, a Read call doesn't match any rule.
    const res = await runHook({
      home,
      stdin: JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: '/repo/src/views/index.js' }
      })
    });
    assert.strictEqual(res.code, 0, 'hook should exit 0');
    assert.strictEqual(res.stdout, '', 'nothing to stdout');
    // Chain was initialized by loadPolicy writing policy.json (no chain I/O).
    // No policy-warn or gated-action receipt should exist.
    const entries = loadChain(home);
    const policyWarns = entries.filter(e => e.payload?.type === 'policy-warn');
    const gated = entries.filter(e => e.payload?.type === 'gated-action');
    assert.strictEqual(policyWarns.length, 0, 'no policy-warn for unmatched call');
    assert.strictEqual(gated.length, 0, 'no gated-action for unmatched call');
  });

  // ---- 2. Warn rule ----
  it('2. warn rule: exit 0, one policy-warn receipt, digest present, no raw params', async () => {
    // Use a unique home so this test's receipts don't pollute the others.
    const wHome = path.join(tempDir, 'home-warn');
    fs.mkdirSync(wHome, { recursive: true });

    // destructive, not push-force: as of the 2026-07-23 herding-modes default
    // (Grazing), push-force gates rather than warns. destructive stays warn
    // under Grazing (it's a local-only action), so it's the one that still
    // exercises this path under the shipped default.
    const res = await runHook({
      home: wHome,
      stdin: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /var/www/example.com', secret: 'do-not-leak' }
      })
    });
    assert.strictEqual(res.code, 0, 'warn must exit 0');
    assert.match(res.stderr, /warn: destructive/);

    const entries = loadChain(wHome);
    const policyWarns = entries.filter(e => e.payload?.type === 'policy-warn');
    assert.strictEqual(policyWarns.length, 1, 'exactly one policy-warn receipt');
    const w = policyWarns[0].payload;
    assert.strictEqual(w.ruleId, 'destructive');
    assert.strictEqual(w.tool, 'Bash');
    assert.ok(w.paramsDigest && /^[a-f0-9]{16}$/.test(w.paramsDigest), 'digest is 16-hex');
    assert.strictEqual(w.secret, undefined, 'no raw params in the receipt');
    assert.ok(!JSON.stringify(w).includes('do-not-leak'), 'raw secret string must not appear anywhere in the receipt');
  });

  // ---- 3. Gate rule, no token ----
  it('3. gate rule, no token: exit 2, denial receipt, stderr has rule id + signing command', async () => {
    const gHome = path.join(tempDir, 'home-gate');
    fs.mkdirSync(gHome, { recursive: true });

    const res = await runHook({
      home: gHome,
      stdin: JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: 'C:\\Users\\me\\.claude\\settings.json' }
      })
    });
    assert.strictEqual(res.code, 2, 'gate match without token must exit 2');
    assert.match(res.stderr, /self-mod/, 'stderr mentions the rule id');
    assert.match(res.stderr, /npm run approve/, 'stderr includes the signing command');
    assert.match(res.stderr, /pending-approvals/, 'stderr includes the pending-approvals path');

    const entries = loadChain(gHome);
    const gated = entries.filter(e => e.payload?.type === 'gated-action');
    assert.strictEqual(gated.length, 1, 'one gated-action receipt');
    assert.strictEqual(gated[0].payload.decision, 'denied');
    assert.strictEqual(gated[0].payload.action, 'Edit');
    assert.match(gated[0].payload.reason || '', /no approval token provided/);
  });

  // ---- 4. Gate rule, valid token in pending-approvals/ ----
  describe('4. gate rule with valid token', () => {
    let g4Home;
    let testKeypair;
    let tokenJson;
    let tokenPath;
    let actionRequest;

    before(() => {
      g4Home = path.join(tempDir, 'home-gate-ok');
      fs.mkdirSync(g4Home, { recursive: true });
      testKeypair = generateTestKeypair();
      writeTestApprovalPubkey(g4Home, testKeypair);
      actionRequest = {
        action: 'Edit',
        params: { file_path: path.join(g4Home, 'policy.json') } // self-mod match
      };
      const token = createTestApprovalToken(actionRequest);
      tokenJson = JSON.stringify(token, null, 2);
      const dir = path.join(g4Home, 'pending-approvals');
      fs.mkdirSync(dir, { recursive: true });
      tokenPath = path.join(dir, 'approval-1.json');
      fs.writeFileSync(tokenPath, tokenJson, { mode: 0o600 });
    });

    it('exit 0, approval receipt, token file deleted, nonce recorded', async () => {
      const res = await runHook({
        home: g4Home,
        stdin: JSON.stringify({
          tool_name: 'Edit',
          tool_input: { file_path: path.join(g4Home, 'policy.json') }
        })
      });
      assert.strictEqual(res.code, 0, 'valid token must allow the call');
      assert.match(res.stderr, /approved: self-mod/);

      // Token file should be deleted
      assert.strictEqual(fs.existsSync(tokenPath), false, 'consumed token file must be deleted');

      // Approval receipt appended
      const entries = loadChain(g4Home);
      const gated = entries.filter(e => e.payload?.type === 'gated-action');
      assert.strictEqual(gated.length, 1);
      assert.strictEqual(gated[0].payload.decision, 'approved');
      assert.strictEqual(gated[0].payload.action, 'Edit');
      assert.ok(gated[0].payload.approvalNonce, 'nonce recorded on approval receipt');

      // Nonce must be in keys/approval-nonces.log
      const nonceLog = path.join(g4Home, 'keys', 'approval-nonces.log');
      assert.ok(fs.existsSync(nonceLog), 'nonce log written');
      const loggedNonces = fs.readFileSync(nonceLog, 'utf8').split('\n').filter(Boolean);
      assert.ok(loggedNonces.length >= 1);
      assert.strictEqual(loggedNonces[0], gated[0].payload.approvalNonce);
    });

    // ---- 5. Replay ----
    it('5. replay: re-instating the consumed token and re-running the same payload is denied', async () => {
      // Re-create the token file with the same content. The nonce is already
      // in the log from test 4, so verifyApproval will reject.
      const dir = path.join(g4Home, 'pending-approvals');
      const replayPath = path.join(dir, 'replay.json');
      fs.writeFileSync(replayPath, tokenJson, { mode: 0o600 });

      const res = await runHook({
        home: g4Home,
        stdin: JSON.stringify({
          tool_name: 'Edit',
          tool_input: { file_path: path.join(g4Home, 'policy.json') }
        })
      });
      assert.strictEqual(res.code, 2, 'replay must be denied (exit 2)');
      assert.match(res.stderr, /BLOCKED/);
      assert.match(res.stderr, /self-mod/);

      // A new gated-action receipt (denied) should be appended
      const entries = loadChain(g4Home);
      const gated = entries.filter(e => e.payload?.type === 'gated-action');
      const denied = gated.filter(g => g.payload.decision === 'denied');
      assert.ok(denied.length >= 1, 'at least one denial receipt appended');
      const lastDenied = denied[denied.length - 1];
      assert.match(lastDenied.payload.reason || '', /nonce|replay/i);
    });
  });

  // ---- 6. Engine error fail-open: policy.json is a directory ----
  it('6. engine error fail-open: policy.json as a directory -> exit 0, stderr notes the failure', async () => {
    const brokenHome = path.join(tempDir, 'home-engine-error');
    fs.mkdirSync(brokenHome, { recursive: true });
    fs.mkdirSync(path.join(brokenHome, 'policy.json'));

    const res = await runHook({
      home: brokenHome,
      stdin: JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: 'C:\\Users\\me\\.claude\\settings.json' }
      })
    });
    assert.strictEqual(res.code, 0, 'engine error must fail open (exit 0)');
    assert.match(res.stderr, /policy\.json/, 'stderr notes the policy problem');
  });

  // ---- 7. Garbage stdin ----
  it('7. garbage stdin: exit 0, nothing appended', async () => {
    const badHome = path.join(tempDir, 'home-garbage');
    fs.mkdirSync(badHome, { recursive: true });
    const res = await runHook({ home: badHome, stdin: 'this is not json {{{' });
    assert.strictEqual(res.code, 0);
    assert.strictEqual(res.stdout, '');
    const entries = loadChain(badHome);
    assert.strictEqual(entries.length, 0);
  });
});
