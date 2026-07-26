import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadChain } from '../src/store/index.js';
import { findUnclosedSessions, renderMorningAfter } from '../src/views/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_PATH = path.join(__dirname, '..', 'bin', 'hook-session-start.js');
const END_HOOK_PATH = path.join(__dirname, '..', 'bin', 'hook-session-end.js');

/**
 * Run a hook as a real child process with an isolated LOTOR_HOME.
 */
function runHook(hookPath, { stdin = '', args = [], home, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath, ...args], {
      // A test may inject env (LOTOR_HARNESS and the like), but LOTOR_HOME is
      // applied LAST so nothing can point a child at the real store by
      // supplying its own environment. LOTOR_HARNESS is cleared by default so
      // an ambient value in the developer's shell cannot turn an "inferred" or
      // "unknown" assertion green for the wrong reason.
      env: { ...process.env, LOTOR_HARNESS: undefined, ...env, LOTOR_HOME: home },
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

const start = (opts) => runHook(HOOK_PATH, opts);

function payload(sessionId, source = 'startup') {
  return JSON.stringify({
    session_id: sessionId,
    source,
    cwd: '/repo',
    transcript_path: '/tmp/transcript.jsonl',
    hook_event_name: 'SessionStart'
  });
}

function opens(home) {
  return loadChain(home).filter(e => e.payload?.type === 'session-open');
}

describe('hook-session-start', () => {
  let home;

  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-start-'));
  });

  after(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  });

  it('creates the store on a cold home: keys and receipts exist after one run', async () => {
    assert.equal(fs.existsSync(path.join(home, 'keys')), false, 'precondition: no keys yet');

    const res = await start({ stdin: payload('sess-cold'), home });

    assert.equal(res.code, 0);
    assert.equal(res.stdout, '', 'nothing may go to stdout: SessionStart stdout enters session context');
    assert.ok(fs.existsSync(path.join(home, 'keys', 'chain.key')), 'chain key created at session start');
    assert.ok(fs.existsSync(path.join(home, 'keys', 'chain.pub')), 'chain pubkey created at session start');
    assert.ok(fs.existsSync(path.join(home, 'receipts', 'chain.jsonl')), 'chain file created at session start');
  });

  it('anchors session id, source, chain head, policy digest and hook registration', async () => {
    const entries = opens(home);
    assert.equal(entries.length, 1);
    const p = entries[0].payload;

    assert.equal(p.sessionId, 'sess-cold');
    assert.equal(p.source, 'startup');
    assert.equal(p.openIndex, 0);
    assert.equal(p.cwd, '/repo');
    assert.equal(p.chainLengthAtOpen, 0, 'first entry ever: chain was empty at open');
    assert.equal(p.chainHeadAtOpen, null, 'no head to anchor on an empty chain');
    assert.ok(p.policy, 'policy in force is recorded');
    assert.equal(typeof p.policy.digest, 'string');
    assert.ok(p.policy.digest.length > 0);
    assert.ok(p.hooks, 'hook registration snapshot is recorded');
    assert.equal(typeof p.timestamp, 'number');
  });

  it('anchors the real chain head once the chain is non-empty', async () => {
    await start({ stdin: payload('sess-second'), home });
    const entries = opens(home);
    const p = entries[entries.length - 1].payload;

    assert.equal(p.sessionId, 'sess-second');
    assert.equal(p.chainLengthAtOpen, 1);
    assert.ok(p.chainHeadAtOpen, 'head is anchored');
    assert.equal(p.chainHeadAtOpen.seq, 0);
    assert.equal(typeof p.chainHeadAtOpen.hash, 'string');
    assert.equal(p.verifiedAtOpen.ok, true, 'chain verifies at open');
  });

  it('indexes repeat firings for the same session (resume, clear, compact)', async () => {
    await start({ stdin: payload('sess-repeat', 'startup'), home });
    await start({ stdin: payload('sess-repeat', 'resume'), home });
    await start({ stdin: payload('sess-repeat', 'compact'), home });

    const mine = opens(home).filter(e => e.payload.sessionId === 'sess-repeat');
    assert.equal(mine.length, 3, 'every firing is its own entry, none collapsed');
    assert.deepEqual(mine.map(e => e.payload.openIndex), [0, 1, 2]);
    assert.deepEqual(mine.map(e => e.payload.source), ['startup', 'resume', 'compact']);
  });

  it('records the open even when stdin is absent or malformed, and never exits non-zero', async () => {
    const before = opens(home).length;

    const malformed = await start({ stdin: 'not json at all', home });
    assert.equal(malformed.code, 0);
    assert.match(malformed.stderr, /not valid JSON/);

    const empty = await start({ stdin: '', home });
    assert.equal(empty.code, 0);

    const after = opens(home);
    assert.equal(after.length, before + 2, 'a session with no usable payload is still recorded as opened');
    assert.equal(after[after.length - 1].payload.sessionId, null, 'unknown id recorded as null, not invented');
    assert.equal(after[after.length - 1].payload.source, 'unknown');
  });

  it('exits 0 and records nothing when LOTOR_HOME cannot be resolved', async () => {
    const res = await start({ stdin: payload('sess-nohome'), home: path.join(home, 'no', 'such', 'nested', 'dir') });
    assert.equal(res.code, 0, 'a broken home must never break the session');
  });

  it('chain still verifies after every open written above', async () => {
    const res = await start({ stdin: payload('sess-verify'), home });
    assert.equal(res.code, 0);
    const entries = opens(home);
    assert.equal(entries[entries.length - 1].payload.verifiedAtOpen.ok, true);
  });
});

