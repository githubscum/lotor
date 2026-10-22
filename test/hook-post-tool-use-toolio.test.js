/**
 * test/hook-post-tool-use-toolio.test.js
 *
 * Rung R2 (tool I/O), work order V3-03: the real post-tool-use hook binary
 * puts the toolio/1 object on the receipt it writes. Spawns the hook as a
 * child process with an isolated LOTOR_HOME, same harness as
 * test/hook-post-tool-use.test.js.
 *
 * STAGED, NOT YET WIRED. The hook edit is core (bin/), so it lands only at
 * the owner's signing sitting. The staged diff is
 * proposals/v3-03-tool-io-digest-2026-10-22.patch, explained in the .md
 * beside it. Until it is applied, every test below fails and is reported as
 * TODO rather than as a suite failure; that red-as-todo run IS the fail-first
 * evidence. The same diff flips WIRED to true (its last hunk), and these
 * become ordinary tests.
 *
 * The module's own contract (pin, CRLF, key order, error flag, absence, no
 * leak, chain fidelity) is proven in test/toolio-digest.test.js, which runs
 * green today. This file proves only the wiring.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadChain, createStore } from '../src/store/index.js';
import { describeToolResponse } from '../src/toolio/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, '..', 'bin', 'hook-post-tool-use.js');

// Flipped to true by the staged diff, in the same sitting as the hook edit.
const WIRED = false;
const opts = WIRED ? {} : { todo: 'V3-03 hook wiring staged for the signing sitting' };

function runHook({ stdin = '', home }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
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

describe('bin/hook-post-tool-use.js: toolio/1 on the egress-event receipt', () => {
  let tempDir;
  before(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-posttool-toolio-')); });
  after(() => { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); });

  async function fire(name, payload) {
    const home = path.join(tempDir, name);
    fs.mkdirSync(home, { recursive: true });
    const res = await runHook({ home, stdin: JSON.stringify(payload) });
    assert.strictEqual(res.code, 0, 'the hook still exits 0');
    assert.strictEqual(res.stdout, '', 'nothing to stdout');
    const egress = loadChain(home).filter(e => e.payload?.type === 'egress-event');
    assert.strictEqual(egress.length, 1, 'exactly one egress-event receipt');
    return { home, payload: egress[0].payload };
  }

  it('records digest, bytes and error flag; the legacy fields are unchanged', opts, async () => {
    const response = { stdout: 'To https://example.com/r.git\r\n + a...b x -> x\r\n', stderr: '', is_error: false };
    const { home, payload } = await fire('recorded', {
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin x' },
      tool_response: response
    });
    assert.deepStrictEqual(payload.toolIo, describeToolResponse(response));
    assert.strictEqual(payload.toolIo.response.recorded, true);
    assert.strictEqual(payload.toolIo.response.error, false);
    // Beside, not instead of: old readers keep working.
    assert.match(payload.responseDigest, /^[a-f0-9]{16}$/);
    assert.strictEqual(payload.responseOk, true);
    assert.deepStrictEqual(createStore(home).verify(), { ok: true }, 'the receipt verifies on the chain');
  });

  it('the CRLF and LF spellings of one response give the same toolIo on the chain', opts, async () => {
    const base = { tool_name: 'Bash', tool_input: { command: 'curl -X POST https://api.example.com/v1 -d x' } };
    const a = await fire('crlf', { ...base, tool_response: { stdout: 'ok\r\ndone\r\n' } });
    const b = await fire('lf', { ...base, tool_response: { stdout: 'ok\ndone\n' } });
    // Without this, two missing fields would compare equal and pass unwired.
    assert.strictEqual(a.payload.toolIo?.response?.recorded, true, 'precondition: the field exists');
    assert.deepStrictEqual(a.payload.toolIo, b.payload.toolIo);
  });

  it('carries the host error flag when the tool reported one', opts, async () => {
    const { payload } = await fire('error', {
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin x' },
      tool_response: { stdout: '', stderr: 'rejected', is_error: true }
    });
    assert.strictEqual(payload.toolIo.response.error, true);
  });

  it('a missing tool_response is recorded:false reason absent, with no digest', opts, async () => {
    const { payload } = await fire('absent', {
      tool_name: 'Bash',
      tool_input: { command: 'curl -X POST https://api.example.com/v1 -d x' }
    });
    assert.deepStrictEqual(payload.toolIo, { schema: 'toolio/1', response: { recorded: false, reason: 'absent' } });
  });

  it('no response content reaches the receipt', opts, async () => {
    const CANARY = 'ghp_CANARYhookTOKEN0123456789abcdefXYZ';
    const { payload } = await fire('leak', {
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin x' },
      tool_response: { stdout: `token=${CANARY}\n`, stderr: CANARY, is_error: false }
    });
    assert.ok(payload.toolIo, 'precondition: the field exists');
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes(CANARY), 'canary must not appear');
    assert.ok(!serialized.includes('token='), 'no excerpt either');
  });
});
