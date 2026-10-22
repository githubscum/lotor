import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * V3-04 end to end: the PostToolUse hook appends a reasoning-step receipt.
 *
 * TODO UNTIL THE SIGNING SITTING. The hook edit lives in
 * proposals/v3-04-hook-post-tool-use.patch because bin/ is core and the
 * builder could not (and must not) edit it unsigned. At the sitting: apply
 * the patch, delete the `todo` option below, and this test must pass.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hook = path.join(repo, 'bin', 'hook-post-tool-use.js');
let home, tmp;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-r3-hook-home-'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-r3-hook-tx-'));
});
after(() => {
  for (const d of [home, tmp]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
});

describe('PostToolUse hook wiring (V3-04)', () => {
  it('a non-egress tool call still lands one reasoning-step receipt', { todo: 'apply proposals/v3-04-hook-post-tool-use.patch at the signing sitting' }, () => {
    const tx = path.join(tmp, 't.jsonl');
    fs.writeFileSync(tx,
      JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: 'synthetic', signature: 's' }] } }) + '\n' +
      JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x' } }] } }) + '\n');
    const payload = JSON.stringify({ session_id: 'hook-s', transcript_path: tx, tool_use_id: 'tu1', tool_name: 'Read', tool_input: { file_path: '/x' }, tool_response: 'ok' });
    const r = spawnSync(process.execPath, [hook], { input: payload, env: { ...process.env, LOTOR_HOME: home }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    const chain = path.join(home, 'receipts', 'chain.jsonl');
    assert.ok(fs.existsSync(chain), 'hook wrote no chain');
    const steps = fs.readFileSync(chain, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      .filter(e => e.payload?.type === 'reasoning-step');
    assert.strictEqual(steps.length, 1);
    assert.strictEqual(steps[0].payload.kind, 'thinking-signed');
  });
});