describe('unclosed-session detection', () => {
  let home;

  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-unclosed-'));
  });

  after(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  });

  it('a session opened and never closed is reported as unclosed', async () => {
    await start({ stdin: payload('sess-died'), home });

    const result = findUnclosedSessions(loadChain(home));
    assert.equal(result.opened, 1);
    assert.equal(result.closed, 0);
    assert.equal(result.unclosed.length, 1);
    assert.equal(result.unclosed[0].sessionId, 'sess-died');
  });

  it('the morning-after view surfaces the unclosed count loudly', async () => {
    const rendered = renderMorningAfter(loadChain(home), home);
    assert.match(rendered, /SESSION OPENS/);
    assert.match(rendered, /\*\*\* UNCLOSED:\s+1 \*\*\*/);
    assert.match(rendered, /did not end cleanly/);
  });

  it('a session that opens AND closes is not reported as unclosed', async () => {
    const sessionId = 'sess-clean';
    await start({ stdin: payload(sessionId), home });

    // Write a real transcript and run the SessionEnd hook against it, so the
    // close is produced by the actual code path, not a hand-built payload.
    const transcript = path.join(home, 'clean.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({
        type: 'user',
        sessionId,
        version: '3.0.1',
        cwd: '/repo',
        timestamp: '2026-07-23T08:00:00.000Z',
        message: { role: 'user', content: 'hello' }
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId,
        version: '3.0.1',
        cwd: '/repo',
        timestamp: '2026-07-23T08:00:05.000Z',
        message: {
          role: 'assistant',
          model: 'test-model',
          id: 'msg-1',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 10, output_tokens: 5 }
        }
      })
    ].join('\n') + '\n');

    const res = await runHook(END_HOOK_PATH, { stdin: JSON.stringify({ transcript_path: transcript }), home });
    assert.equal(res.code, 0);

    const result = findUnclosedSessions(loadChain(home));
    const unclosedIds = result.unclosed.map(u => u.sessionId);
    assert.ok(!unclosedIds.includes(sessionId), 'a cleanly closed session is not flagged');
    assert.ok(unclosedIds.includes('sess-died'), 'the dead one is still flagged');
    assert.equal(result.closed, 1);
  });

  it('an empty chain reports zero opens rather than implying nothing happened', () => {
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-empty-'));
    try {
      const rendered = renderMorningAfter(loadChain(emptyHome), emptyHome);
      assert.match(rendered, /no session-open receipts/);
      assert.match(rendered, /UNKNOWN, not nothing/);
    } finally {
      try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    }
  });

  /**
   * End-to-end for KNOWN-LIMITS 13's second half. src/harness.js is unit-tested
   * separately; what is asserted here is that the resolved value actually
   * REACHES the chain entry, which is the only thing that matters for a field
   * whose whole job is to be readable back out of an append-only log.
   *
   * Deliberately run against an isolated temp LOTOR_HOME. Invoking the hook
   * against the real store to "just check" would append a permanent entry with
   * a fabricated session id, and the chain cannot be edited afterwards. A
   * verification step must not write to the thing it verifies.
   */
  describe('the harness field reaches the chain', () => {
    let h;

    before(() => {
      h = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-harness-'));
    });

    after(() => {
      try { fs.rmSync(h, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    });

    it('records an inferred harness with its basis and evidence', async () => {
      const res = await start({ stdin: payload('sess-harness-inferred'), home: h });
      assert.equal(res.code, 0);

      const entry = opens(h).find(e => e.payload.sessionId === 'sess-harness-inferred');
      assert.ok(entry, 'the open was recorded');

      const hv = entry.payload.harness;
      assert.ok(hv, 'session-open must carry a harness block');
      assert.equal(hv.name, 'claude-code');
      assert.equal(hv.basis, 'inferred', 'a guess must be recorded as a guess');
      assert.ok(Array.isArray(hv.evidence) && hv.evidence.length >= 2,
        'the evidence for the guess travels with it');
      assert.ok(hv.schema, 'a schema marker makes a later shape change visible');
    });

    it('records a declared harness over an inferable one', async () => {
      const res = await start({
        stdin: payload('sess-harness-declared'),
        home: h,
        // The launcher of a second harness sets this. It is the mechanism the
        // Pi work depends on, so it is exercised through the real hook rather
        // than only at the unit level.
        env: { LOTOR_HARNESS: 'pi-harness' }
      });
      assert.equal(res.code, 0);

      const entry = opens(h).find(e => e.payload.sessionId === 'sess-harness-declared');
      assert.ok(entry, 'the open was recorded');
      assert.equal(entry.payload.harness.name, 'pi-harness');
      assert.equal(entry.payload.harness.basis, 'declared');
    });

    it('records unknown rather than guessing when the payload says nothing', async () => {
      const res = await start({ stdin: JSON.stringify({ session_id: 'sess-harness-bare' }), home: h });
      assert.equal(res.code, 0);

      const entry = opens(h).find(e => e.payload.sessionId === 'sess-harness-bare');
      assert.ok(entry, 'the open was recorded');
      assert.equal(entry.payload.harness.basis, 'unknown');
      assert.notEqual(entry.payload.harness.name, 'claude-code',
        'an unattributable entry must not inherit this harness by default');
    });
  });
});
