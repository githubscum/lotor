import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ingestSession } from '../src/ingest/index.js';
import { loadChain, createStore } from '../src/store/index.js';
import { verifyChain } from '../src/chain/index.js';
import { renderMorningAfter, renderSessionReceipt } from '../src/views/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Isolated temp home. The real ~/.lotor is never touched by these tests. */
function createTempTestDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-subsess-'));
}

/** Build a synthetic JSONL transcript with a given number of lines. */
function transcript(sessionId, lines = 3) {
  const out = [];
  for (let i = 0; i < lines; i++) {
    out.push(JSON.stringify({
      type: i === 0 ? 'user' : 'assistant',
      sessionId,
      version: '3.0.1',
      cwd: '/repo',
      timestamp: new Date(Date.UTC(2026, 6, 22, 8, 0, i)).toISOString(),
      message: i === 0
        ? { role: 'user', content: 'hello' }
        : {
            role: 'assistant',
            model: 'subsess-test-model',
            content: [{ type: 'text', text: `turn ${i}` }],
            usage: { input_tokens: 1, output_tokens: 1 }
          }
    }));
  }
  return out.join('\n') + '\n';
}

/** Run a child node process that ingests a given transcript path. */
function writeIngestScript(dir) {
  const ingestUrl = pathToFileURL(path.join(REPO_ROOT, 'src', 'ingest', 'index.js')).href;
  const homeUrl = pathToFileURL(path.join(REPO_ROOT, 'src', 'home.js')).href;
  const script = [
    `import { ingestSession } from ${JSON.stringify(ingestUrl)};`,
    `import { resolveHome } from ${JSON.stringify(homeUrl)};`,
    `import fs from 'node:fs';`,
    ``,
    `const transcriptPath = process.argv[2];`,
    `const startAt = Number(process.argv[3]);`,
    ``,
    `// Wall-clock barrier: all children busy-wait until the same instant.`,
    `const view = new Int32Array(new SharedArrayBuffer(4));`,
    `for (;;) {`,
    `  const remaining = startAt - Date.now();`,
    `  if (remaining <= 0) break;`,
    `  Atomics.wait(view, 0, 0, Math.min(remaining, 5));`,
    `}`,
    ``,
    `const text = fs.readFileSync(transcriptPath, 'utf-8');`,
    `ingestSession(text);`,
    ``,
    `process.exit(0);`,
    ''
  ].join('\n');

  const scriptPath = path.join(dir, 'ingest-one.mjs');
  fs.writeFileSync(scriptPath, script, 'utf-8');
  return scriptPath;
}

function spawnIngest(scriptPath, home, transcriptPath, startAt) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, transcriptPath, String(startAt)], {
      env: { ...process.env, LOTOR_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => resolve({ code, stderr }));
    child.on('error', (err) => resolve({ code: -1, stderr: String(err) }));
  });
}

