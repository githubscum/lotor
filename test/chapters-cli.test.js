/**
 * test/chapters-cli.test.js
 *
 * `bin/chapters.js` exercised as a real child process, against a throwaway
 * LOTOR_HOME holding a two-row chain that points at a transcript fixture.
 *
 * WHY A CHILD PROCESS
 *   Same reason as charter-cli.test.js: bin scripts call main() at module
 *   scope, and this is the thing the owner types.
 *
 * WHY THIS FILE CAN SKIP, AND WHY THE SKIP IS LOUD
 *   The whole of bin/ is self-mod protected (found 2026-09-07 when the gate
 *   denied the Write of bin/chapters.js with "a tool in the protected bin/
 *   directory"). The CLI is therefore staged in
 *   proposals/chapters-cli-staged-2026-09-07.md and lands only under a
 *   signature. Until it lands, this suite SKIPS with that reason rather than
 *   failing, and the skip shows in the runner's counts. A silent pass would be
 *   the lie; a visible skip is the state of the world.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'bin', 'chapters.js');
const CLAUDE_FIXTURE = path.join(HERE, '..', 'test-data', 'sample-session-chapters.jsonl');
const CODEX_FIXTURE = path.join(HERE, '..', 'test-data', 'sample-codex-rollout.jsonl');
const CLI_PRESENT = fs.existsSync(CLI);
const SKIP_REASON = 'bin/chapters.js has not landed; it is staged in proposals/chapters-cli-staged-2026-09-07.md pending signature';

function run(args, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, LOTOR_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

describe('bin/chapters.js', { skip: CLI_PRESENT ? false : SKIP_REASON }, () => {
  let home;
  let transcript;
  let codexDir;
  const T0 = Date.parse('2026-09-06T10:00:00.000Z');

  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-chapters-cli-'));
    transcript = path.join(home, 'chap-001.jsonl');
    fs.copyFileSync(CLAUDE_FIXTURE, transcript);
    codexDir = path.join(home, 'codex', '2026', '09', '06');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.copyFileSync(CODEX_FIXTURE, path.join(codexDir, 'rollout-2026-09-06T12-00-00-codex-001.jsonl'));
    fs.writeFileSync(path.join(codexDir, 'not-a-rollout.jsonl'), '{}\n');

    // loadChain reads rows, it does not verify them, so a two-row chain with
    // placeholder hashes is enough to drive the view.
    const rows = [
      { seq: 0, timestamp: T0, prevHash: '0', hash: 'h0', nonce: 'n', sig: 's',
        payload: { type: 'session-open', sessionId: 'chap-001', source: 'startup', cwd: '/home/demo/project', transcriptPath: transcript } },
      { seq: 1, timestamp: T0 + 600000, prevHash: 'h0', hash: 'h1', nonce: 'n', sig: 's',
        payload: { session: { id: 'chap-001', model: 'claude-sonnet-5' }, counts: { turns: 5, toolCalls: 4, failures: 1 }, touched: [] } }
    ];
    fs.mkdirSync(path.join(home, 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(home, 'receipts', 'chain.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  });
  after(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('--json reports the chain session with its chapters and witness flag', async () => {
    const { code, stdout, stderr } = await run(['--json'], home);
    assert.equal(code, 0, stderr);
    const report = JSON.parse(stdout);
    assert.equal(report.sessions.length, 1);
    const s = report.sessions[0];
    assert.equal(s.sessionId, 'chap-001');
    assert.equal(s.witnessed, true);
    assert.equal(s.chapters.length, 2);
    assert.equal(s.chapters[0].title, 'Please fix the config flag and clean the temp dir');
  });

  it('--codex <dir> globs rollout-*.jsonl recursively and reports them unwitnessed', async () => {
    const { code, stdout } = await run(['--json', '--codex', path.join(home, 'codex')], home);
    assert.equal(code, 0);
    const report = JSON.parse(stdout);
    const codex = report.sessions.filter(s => s.runtime === 'codex');
    assert.equal(codex.length, 1, 'only rollout-*.jsonl files are picked up');
    assert.equal(codex[0].sessionId, 'codex-001');
    assert.equal(codex[0].witnessed, false);
  });

  it('--since and --session narrow the report', async () => {
    const later = await run(['--json', '--since', String(T0 + 700000)], home);
    assert.equal(JSON.parse(later.stdout).sessions.length, 0);
    const iso = await run(['--json', '--since', '2026-09-06T09:00:00Z'], home);
    assert.equal(JSON.parse(iso.stdout).sessions.length, 1);
    const other = await run(['--json', '--session', 'nobody'], home);
    assert.equal(JSON.parse(other.stdout).sessions.length, 0);
  });

  it('without --json it renders the plain view', async () => {
    const { code, stdout } = await run([], home);
    assert.equal(code, 0);
    assert.match(stdout, /CHAPTERS: WHAT WAS ASKED/);
    assert.match(stdout, /"Please fix the config flag and clean the temp dir"/);
    assert.match(stdout, /WHAT THIS DOES NOT TELL YOU/);
  });
});
