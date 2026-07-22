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
import { lockPathFor } from '../src/store/lock.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Isolated temp home. The real ~/.lotor is never touched by these tests. */
function createTempTestDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-keypair-'));
}

/**
 * Write a tiny script that creates a store and appends exactly ONE receipt
 * against the LOTOR_HOME it inherits. Used to get REAL cross-process
 * concurrency on a FRESH home (no keys/ yet).
 *
 * The barrier matters: without it, node's ~30ms startup staggers the children
 * enough that they rarely overlap, and the test passes even against the buggy
 * non-locking implementation. Every child busy-waits until a shared
 * wall-clock instant, so all N hit createStore()/appendReceipt() together
 * (which is when both the keypair race AND the chain-tail race can fire).
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
    `  session: { id, model: 'keypair-race-test' },`,
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

describe('store keypair race', () => {
  let testDirs = [];

  afterEach(() => {
    for (const dir of testDirs) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    testDirs = [];
  });

  it('serializes keypair generation across concurrent processes on a fresh home', { timeout: 60000 }, async () => {
    const baseDir = createTempTestDir();
    testDirs.push(baseDir);

    // No parent store pre-creation: this is a TRULY fresh home with no keys/
    // directory yet. Every child has to participate in the keypair race.
    assert.ok(
      !fs.existsSync(path.join(baseDir, 'keys')),
      'fresh home should not have a keys/ directory before the test starts'
    );

    const scriptPath = writeAppenderScript(baseDir);

    const N = 6;
    // Give every child time to boot and reach the barrier before it opens.
    const startAt = Date.now() + 2000;

    // Start ALL of them before awaiting any of them.
    const running = [];
    for (let i = 0; i < N; i++) {
      running.push(spawnAppender(scriptPath, baseDir, `keypair-${i}`, startAt));
    }
    const results = await Promise.all(running);

    for (const r of results) {
      assert.strictEqual(r.code, 0, `appender ${r.id} failed (exit ${r.code}): ${r.stderr}`);
    }

    // Keys must exist on disk exactly once.
    assert.ok(fs.existsSync(path.join(baseDir, 'keys', 'chain.pub')), 'chain.pub must exist');
    assert.ok(fs.existsSync(path.join(baseDir, 'keys', 'chain.key')), 'chain.key must exist');

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

    // Verify the chain against the public key that is actually on disk at the
    // end. This is the failure mode the fix targets: an entry signed by a
    // private key that is no longer on disk (because a different process's
    // generated keypair won the last-writer race) will fail this check.
    const onDiskPub = fs.readFileSync(path.join(baseDir, 'keys', 'chain.pub'), 'utf-8');
    const publicKey = crypto.createPublicKey(onDiskPub);
    const result = verifyChain(entries, publicKey);
    assert.strictEqual(result.ok, true, `chain should verify against on-disk public key: ${result.reason || ''}`);

    // Every session id landed exactly once.
    const ids = new Set(entries.map((e) => e.payload?.session?.id));
    assert.strictEqual(ids.size, N, 'each appender should have written exactly one receipt');
  });

  it('takes no lock on the fast path when keys already exist', () => {
    const baseDir = createTempTestDir();
    testDirs.push(baseDir);

    // Seed keys by creating a store once. After this, both key files exist.
    const seeded = createStore(baseDir);
    assert.ok(fs.existsSync(path.join(baseDir, 'keys', 'chain.pub')));
    assert.ok(fs.existsSync(path.join(baseDir, 'keys', 'chain.key')));

    // Confirm no leftover lock from the seed call.
    assert.strictEqual(
      fs.existsSync(lockPathFor(baseDir)),
      false,
      'no lock file should remain after the seed createStore() call'
    );

    // Fast path: createStore again. Keys already exist, so loadOrCreateKeyPair
    // must NOT take the chain lock. We assert this by checking that no
    // .chain.lock file is created at any point during the call (it would be
    // released in the finally, but withLock only ever creates it under the
    // slow path).
    const store = createStore(baseDir);
    assert.strictEqual(
      fs.existsSync(lockPathFor(baseDir)),
      false,
      'fast path should not create a .chain.lock file'
    );

    // Returned keys must match what is on disk.
    const onDiskPub = fs.readFileSync(path.join(baseDir, 'keys', 'chain.pub'), 'utf-8');
    const onDiskPriv = fs.readFileSync(path.join(baseDir, 'keys', 'chain.key'), 'utf-8');
    assert.strictEqual(store.keyPair.publicKey, onDiskPub, 'public key on disk must match returned keypair');
    assert.strictEqual(store.keyPair.privateKey, onDiskPriv, 'private key on disk must match returned keypair');

    // Sanity: the seed's keypair and the fast-path keypair are byte-identical.
    assert.strictEqual(store.keyPair.publicKey, seeded.keyPair.publicKey);
    assert.strictEqual(store.keyPair.privateKey, seeded.keyPair.privateKey);
  });
});
