import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createStore, loadChain } from '../src/store/index.js';
import { verifyChain } from '../src/chain/index.js';
import { withLock, lockPathFor, STALE_MS } from '../src/store/lock.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Isolated temp home. The real ~/.lotor is never touched by these tests. */
function createTempTestDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-conc-'));
}

/**
 * Write a tiny script that appends exactly ONE receipt to the store at
 * $LOTOR_HOME, then exits. Used to get REAL cross-process concurrency.
 *
 * The barrier matters: without it, node's ~30ms startup staggers the children
 * enough that they rarely overlap, and the test passes even against the buggy
 * non-locking implementation. Every child busy-waits until a shared wall-clock
 * instant, so all N hit createStore()/appendReceipt() together.
 */
function writeAppenderScript(dir) {
  const storeUrl = pathToFileURL(path.join(REPO_ROOT, 'src', 'store', 'index.js')).href;
  const homeUrl = pathToFileURL(path.join(REPO_ROOT, 'src', 'home.js')).href;

  const script = [
    `import { createStore } from ${JSON.stringify(storeUrl)};`,
    `import { resolveHome } from ${JSON.stringify(homeUrl)};`,
    ``,
    `const id = process.argv[2];`,
    `const startAt = Number(process.argv[3]);`,
    ``,
    `// Barrier: block until the agreed instant, then all children race.`,
    `const view = new Int32Array(new SharedArrayBuffer(4));`,
    `for (;;) {`,
    `  const remaining = startAt - Date.now();`,
    `  if (remaining <= 0) break;`,
    `  Atomics.wait(view, 0, 0, Math.min(remaining, 5));`,
    `}`,
    ``,
    `const store = createStore(resolveHome());`,
    `store.appendReceipt({`,
    `  session: { id, model: 'concurrency-test' },`,
    `  ran: [], touched: [], failed: [], cost: {},`,
    `  counts: { turns: 1, toolCalls: 0, failures: 0 }`,
    `});`,
    ''
  ].join('\n');

  const scriptPath = path.join(dir, 'append-one.mjs');
  fs.writeFileSync(scriptPath, script, 'utf-8');
  return scriptPath;
}

function spawnAppender(scriptPath, home, id, startAt) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, id, String(startAt)], {
      env: { ...process.env, LOTOR_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => resolve({ id, code, stderr }));
    child.on('error', (err) => resolve({ id, code: -1, stderr: String(err) }));
  });
}

describe('store concurrency', () => {
  let testDirs = [];

  afterEach(() => {
    for (const dir of testDirs) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    testDirs = [];
  });

  it('serializes concurrent appends from separate processes', { timeout: 120000 }, async () => {
    const baseDir = createTempTestDir();
    testDirs.push(baseDir);

    // Pre-create the store so the chain signing keypair exists BEFORE the
    // children start. Key generation is a separate race, out of scope here;
    // this test targets the chain-append race specifically.
    const parentStore = createStore(baseDir);
    assert.strictEqual(parentStore.entries.length, 0, 'fresh home should start empty');

    const scriptPath = writeAppenderScript(baseDir);

    const N = 8;
    // Give every child time to boot and reach the barrier before it opens.
    const startAt = Date.now() + 2000;

    // Start ALL of them before awaiting any of them.
    const running = [];
    for (let i = 0; i < N; i++) {
      running.push(spawnAppender(scriptPath, baseDir, `concurrent-${i}`, startAt));
    }
    const results = await Promise.all(running);

    for (const r of results) {
      assert.strictEqual(r.code, 0, `appender ${r.id} failed (exit ${r.code}): ${r.stderr}`);
    }

    const entries = loadChain(baseDir);

    assert.strictEqual(entries.length, N, `chain should have exactly ${N} entries, got ${entries.length}`);

    const seqs = entries.map((e) => e.seq);
    const uniqueSeqs = new Set(seqs);
    assert.strictEqual(uniqueSeqs.size, N, `duplicate seq values found: ${JSON.stringify(seqs)}`);
    assert.deepStrictEqual(
      [...seqs].sort((a, b) => a - b),
      Array.from({ length: N }, (_, i) => i),
      `seq values should be exactly 0..${N - 1}, got ${JSON.stringify(seqs)}`
    );

    const publicKey = crypto.createPublicKey(parentStore.keyPair.publicKey);
    const result = verifyChain(entries, publicKey);
    assert.strictEqual(result.ok, true, `chain should verify: ${result.reason || ''}`);

    // Every session id landed exactly once.
    const ids = new Set(entries.map((e) => e.payload?.session?.id));
    assert.strictEqual(ids.size, N, 'each appender should have written exactly one receipt');
  });

  it('steals a stale lock instead of deadlocking', () => {
    const baseDir = createTempTestDir();
    testDirs.push(baseDir);

    const store = createStore(baseDir);
    const lockPath = lockPathFor(baseDir);

    // Simulate a crashed process that left its lock behind, long ago.
    fs.writeFileSync(lockPath, '999999 0');
    const backdated = new Date(Date.now() - (STALE_MS * 2));
    fs.utimesSync(lockPath, backdated, backdated);
    assert.ok(fs.existsSync(lockPath), 'stale lock should be in place before the append');

    const entry = store.appendReceipt({ session: { id: 'stale-lock-test', model: 'test' } });

    assert.strictEqual(entry.seq, 0, 'entry should have landed');
    const entries = loadChain(baseDir);
    assert.strictEqual(entries.length, 1, 'entry should be persisted');
    assert.strictEqual(entries[0].payload.session.id, 'stale-lock-test');
  });

  it('releases the lock after a successful append', () => {
    const baseDir = createTempTestDir();
    testDirs.push(baseDir);

    const store = createStore(baseDir);
    store.appendReceipt({ session: { id: 'release-test', model: 'test' } });

    assert.strictEqual(
      fs.existsSync(lockPathFor(baseDir)),
      false,
      'lock file should not exist after a successful append'
    );
  });

  it('releases the lock when the critical section throws', () => {
    const baseDir = createTempTestDir();
    testDirs.push(baseDir);

    createStore(baseDir); // ensures receipts/ exists

    let caught = null;
    try {
      withLock(baseDir, () => {
        throw new Error('boom');
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, 'the error should propagate out of withLock');
    assert.strictEqual(caught.message, 'boom');
    assert.strictEqual(
      fs.existsSync(lockPathFor(baseDir)),
      false,
      'lock file should be released even when fn throws'
    );
  });
});
