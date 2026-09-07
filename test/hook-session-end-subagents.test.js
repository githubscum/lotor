import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadChain } from '../src/store/index.js';

/**
 * WO-TRACE-BRIDGE-01, the last mile. CLOSED 2026-09-07 at the signing sitting.
 *
 * src/ingest/index.js reads opts.transcriptPath and binds a subagents summary
 * onto the receipt when a sibling <transcript-basename>/subagents/ directory
 * exists (see test/subagent-ingest-wiring.test.js). bin/hook-session-end.js
 * is the ONLY caller that matters in production — it is what Claude Code's
 * SessionEnd hook actually invokes — and until this sitting it called
 * `ingestSession(text, { transcriptBytes: bytes })`, one field short of
 * `transcriptPath`. The reader was live; the wire from the hook to it was not.
 *
 * The one-line fix landed under signature:
 *   bin/hook-session-end.js
 *     - const result = ingestSession(text, { transcriptBytes: bytes });
 *     + const result = ingestSession(text, { transcriptBytes: bytes, transcriptPath });
 *
 * This test was the tripwire pinning the dark behaviour; it is now the
 * inverted assertion: a real subagents sidecar beside a real parent
 * transcript, ingested through the real hook binary, produces a receipt WITH
 * the subagents field and the sidecar's exact totals. Not deleted, on the
 * entry-25 lesson: a test that silently stops running the moment behaviour
 * changes is how a gap stays closed on paper only.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, '..', 'bin', 'hook-session-end.js');

function line(obj) { return JSON.stringify(obj); }

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

function syntheticTranscript(sessionId) {
  return [
    JSON.stringify({
      type: 'user',
      sessionId,
      version: '3.0.1',
      cwd: '/repo',
      timestamp: '2026-09-03T22:00:00.000Z',
      message: { role: 'user', content: 'hello' }
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId,
      version: '3.0.1',
      cwd: '/repo',
      timestamp: '2026-09-03T22:00:05.000Z',
      message: {
        role: 'assistant',
        model: 'hook-test-model',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 10, output_tokens: 5 }
      }
    }),
    JSON.stringify({
      type: 'summary',
      sessionId,
      version: '3.0.1',
      cwd: '/repo',
      timestamp: '2026-09-03T22:01:00.000Z'
    })
  ].join('\n') + '\n';
}

// Matches collectSubagents' expectation: <dir>/<basename minus .jsonl>/subagents/
function subagentsDirFor(transcriptPath) {
  return path.join(
    path.dirname(transcriptPath),
    path.basename(transcriptPath, '.jsonl'),
    'subagents'
  );
}

describe('bin/hook-session-end.js x subagent sidecar (WO-TRACE-BRIDGE-01 last mile)', () => {
  let tempDir;
  let home;
  let transcriptPath;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-hook-subagents-'));
    home = path.join(tempDir, 'home');
    fs.mkdirSync(home, { recursive: true });

    transcriptPath = path.join(tempDir, 'hook-subagents-parent.jsonl');
    fs.writeFileSync(transcriptPath, syntheticTranscript('hook-subagents-parent-001'));

    // A real, non-empty subagents sidecar sitting exactly where
    // collectSubagents looks for it, right beside the parent transcript.
    const dir = subagentsDirFor(transcriptPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'agent-child-1.jsonl'),
      line({
        agentId: 'child-1',
        sessionId: 'hook-subagents-parent-001',
        message: { model: 'child-model', usage: { input_tokens: 40, output_tokens: 20 } }
      }) + '\n',
      'utf-8'
    );
  });

  after(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('binds the sibling subagents dir onto the receipt the hook writes', async () => {
    const res = await runHook({
      home,
      stdin: JSON.stringify({ transcript_path: transcriptPath })
    });

    assert.strictEqual(res.code, 0, 'hook should exit 0');

    const chain = loadChain(home);
    assert.strictEqual(chain.length, 1, 'chain should have exactly one entry');
    assert.strictEqual(chain[0].payload.session.id, 'hook-subagents-parent-001');

    // The dir exists, has one child, and carries real usage. The reader
    // (summarizeSubagents) is proven in test/subagent-ingest-wiring.test.js;
    // this proves the hook now hands it the path it needs.
    const sub = chain[0].payload.subagents;
    assert.ok(sub, 'the receipt carries a subagents summary; absent means the wire from the hook is dark again');
    assert.strictEqual(sub.schema, 'subagents/1');
    assert.strictEqual(sub.count, 1);
    assert.strictEqual(sub.totals.inputTokens, 40);
    assert.strictEqual(sub.totals.outputTokens, 20);
  });
});
