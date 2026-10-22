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
 * beside it. Until it is applied, every test in the FIRST describe fails and is
 * reported as TODO; that red-as-todo run IS the fail-first evidence. The diff
 * flips WIRED (its last hunk) and they become ordinary tests. The SECOND
 * describe runs today on the real hook's receipt plus the staged field.
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
    assert.deepStrictEqual(payload.toolIo, describeToolResponse(undefined));
    assert.deepStrictEqual(payload.toolIo.response, { recorded: false, reason: 'absent' });
    assert.match(payload.toolIo.hash, /^[0-9a-f]{16}$/, 'the code stamp rides on the receipt');
  });

  it('where responseOk and toolIo disagree, both land as documented (toolIo wins)', opts, async () => {
    const { payload } = await fire('precedence', {
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin x' },
      tool_response: { stdout: 'ok', error: false }
    });
    assert.strictEqual(payload.toolIo.response.error, false, 'the host said it succeeded');
    assert.strictEqual(payload.responseOk, false, 'the legacy reader misreads error:false');
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

/**
 * RUNS TODAY, NOT TODO. The tests above wait for the staged patch. These do
 * not: they take the receipt the REAL, unpatched hook writes (every legacy
 * field computed by the hook's own code), add the one property the staged
 * patch adds, in the position it adds it, built by the real module, and sign
 * it onto a real chain with the real store. What is checked is the whole
 * chain file as it sits on disk: payload, hashes and signatures. The only
 * thing not exercised is the hook calling describeToolResponse itself, which
 * is exactly the staged line; the WIRED tests above cover that at the sitting.
 */
describe('the full receipt, composed from the real hook plus the staged field', () => {
  let tempDir;
  before(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-posttool-composed-')); });
  after(() => { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); });

  // The staged patch inserts toolIo after responseOk and before matcherHash.
  function withStagedField(legacy, toolResponse) {
    const out = {};
    for (const [k, v] of Object.entries(legacy)) {
      if (k === 'matcherHash') out.toolIo = describeToolResponse(toolResponse);
      out[k] = v;
    }
    assert.ok('toolIo' in out, 'precondition: the legacy receipt still has matcherHash to anchor on');
    return out;
  }

  async function composed(name, payload) {
    const hookHome = path.join(tempDir, `${name}-hook`);
    fs.mkdirSync(hookHome, { recursive: true });
    const res = await runHook({ home: hookHome, stdin: JSON.stringify(payload) });
    assert.strictEqual(res.code, 0);
    const egress = loadChain(hookHome).filter(e => e.payload?.type === 'egress-event');
    assert.strictEqual(egress.length, 1, 'precondition: the real hook wrote its receipt');
    const receipt = withStagedField(egress[0].payload, payload.tool_response);
    const home = path.join(tempDir, name);
    fs.mkdirSync(home, { recursive: true });
    const store = createStore(home);
    store.appendReceipt(receipt);
    assert.deepStrictEqual(store.verify(), { ok: true });
    const onDisk = fs.readFileSync(path.join(home, 'receipts', 'chain.jsonl'), 'utf8');
    return { receipt, onDisk, hookChain: fs.readFileSync(path.join(hookHome, 'receipts', 'chain.jsonl'), 'utf8') };
  }

  it('no response content reaches the signed chain (review F4)', async () => {
    const CANARY = 'ghp_CANARYcomposedTOKEN0123456789abcdef';
    const KEY_CANARY = 'aws_secret_access_key_CANARY';
    const response = {
      stdout: `export GITHUB_TOKEN=${CANARY}\r\n`,
      stderr: CANARY,
      [KEY_CANARY]: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYCANARY',
      nested: { list: [CANARY, { deeper: CANARY.slice(4) }] },
      is_error: false
    };
    const { receipt, onDisk, hookChain } = await composed('leak', {
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin x' },
      tool_response: response
    });
    assert.strictEqual(receipt.toolIo.response.recorded, true, 'precondition: the field was recorded');
    assert.ok(onDisk.includes(receipt.toolIo.response.digest), 'precondition: the field is on disk');
    for (const text of [onDisk, hookChain]) {
      for (const needle of [CANARY, CANARY.slice(4, 20), KEY_CANARY, 'GITHUB_TOKEN', 'wJalrXUtnFEMI']) {
        assert.ok(!text.includes(needle), `the chain must not contain ${needle}`);
      }
    }
  });

  it('responseOk and toolIo.error agree except on the documented inputs (review F2)', async () => {
    // [response, legacy responseOk, toolIo error]. The last three rows are
    // the documented disagreement; toolIo is authoritative on them.
    const rows = [
      [{ is_error: true }, false, true],
      [{ is_error: false }, true, false],
      [{ isError: true }, false, true],
      [{ error: 'ENOENT' }, false, true],
      [{ error: { code: 1 } }, false, true],
      [{ error: true }, false, true],
      [{ status: 404 }, false, true],
      [{ statusCode: 201 }, true, false],
      [{ stdout: 'error: x', stderr: '' }, null, null],
      ['plain', null, null],
      [{ error: false }, false, false],
      [{ error: '' }, false, null],
      [{ error: 0 }, false, null]
    ];
    for (const [i, [response, ok, err]] of rows.entries()) {
      const { receipt } = await composed(`agree-${i}`, {
        tool_name: 'Bash',
        tool_input: { command: 'git push --force origin x' },
        tool_response: response
      });
      const label = JSON.stringify(response);
      assert.strictEqual(receipt.responseOk, ok, `legacy responseOk for ${label}`);
      assert.strictEqual(receipt.toolIo.response.error, err, `toolIo error for ${label}`);
      const agrees = (ok === null && err === null) || (err !== null && ok === !err);
      assert.strictEqual(agrees, i < 10, `agreement for ${label} is as documented`);
    }
  });

  it('the engine-error receipt carries no toolIo (review F8)', async () => {
    const home = path.join(tempDir, 'engine-error');
    fs.mkdirSync(path.join(home, 'policy.json'), { recursive: true });
    const res = await runHook({
      home,
      stdin: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git push --force origin x' },
        tool_response: { stdout: 'x', is_error: false }
      })
    });
    assert.strictEqual(res.code, 0);
    const entries = loadChain(home).map(e => e.payload);
    const warns = entries.filter(p => p?.type === 'policy-warn' && p.ruleId === 'engine-error');
    assert.strictEqual(warns.length, 1, 'precondition: the engine-error path ran');
    assert.ok(!('toolIo' in warns[0]), 'a warning about the policy is not a record of a response');
    assert.strictEqual(entries.filter(p => p?.type === 'egress-event').length, 0);
  });
});
