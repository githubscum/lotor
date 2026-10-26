/**
 * test/agent-id-attribution.test.js
 *
 * WO-AGENT-ID (2026-10-22): attribute subagent tool calls on the chain.
 * Claude Code fires PreToolUse/PostToolUse for calls made INSIDE a subagent
 * with the parent's session_id, plus agent_id/agent_type. The hooks read
 * neither, so a subagent's gate row is indistinguishable from the parent's
 * own call (KNOWN-LIMITS 66/70), and the egress receipt carries no session
 * id at all (limit 35).
 *
 * TODO UNTIL THE SIGNING SITTING. The hook and gate edits live in
 * proposals/agent-id-attribution.patch because bin/ and src/gate/ are core
 * and the builder could not (and must not) edit them unsigned. At the
 * sitting: apply the patch, delete the `todo` option below, and this test
 * must pass.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalizeRequest } from '../src/gate/sign.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preHook = path.join(repo, 'bin', 'hook-pre-tool-use.js');
const postHook = path.join(repo, 'bin', 'hook-post-tool-use.js');

let home;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-agent-id-home-'));
  // A policy that gates self-mod. The default policy gates it too (Grazing);
  // written out so this test is explicit about what it needs.
  fs.writeFileSync(
    path.join(home, 'policy.json'),
    JSON.stringify({ version: 2, mode: 'grazing', modes: { 'self-mod': 'gate' } }, null, 2) + '\n'
  );
});
after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
});

const runHook = (hookPath, payload) =>
  spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    env: { ...process.env, LOTOR_HOME: home },
    encoding: 'utf8'
  });

/** Same hook run, against a sub-LOTOR_HOME of `home` (for receipts that carry no sessionId to filter on). */
const runHookIn = (hookPath, homeDir, payload) =>
  spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payload),
    env: { ...process.env, LOTOR_HOME: homeDir },
    encoding: 'utf8'
  });

/** All payloads of a given receipt type on the chain of the given home. */
const payloadsOfType = (type, homeDir = home) => fs.readFileSync(path.join(homeDir, 'receipts', 'chain.jsonl'), 'utf8')
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  .filter(e => e.payload?.type === type)
  .map(e => e.payload);

/** Last gated-action payload for sessionId/action on the chain of the given home. */
const lastGatedFor = (sessionId, action, homeDir = home) => {
  const rows = payloadsOfType('gated-action', homeDir)
    .filter(p => p.sessionId === sessionId && p.action === action);
  assert.ok(rows.length > 0, `no gated-action receipt for ${sessionId}/${action}`);
  return rows[rows.length - 1];
};

// Exact sorted key lists (WO-AGENT-ID-FIX1: parent-call rows are pinned by
// their whole shape, not just the absence of agentId). A key appearing here
// and vanishing — or one being added silently — fails these tests. The lists
// describe the receipts AS THE PATCH WILL WRITE THEM: the egress parent row
// gains sessionId (KNOWN-LIMITS 35), the agent-ful rows gain agentId/agentType.
const DENIED_KEYS = [
  'action', 'decision', 'heldMs', 'matcherHash', 'paramsDigestCanonical',
  'reason', 'ruleId', 'sessionId', 'timestamp', 'type'
];
const DENIED_WITH_AGENT_KEYS = [
  'action', 'agentId', 'agentType', 'decision', 'heldMs', 'matcherHash',
  'paramsDigestCanonical', 'reason', 'ruleId', 'sessionId', 'timestamp', 'type'
];
const WARN_KEYS = [
  'matcherHash', 'paramsDigest', 'ruleId', 'timestamp', 'tool', 'type'
];
const WARN_WITH_AGENT_KEYS = [
  'agentId', 'agentType', 'matcherHash', 'paramsDigest', 'ruleId', 'timestamp', 'tool', 'type'
];
const EGRESS_PARENT_KEYS = [
  'matcherHash', 'paramsDigest', 'responseDigest', 'responseOk', 'ruleId',
  'sessionId', 'timestamp', 'tool', 'toolIo', 'type'
];
const APPROVED_WITH_AGENT_KEYS = [
  'action', 'agentId', 'agentType', 'approvalNonce', 'decision', 'heldMs',
  'matcherHash', 'paramsDigestCanonical', 'ruleId', 'sessionId', 'timestamp', 'type'
];