describe('subsession receipts with no-change guard', () => {
  let testDirs = [];
  let originalHome;

  beforeEach(() => {
    originalHome = process.env.LOTOR_HOME;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.LOTOR_HOME;
    } else {
      process.env.LOTOR_HOME = originalHome;
    }
    for (const dir of testDirs) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    testDirs = [];
  });

  it('1. first ingest of a transcript produces subsession 0', () => {
    const home = createTempTestDir();
    testDirs.push(home);
    process.env.LOTOR_HOME = home;

    const r1 = ingestSession(transcript('sess-A'));
    assert.strictEqual(r1.skipped, false);
    assert.strictEqual(r1.subsession, 0);
    assert.strictEqual(r1.sessionId, 'sess-A');
    assert.ok(r1.entry, 'entry should be present');
    assert.strictEqual(r1.entry.payload.session.subsession, 0);
  });

  it('2. re-ingesting the SAME transcript with no growth appends nothing', () => {
    const home = createTempTestDir();
    testDirs.push(home);
    process.env.LOTOR_HOME = home;

    const text = transcript('sess-B', 5);
    const r1 = ingestSession(text);
    assert.strictEqual(r1.skipped, false);
    const before = loadChain(home).length;
    assert.strictEqual(before, 1);

    const r2 = ingestSession(text);
    assert.strictEqual(r2.skipped, true, 'no-change guard should skip');
    assert.strictEqual(r2.entry, null);
    assert.strictEqual(loadChain(home).length, before, 'chain length must not change');
  });

  it('3. ingesting a GROWN transcript appends subsession 1', () => {
    const home = createTempTestDir();
    testDirs.push(home);
    process.env.LOTOR_HOME = home;

    const r1 = ingestSession(transcript('sess-C', 3));
    assert.strictEqual(r1.subsession, 0);

    const r2 = ingestSession(transcript('sess-C', 7));
    assert.strictEqual(r2.skipped, false);
    assert.strictEqual(r2.subsession, 1);
    assert.strictEqual(r2.entry.payload.session.subsession, 1);

    const chain = loadChain(home);
    assert.strictEqual(chain.length, 2, 'chain should hold two receipts');
    const sessionReceipts = chain.filter(e => e.payload?.session?.id === 'sess-C');
    assert.strictEqual(sessionReceipts.length, 2);
    assert.strictEqual(sessionReceipts[0].payload.session.subsession, 0);
    assert.strictEqual(sessionReceipts[1].payload.session.subsession, 1);
  });

  it('4. a different session id starts its own numbering at 0', () => {
    const home = createTempTestDir();
    testDirs.push(home);
    process.env.LOTOR_HOME = home;

    const r1 = ingestSession(transcript('sess-D', 3));
    const r2 = ingestSession(transcript('sess-D', 5));
    const r3 = ingestSession(transcript('sess-E', 3));

    assert.strictEqual(r1.subsession, 0);
    assert.strictEqual(r2.subsession, 1);
    assert.strictEqual(r3.subsession, 0, 'different session id should restart at 0');

    const chain = loadChain(home);
    assert.strictEqual(chain.length, 3);
    const dReceipts = chain.filter(e => e.payload?.session?.id === 'sess-D');
    const eReceipts = chain.filter(e => e.payload?.session?.id === 'sess-E');
    assert.strictEqual(dReceipts.length, 2);
    assert.strictEqual(eReceipts.length, 1);
    assert.strictEqual(eReceipts[0].payload.session.subsession, 0);
  });

  it('5. renderMorningAfter reports total session receipts and distinct sessions', () => {
    const home = createTempTestDir();
    testDirs.push(home);
    process.env.LOTOR_HOME = home;

    ingestSession(transcript('sess-F', 3));
    ingestSession(transcript('sess-F', 5));
    ingestSession(transcript('sess-G', 3));

    const chain = loadChain(home);
    const view = renderMorningAfter(chain, home);

    assert.match(view, /Session receipts:\s+3/, 'should show 3 total session receipts');
    assert.match(view, /Distinct sessions:\s+2/, 'should show 2 distinct sessions');
  });

  it('5b. renderSessionReceipt shows the Subsession line when present', () => {
    const home = createTempTestDir();
    testDirs.push(home);
    process.env.LOTOR_HOME = home;

    const r1 = ingestSession(transcript('sess-H', 3));
    const r2 = ingestSession(transcript('sess-H', 5));

    const view = renderSessionReceipt(r2.entry.payload);
    assert.match(view, /Subsession:\s+1/, 'should show the subsession line');
  });

  it('5c. renderSessionReceipt omits the Subsession line when absent', () => {
    const legacyPayload = {
      session: { id: 'legacy', model: 'm' },
      ran: [], touched: [], failed: [], cost: {},
      counts: { turns: 0, toolCalls: 0, failures: 0, transcriptEntries: 0 }
    };
    const view = renderSessionReceipt(legacyPayload);
    assert.ok(!/Subsession:/.test(view), 'legacy payload should not show Subsession');
  });

  it('6. concurrent guard: 4 processes racing on the same transcript yield exactly one receipt', { timeout: 60000 }, async () => {
    const home = createTempTestDir();
    testDirs.push(home);
    process.env.LOTOR_HOME = home;

    // Pre-create the store so the chain signing keypair exists BEFORE the
    // children start. Key generation is a separate race, out of scope here.
    const parentStore = createStore(home);

    const dir = createTempTestDir();
    testDirs.push(dir);
    const scriptPath = writeIngestScript(dir);

    const transcriptFile = path.join(dir, 'shared.jsonl');
    fs.writeFileSync(transcriptFile, transcript('sess-race', 4));

    const N = 4;
    const startAt = Date.now() + 2000;

    const running = [];
    for (let i = 0; i < N; i++) {
      running.push(spawnIngest(scriptPath, home, transcriptFile, startAt));
    }
    const results = await Promise.all(running);
    for (const r of results) {
      assert.strictEqual(r.code, 0, `ingest child failed: ${r.stderr}`);
    }

    const chain = loadChain(home);
    const sessionReceipts = chain.filter(e => e.payload?.session?.id === 'sess-race');
    assert.strictEqual(
      sessionReceipts.length,
      1,
      `expected exactly 1 receipt for the racing session, got ${sessionReceipts.length}`
    );

    const publicKey = crypto.createPublicKey(parentStore.keyPair.publicKey);
    const verifyResult = verifyChain(chain, publicKey);
    assert.strictEqual(verifyResult.ok, true, `chain should verify: ${verifyResult.reason || ''}`);
  });
});
