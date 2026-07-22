/**
 * test/hook-post-tool-use.test.js
 *
 * Integration tests for bin/hook-post-tool-use.js. Each test spawns the
 * hook as a real child process with an isolated LOTOR_HOME (temp dir).
 *
 * Coverage (5 scenarios from the work order):
 *   1. Egress-shaped call (Bash git push --force) with a tool_response:
 *      exit 0, one egress-event receipt, paramsDigest + responseDigest
 *      present, raw command string and raw response text absent.
 *   2. Non-egress call (Read): exit 0, no chain write.
 *   3. Malformed stdin: exit 0, no throw.
 *   4. Missing tool_response in the payload: still appends (responseDigest
 *      reflects an absent/empty response, no crash).
 *   5. Engine error (policy.json as a directory, same technique as the
 *      PreToolUse test): fail open, exit 0.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadChain } from '../src/store/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, '..', 'bin', 'hook-post-tool-use.js');

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

describe('bin/hook-post-tool-use.js', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-posttool-hook-'));
  });

  after(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ---- 1. Egress-shaped call: Bash git push --force with a tool_response ----
  it('1. egress-shaped call: exit 0, one egress-event receipt, digests present, no raw content', async () => {
    const eHome = path.join(tempDir, 'home-egress');
    fs.mkdirSync(eHome, { recursive: true });

    const secretCommand = 'git push --force origin feat/x';
    const secretResponse = 'Total 0 (delta 0), reused 0 (delta 0), pack-reused 0\nTo https://example.com/repo.git\n + abc1234...def5678 feat/x -> feat/x (forced update)';

    const res = await runHook({
      home: eHome,
      stdin: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: secretCommand, secret: 'do-not-leak' },
        tool_response: {
          stdout: secretResponse,
          stderr: '',
          is_error: false
        },
        session_id: 'sess-test-egress',
        cwd: 'C:\\repos\\agent-receipts'
      })
    });
    assert.strictEqual(res.code, 0, 'egress hook must exit 0');
    assert.strictEqual(res.stdout, '', 'nothing to stdout');
    assert.match(res.stderr, /egress: push-force/);

    const entries = loadChain(eHome);
    const egress = entries.filter(e => e.payload?.type === 'egress-event');
    assert.strictEqual(egress.length, 1, 'exactly one egress-event receipt');
    const p = egress[0].payload;

    assert.strictEqual(p.ruleId, 'push-force');
    assert.strictEqual(p.tool, 'Bash');
    assert.ok(p.paramsDigest && /^[a-f0-9]{16}$/.test(p.paramsDigest), 'paramsDigest is 16-hex');
    assert.ok(p.responseDigest && /^[a-f0-9]{16}$/.test(p.responseDigest), 'responseDigest is 16-hex');
    assert.strictEqual(p.responseOk, true, 'responseOk reflects is_error=false');

    // Raw content must not appear anywhere in the receipt payload.
    const serialized = JSON.stringify(p);
    assert.ok(!serialized.includes('do-not-leak'), 'raw secret in tool_input must not appear');
    assert.ok(!serialized.includes('git push --force'), 'raw command must not appear');
    assert.ok(!serialized.includes('forced update'), 'raw response text must not appear');
    assert.strictEqual(p.secret, undefined, 'raw input field absent');
    assert.strictEqual(p.tool_response, undefined, 'raw response field absent');
    assert.strictEqual(p.command, undefined, 'raw command field absent');
  });

  // ---- 2. Non-egress call: Read tool ----
  it('2. non-egress call: exit 0, no chain write', async () => {
    const nHome = path.join(tempDir, 'home-nonegress');
    fs.mkdirSync(nHome, { recursive: true });

    const res = await runHook({
      home: nHome,
      stdin: JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: '/repo/src/views/index.js' },
        tool_response: { contents: 'this is a file' }
      })
    });
    assert.strictEqual(res.code, 0);
    assert.strictEqual(res.stdout, '');

    const entries = loadChain(nHome);
    const egress = entries.filter(e => e.payload?.type === 'egress-event');
    const policyWarns = entries.filter(e => e.payload?.type === 'policy-warn');
    assert.strictEqual(egress.length, 0, 'no egress-event for Read');
    assert.strictEqual(policyWarns.length, 0, 'no policy-warn for Read');
  });

  // ---- 3. Malformed stdin ----
  it('3. malformed stdin: exit 0, no throw, no chain write', async () => {
    const mHome = path.join(tempDir, 'home-malformed');
    fs.mkdirSync(mHome, { recursive: true });

    const res = await runHook({ home: mHome, stdin: 'this is not json {{{' });
    assert.strictEqual(res.code, 0, 'malformed stdin must exit 0');
    assert.strictEqual(res.stdout, '');

    const entries = loadChain(mHome);
    assert.strictEqual(entries.length, 0, 'no chain write on malformed stdin');
  });

  // ---- 4. Missing tool_response ----
  it('4. missing tool_response: still appends, responseDigest = "empty", no crash', async () => {
    const noRespHome = path.join(tempDir, 'home-noresp');
    fs.mkdirSync(noRespHome, { recursive: true });

    const res = await runHook({
      home: noRespHome,
      stdin: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'curl -X POST https://api.example.com/v1/items -d \'{"k":"v"}\'' }
        // tool_response deliberately omitted
      })
    });
    assert.strictEqual(res.code, 0, 'missing tool_response must not crash');
    assert.match(res.stderr, /egress: egress-other/, 'stderr confirms egress-other match');

    const entries = loadChain(noRespHome);
    const egress = entries.filter(e => e.payload?.type === 'egress-event');
    assert.strictEqual(egress.length, 1, 'one egress-event receipt even with no response');
    const p = egress[0].payload;
    assert.strictEqual(p.ruleId, 'egress-other');
    assert.strictEqual(p.responseDigest, 'empty', 'responseDigest reflects absent response');
    assert.strictEqual(p.responseOk, null, 'responseOk null when no response given');
    // Raw command must not be in the payload
    const serialized = JSON.stringify(p);
    assert.ok(!serialized.includes('api.example.com'), 'raw URL must not appear');
    assert.ok(!serialized.includes('curl -X POST'), 'raw command must not appear');
  });

  // ---- 5. Engine error fail-open: policy.json is a directory ----
  it('5. engine error fail-open: policy.json as a directory -> exit 0, stderr notes the failure', async () => {
    const brokenHome = path.join(tempDir, 'home-engine-error');
    fs.mkdirSync(brokenHome, { recursive: true });
    fs.mkdirSync(path.join(brokenHome, 'policy.json'));

    const res = await runHook({
      home: brokenHome,
      stdin: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git push --force origin feat/x' },
        tool_response: { stdout: 'ok', is_error: false }
      })
    });
    assert.strictEqual(res.code, 0, 'engine error must fail open (exit 0)');
    assert.match(res.stderr, /policy\.json/, 'stderr notes the policy problem');
    // Best-effort engine-error receipt should have been appended.
    const entries = loadChain(brokenHome);
    const warns = entries.filter(e => e.payload?.type === 'policy-warn');
    assert.strictEqual(warns.length, 1, 'one engine-error policy-warn receipt');
    assert.strictEqual(warns[0].payload.ruleId, 'engine-error');
    // No egress-event should have been written in the engine-error path.
    const egress = entries.filter(e => e.payload?.type === 'egress-event');
    assert.strictEqual(egress.length, 0, 'no egress-event on engine error');
  });
});