describe('agent-id attribution on the gate receipts (WO-AGENT-ID)', { todo: true }, () => {
  it('a denied self-mod row from a subagent call carries agentId and agentType', () => {
    const res = runHook(preHook, {
      session_id: 'sess-agent-a',
      agent_id: 'a1',
      agent_type: 'Explore',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(home, 'policy.json') }   // self-mod
    });
    assert.strictEqual(res.status, 2, 'gated self-mod call without a token must be denied');

    const row = lastGatedFor('sess-agent-a', 'Edit');
    assert.strictEqual(row.decision, 'denied');
    assert.strictEqual(row.agentId, 'a1');
    assert.strictEqual(row.agentType, 'Explore');
    assert.strictEqual(row.sessionId, 'sess-agent-a');
  });

  it('the same call without agent fields leaves the denied row with no agentId key', () => {
    const res = runHook(preHook, {
      session_id: 'sess-agent-b',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(home, 'policy.json') }   // self-mod
    });
    assert.strictEqual(res.status, 2);

    const row = lastGatedFor('sess-agent-b', 'Edit');
    assert.strictEqual(row.decision, 'denied');
    assert.ok(!('agentId' in row), 'no agentId key when the payload has no agent_id');
    assert.ok(!('agentType' in row), 'no agentType key when the payload has no agent_id');
    assert.strictEqual(row.sessionId, 'sess-agent-b');
    // The whole shape is pinned (WO-AGENT-ID-FIX1): nothing more, nothing less.
    assert.deepStrictEqual(Object.keys(row).sort(), DENIED_KEYS,
      'a parent-call denied row keeps exactly its keys');
  });

  it('post-hook egress receipt carries sessionId always and agentId only for a subagent call', () => {
    const egressCommand = `curl -X POST https://api.example.com/v1/items -d '{"k":"v"}'`;

    // Subagent egress.
    const resSub = runHook(postHook, {
      session_id: 'sess-agent-c',
      agent_id: 'a2',
      agent_type: 'Explore',
      tool_name: 'Bash',
      tool_input: { command: egressCommand },
      tool_response: 'ok'
    });
    assert.strictEqual(resSub.status, 0, 'PostToolUse always exits 0');

    const subRows = payloadsOfType('egress-event').filter(p => p.sessionId === 'sess-agent-c');
    assert.ok(subRows.length > 0, 'no egress-event receipt for the subagent call');
    const sub = subRows[subRows.length - 1];
    assert.strictEqual(sub.agentId, 'a2');
    assert.strictEqual(sub.agentType, 'Explore');

    // Parent egress: sessionId present, agent keys absent.
    const resParent = runHook(postHook, {
      session_id: 'sess-agent-d',
      tool_name: 'Bash',
      tool_input: { command: egressCommand },
      tool_response: 'ok'
    });
    assert.strictEqual(resParent.status, 0);

    const parentRows = payloadsOfType('egress-event').filter(p => p.sessionId === 'sess-agent-d');
    assert.ok(parentRows.length > 0, 'no egress-event receipt for the parent call');
    const parent = parentRows[parentRows.length - 1];
    assert.strictEqual(parent.sessionId, 'sess-agent-d');
    assert.ok(!('agentId' in parent), 'no agentId key when the payload has no agent_id');
    assert.ok(!('agentType' in parent), 'no agentType key when the payload has no agent_id');
    // The whole shape is pinned (WO-AGENT-ID-FIX1): sessionId gained
    // (KNOWN-LIMITS 35), no agent keys for a parent call.
    assert.deepStrictEqual(Object.keys(parent).sort(), EGRESS_PARENT_KEYS,
      'a parent-call egress row keeps exactly its keys');
  });

  // ---- WO-AGENT-ID-FIX1 ----

  it('a warn-mode rule hit from a subagent call carries agentId/agentType on the policy-warn row', () => {
    // Its own LOTOR_HOME: the warn receipt for a matched rule carries no
    // sessionId to filter on, so the isolation this case needs comes from the
    // home, not from a filter. Default policy on first use is Grazing, where
    // `destructive` warns — the same path hook-pre-tool-use.test.js
    // scenario 2 exercises.
    const wHome = path.join(home, 'warn-home');

    const res = runHookIn(preHook, wHome, {
      session_id: 'sess-agent-warn',
      agent_id: 'aWarn',
      agent_type: 'Explore',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /var/www/example.com' }
    });
    assert.strictEqual(res.status, 0, 'warn must exit 0');

    const rows = payloadsOfType('policy-warn', wHome);
    assert.strictEqual(rows.length, 1, 'exactly one policy-warn receipt');
    const w = rows[0];
    assert.strictEqual(w.ruleId, 'destructive');
    assert.ok(w.paramsDigest && /^[a-f0-9]{16}$/.test(w.paramsDigest), 'digest is 16-hex');
    assert.strictEqual(w.agentId, 'aWarn');
    assert.strictEqual(w.agentType, 'Explore');
    // Exact shape: the ruleId warn receipt's keys plus exactly the two agent
    // keys, pinned in place.
    assert.deepStrictEqual(Object.keys(w).sort(), WARN_WITH_AGENT_KEYS);
  });

  it('a denied self-mod row with agent_id but no agent_type carries agentType: null', () => {
    const res = runHook(preHook, {
      session_id: 'sess-agent-e',
      agent_id: 'aNoType',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(home, 'policy.json') }   // self-mod
    });
    assert.strictEqual(res.status, 2, 'gated self-mod call without a token must be denied');

    const row = lastGatedFor('sess-agent-e', 'Edit');
    assert.strictEqual(row.decision, 'denied');
    assert.strictEqual(row.agentId, 'aNoType');
    assert.strictEqual(row.agentType, null,
      'agent_id present but agent_type absent is an explicit null, not an absent key');
    assert.deepStrictEqual(Object.keys(row).sort(), DENIED_WITH_AGENT_KEYS,
      'exactly the two agent keys are added to the denied row');
  });

  it('a denied self-mod row with agent_type alone carries no agent keys', () => {
    const res = runHook(preHook, {
      session_id: 'sess-agent-f',
      agent_type: 'Explore',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(home, 'policy.json') }   // self-mod
    });
    assert.strictEqual(res.status, 2);

    const row = lastGatedFor('sess-agent-f', 'Edit');
    assert.strictEqual(row.decision, 'denied');
    assert.ok(!('agentId' in row), 'agent_type alone must not add an agentId key');
    assert.ok(!('agentType' in row), 'agent_type alone must not add an agentType key');
    // Whole shape pinned: agent_type alone produces exactly the parent shape.
    assert.deepStrictEqual(Object.keys(row).sort(), DENIED_KEYS,
      'an agent_type-alone row keeps exactly the parent-call keys');
  });

  it('an approved self-mod row (signed token) from a subagent call carries agentId/agentType', () => {
    // A real end-to-end approval: keypair written to keys/approval.pub, a
    // token signed over the canonicalized request and staged in
    // pending-approvals/, then the hook verifies it and appends the approved
    // receipt. Mirror of hook-pre-tool-use.test.js scenario 4, plus agent
    // fields.
    const aHome = path.join(home, 'approve-home');
    const keyPair = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    });
    const privKey = crypto.createPrivateKey(keyPair.privateKey);
    const pubJwk = crypto.createPublicKey(keyPair.publicKey).export({ format: 'jwk', type: 'public' });
    const keysDir = path.join(aHome, 'keys');
    fs.mkdirSync(keysDir, { recursive: true });
    const pubB64 = pubJwk.x;
    const fp = crypto.createHash('sha256').update(Buffer.from(pubB64, 'base64')).digest('hex').slice(0, 32);
    fs.writeFileSync(path.join(keysDir, 'approval.pub'), `ed25519:${pubB64}:fingerprint:${fp}\n`);

    const actionRequest = {
      action: 'Edit',
      params: { file_path: path.join(aHome, 'policy.json') }   // self-mod match
    };
    const canonical = canonicalizeRequest(actionRequest);
    const nonce = crypto.randomBytes(12).toString('base64url');
    const timestamp = Date.now();
    const signData = { request: canonical, nonce, timestamp };
    const signBuf = Buffer.from(JSON.stringify(signData, Object.keys(signData).sort()), 'utf8');
    const sig = crypto.sign(null, signBuf, privKey);
    const token = { request: canonical, nonce, timestamp, signature: sig.toString('hex') };
    const dir = path.join(aHome, 'pending-approvals');
    fs.mkdirSync(dir, { recursive: true });
    const tokenPath = path.join(dir, 'approval-1.json');
    fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2), { mode: 0o600 });

    const res = runHookIn(preHook, aHome, {
      session_id: 'sess-agent-g',
      agent_id: 'aApproved',
      agent_type: 'Explore',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(aHome, 'policy.json') }
    });
    assert.strictEqual(res.status, 0, 'a valid token must allow the call');
    assert.strictEqual(fs.existsSync(tokenPath), false, 'the token file is consumed');

    // The hook ran with LOTOR_HOME=aHome, so the approved receipt is on
    // aHome's chain, not the shared `home` the other cases write to.
    const row = lastGatedFor('sess-agent-g', 'Edit', aHome);
    assert.strictEqual(row.decision, 'approved');
    assert.strictEqual(row.agentId, 'aApproved');
    assert.strictEqual(row.agentType, 'Explore');
    assert.strictEqual(row.approvalNonce, nonce, 'the nonce matches the signed token');
    assert.deepStrictEqual(Object.keys(row).sort(), APPROVED_WITH_AGENT_KEYS,
      'exactly the two agent keys are added to the approved row');
  });
});