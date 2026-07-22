import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadChain } from '../src/store/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, '..', 'bin', 'hook-session-end.js');

/**
 * Run the hook as a real child process with an isolated LOTOR_HOME.
 * @param {Object} opts
 * @param {string} [opts.stdin] - Text piped to the hook's stdin.
 * @param {string[]} [opts.args] - Extra argv entries.
 * @param {string} opts.home - The throwaway LOTOR_HOME.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
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

/**
 * A minimal transcript in the real Claude Code shape (timestamp, no header line).
 */
function syntheticTranscript(sessionId) {
  return [
    JSON.stringify({
      type: 'user',
      sessionId,
      version: '3.0.1',
      cwd: '/repo',
      timestamp: '2026-07-22T08:00:00.000Z',
      message: { role: 'user', content: 'hello' }
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId,
      version: '3.0.1',
      cwd: '/repo',
      timestamp: '2026-07-22T08:00:05.000Z',
      message: {
        role: 'assistant',
        model: 'hook-test-model',
        content: [
          { type: 'tool_use', name: 'Read', id: 'r-1', input: { file_path: '/repo/a.js' } }
        ],
        usage: { input_tokens: 10, output_tokens: 5 }
      }
    }),
    JSON.stringify({
      type: 'summary',
      sessionId,
      version: '3.0.1',
      cwd: '/repo',
      timestamp: '2026-07-22T08:01:00.000Z'
    })
  ].join('\n') + '\n';
}

describe('bin/hook-session-end.js', () => {
  let tempDir;
  let home;
  let transcriptPath;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-hook-'));
    home = path.join(tempDir, 'home');
    fs.mkdirSync(home, { recursive: true });
    transcriptPath = path.join(tempDir, 'session.jsonl');
    fs.writeFileSync(transcriptPath, syntheticTranscript('hook-session-001'));
  });

  after(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('appends one receipt when given a transcript_path payload on stdin', async () => {
    assert.strictEqual(loadChain(home).length, 0, 'chain should start empty');

    const res = await runHook({
      home,
      stdin: JSON.stringify({ transcript_path: transcriptPath })
    });

    assert.strictEqual(res.code, 0, 'hook should exit 0');
    assert.strictEqual(res.stdout, '', 'hook should write nothing to stdout');

    const chain = loadChain(home);
    assert.strictEqual(chain.length, 1, 'chain should have exactly one entry');
    assert.strictEqual(chain[0].payload.session.id, 'hook-session-001');
    assert.strictEqual(chain[0].payload.session.model, 'hook-test-model');
    assert.strictEqual(chain[0].payload.session.startedAt, '2026-07-22T08:00:00.000Z');
    assert.strictEqual(chain[0].payload.session.endedAt, '2026-07-22T08:01:00.000Z');
  });

  it('is idempotent: a second run on the same transcript does not duplicate', async () => {
    const before = loadChain(home).length;
    assert.strictEqual(before, 1, 'precondition: one entry from the first run');

    const res = await runHook({
      home,
      stdin: JSON.stringify({ transcript_path: transcriptPath })
    });

    assert.strictEqual(res.code, 0, 'hook should exit 0');
    assert.strictEqual(loadChain(home).length, 1, 'chain length should be unchanged');
    assert.match(res.stderr, /already in chain/, 'should report the skip on stderr');
  });

  it('accepts the transcriptPath camelCase fallback key', async () => {
    const altHome = path.join(tempDir, 'home-alt');
    fs.mkdirSync(altHome, { recursive: true });

    const res = await runHook({
      home: altHome,
      stdin: JSON.stringify({ transcriptPath: transcriptPath })
    });

    assert.strictEqual(res.code, 0);
    assert.strictEqual(loadChain(altHome).length, 1);
  });

  it('accepts a path as argv[2] with no stdin payload', async () => {
    const argvHome = path.join(tempDir, 'home-argv');
    fs.mkdirSync(argvHome, { recursive: true });

    const res = await runHook({
      home: argvHome,
      args: [transcriptPath],
      stdin: ''
    });

    assert.strictEqual(res.code, 0);
    assert.strictEqual(loadChain(argvHome).length, 1);
  });

  it('exits 0 and appends nothing on a garbage stdin payload', async () => {
    const badHome = path.join(tempDir, 'home-garbage');
    fs.mkdirSync(badHome, { recursive: true });

    const res = await runHook({ home: badHome, stdin: 'not json at all {{{' });

    assert.strictEqual(res.code, 0, 'hook must never exit non-zero');
    assert.strictEqual(res.stdout, '');
    assert.strictEqual(loadChain(badHome).length, 0, 'nothing should be appended');
  });

  it('exits 0 and appends nothing when the transcript path does not exist', async () => {
    const missingHome = path.join(tempDir, 'home-missing');
    fs.mkdirSync(missingHome, { recursive: true });

    const res = await runHook({
      home: missingHome,
      stdin: JSON.stringify({ transcript_path: path.join(tempDir, 'nope.jsonl') })
    });

    assert.strictEqual(res.code, 0);
    assert.strictEqual(res.stdout, '');
    assert.strictEqual(loadChain(missingHome).length, 0);
    assert.match(res.stderr, /could not read transcript/);
  });

  it('exits 0 on an empty stdin payload with no path', async () => {
    const emptyHome = path.join(tempDir, 'home-empty');
    fs.mkdirSync(emptyHome, { recursive: true });

    const res = await runHook({ home: emptyHome, stdin: '' });

    assert.strictEqual(res.code, 0);
    assert.strictEqual(loadChain(emptyHome).length, 0);
  });

  it('exits 0 when the payload is valid JSON but carries no transcript path', async () => {
    const noPathHome = path.join(tempDir, 'home-nopath');
    fs.mkdirSync(noPathHome, { recursive: true });

    const res = await runHook({
      home: noPathHome,
      stdin: JSON.stringify({ hook_event_name: 'SessionEnd', reason: 'clear' })
    });

    assert.strictEqual(res.code, 0);
    assert.strictEqual(loadChain(noPathHome).length, 0);
    assert.match(res.stderr, /no transcript_path/);
  });
});
