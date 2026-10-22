/**
 * test/store-tail-append.test.js
 *
 * Tail-only append for the receipt store.
 *
 * Before this change every append re-read and re-parsed the WHOLE chain file:
 * once in createStore() (to build store.entries) and once more under the lock
 * in appendReceipt()/appendReceiptGuarded() (to find the previous hash and the
 * next seq). Per-append cost therefore grew with chain length (eval E5:
 * ~6 ms at 0 entries, ~93 ms median at 30k).
 *
 * After it, an append on a well-formed chain reads only the end of the file to
 * find the previous entry, and store.entries is loaded on first access instead
 * of at construction. Anything that is not a well-formed tail (torn last line,
 * no trailing newline, an unparseable or non-entry last line) falls back to the
 * old full-read path, so the bytes written are the same as before in every
 * case. The fidelity tests below check that byte for byte against a reference
 * implementation of the old append path.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as storeMod from '../src/store/index.js';
import { createChain, verifyChain, GENESIS_PREV_HASH } from '../src/chain/index.js';
import { withLock } from '../src/store/lock.js';

const { createStore, loadChain, appendEntry, loadOrCreateKeyPair } = storeMod;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The store change itself is core (src/store) and lands under signature at a
 * signing sitting: the candidate is proposals/store-tail-append/index.js.
 * Until it lands, the tests that need it run as `todo` (they still run and
 * report; a failure does not fail the suite). After landing, set this to {}
 * so they become ordinary tests.
 *
 * To run the whole suite against the candidate before landing:
 *   NODE_OPTIONS="--import=file:///<repo>/proposals/store-tail-append/run-against-candidate.mjs" npm test
 */
const PENDING_LANDING = { todo: 'needs proposals/store-tail-append landed in src/store (signing sitting)' };

let tempDirs = [];
function tempHome(prefix = 'lotor-tail-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function chainFileOf(home) {
  return path.join(home, 'receipts', 'chain.jsonl');
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

/**
 * The append path exactly as it was before this change (appendReceipt body,
 * minus the in-memory sync): full read under the lock, seq = count of
 * parseable lines, prevHash = last parseable entry's hash.
 */
function oldAppend(home, keyPair, payload) {
  return withLock(home, () => {
    const current = loadChain(home);
    const fresh = createChain(keyPair, current.length, current);
    const entry = fresh.append(payload);
    appendEntry(entry, home);
    return entry;
  });
}

/**
 * Make Date.now and crypto.randomBytes deterministic so two runs of the same
 * append sequence produce the same entries. Signatures are Ed25519, which is
 * deterministic, so equal inputs give equal bytes.
 *
 * Date.now is a fixed value that the caller advances between appends (the lock
 * code also calls Date.now, so a per-call counter would depend on how often
 * the lock is touched rather than on the chain).
 */
const T0 = Date.now();
function withDeterminism(fn) {
  const realNow = Date.now;
  const realRandomBytes = crypto.randomBytes;
  let now = T0;
  let counter = 0;
  Date.now = () => now;
  crypto.randomBytes = (n) => {
    const b = Buffer.alloc(n);
    b.writeUInt32BE(counter++ >>> 0, 0);
    return b;
  };
  try {
    return fn({ tick: () => { now += 1000; } });
  } finally {
    Date.now = realNow;
    crypto.randomBytes = realRandomBytes;
  }
}

/** Seed a chain of n valid entries using the real chain code. */
function seedEntries(keyPair, n, tag = 'seed') {
  const chain = createChain(keyPair, 0, []);
  const out = [];
  for (let i = 0; i < n; i++) out.push(chain.append({ tag, i }));
  return out;
}

function linesOf(entries, eol = '\n') {
  return entries.map((e) => JSON.stringify(e) + eol).join('');
}

/** Two homes sharing one keypair. */
function twinHomes() {
  const a = tempHome('lotor-tail-a-');
  const b = tempHome('lotor-tail-b-');
  const keyPair = loadOrCreateKeyPair(a);
  fs.mkdirSync(path.join(b, 'keys'), { recursive: true });
  for (const f of ['chain.pub', 'chain.key']) {
    fs.copyFileSync(path.join(a, 'keys', f), path.join(b, 'keys', f));
  }
  fs.mkdirSync(path.join(a, 'receipts'), { recursive: true });
  fs.mkdirSync(path.join(b, 'receipts'), { recursive: true });
  return { a, b, keyPair };
}

/**
 * Starting-file scenarios. Each returns the exact bytes to seed the chain
 * file with, or null for "no chain file".
 */
function scenarios(keyPair) {
  const five = seedEntries(keyPair, 5);
  const clean = linesOf(five);
  const sixth = JSON.stringify(createChain(keyPair, 5, five).append({ tag: 'torn' }));
  const two = seedEntries(keyPair, 2, 'mid');
  return {
    'no chain file': null,
    'empty file': '',
    'whitespace-only file': '\n\r\n  \n',
    'clean chain': clean,
    'clean chain + trailing blank lines': clean + '\n\n',
    'CRLF chain': linesOf(five, '\r\n'),
    'torn last line (crash mid-write)': clean + sixth.slice(0, 57),
    'last line complete but no trailing newline': clean.slice(0, -1),
    'unparseable last line, newline-terminated': clean + 'garbage\n',
    'last line is JSON but not an entry': clean + '{"hello":"world"}\n',
    'corrupt line in the middle': linesOf(two) + 'garbage\n'
  };
}

// --------------------------------------------------------------------------

describe('store tail-only append: fidelity with the old full-read path', () => {
  const sc = scenarios(loadOrCreateKeyPair(tempHome('lotor-tail-keys-')));
  for (const name of Object.keys(sc)) {
    it(`writes byte-identical chains: ${name}`, () => {
      const { a, b, keyPair } = twinHomes();
      // Re-derive the scenario under THIS keypair so signatures are valid.
      const seed = scenarios(keyPair)[name];
      if (seed !== null) {
        fs.writeFileSync(chainFileOf(a), seed);
        fs.writeFileSync(chainFileOf(b), seed);
      }

      const K = 6;
      const payloads = Array.from({ length: K }, (_, i) => ({
        session: { id: `fid-${i}`, model: 'fidelity' },
        nested: { z: 1, a: [i, { y: 2, b: 3 }] }
      }));

      const oldEntries = withDeterminism(({ tick }) =>
        payloads.map((p) => { const e = oldAppend(a, keyPair, p); tick(); return e; }));

      const newEntries = withDeterminism(({ tick }) => {
        const store = createStore(b);
        return payloads.map((p, i) => {
          // Alternate the two append entry points.
          const e = i % 2 === 0
            ? store.appendReceipt(p)
            : store.appendReceiptGuarded(() => p, { withChain: false });
          tick();
          return e;
        });
      });

      assert.deepStrictEqual(newEntries, oldEntries, 'returned entries differ');
      const bytesA = fs.readFileSync(chainFileOf(a));
      const bytesB = fs.readFileSync(chainFileOf(b));
      assert.ok(bytesA.equals(bytesB), `chain bytes differ for scenario "${name}"`);

      const pub = crypto.createPublicKey(keyPair.publicKey);
      assert.deepStrictEqual(
        verifyChain(loadChain(b), pub),
        verifyChain(loadChain(a), pub),
        'verifier verdicts differ'
      );
    });
  }

  it('a long clean sequence verifies and matches the old path byte for byte', () => {
    const { a, b, keyPair } = twinHomes();
    const N = 300;
    withDeterminism(({ tick }) => {
      for (let i = 0; i < N; i++) { oldAppend(a, keyPair, { i }); tick(); }
    });
    withDeterminism(({ tick }) => {
      // A fresh store per append, like a hook process.
      for (let i = 0; i < N; i++) { createStore(b).appendReceipt({ i }); tick(); }
    });
    assert.ok(fs.readFileSync(chainFileOf(a)).equals(fs.readFileSync(chainFileOf(b))));
    const pub = crypto.createPublicKey(keyPair.publicKey);
    assert.deepStrictEqual(verifyChain(loadChain(b), pub), { ok: true });
  });
});

describe('store tail-only append: reading the tail', () => {
  const readChainTail = (home) => {
    assert.strictEqual(typeof storeMod.readChainTail, 'function', 'readChainTail is not exported');
    return storeMod.readChainTail(home);
  };

  function homeWith(bytes) {
    const home = tempHome();
    fs.mkdirSync(path.join(home, 'receipts'), { recursive: true });
    if (bytes !== null) fs.writeFileSync(chainFileOf(home), bytes);
    return home;
  }

  it('reports empty for a missing, empty, or whitespace-only file', PENDING_LANDING, () => {
    assert.deepStrictEqual(readChainTail(homeWith(null)), { status: 'empty' });
    assert.deepStrictEqual(readChainTail(homeWith('')), { status: 'empty' });
    assert.deepStrictEqual(readChainTail(homeWith('\n \r\n\t\n')), { status: 'empty' });
  });

  it('returns the last entry of a clean chain, with or without trailing blank lines, LF or CRLF', PENDING_LANDING, () => {
    const keyPair = loadOrCreateKeyPair(tempHome());
    const es = seedEntries(keyPair, 4);
    for (const bytes of [linesOf(es), linesOf(es) + '\n\n', linesOf(es, '\r\n'), linesOf(es, '\r\n') + '\r\n']) {
      const r = readChainTail(homeWith(bytes));
      assert.strictEqual(r.status, 'ok');
      assert.deepStrictEqual(r.tail, es[3]);
    }
  });

  it('finds a last line larger than the read chunk', PENDING_LANDING, () => {
    const keyPair = loadOrCreateKeyPair(tempHome());
    const chain = createChain(keyPair, 0, []);
    chain.append({ small: true });
    const big = chain.append({ blob: 'x'.repeat(300 * 1024) });
    const r = readChainTail(homeWith(linesOf(chain.entries)));
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.tail.hash, big.hash);
  });

  it('handles a single-entry file and multi-byte UTF-8 in the tail', PENDING_LANDING, () => {
    const keyPair = loadOrCreateKeyPair(tempHome());
    const chain = createChain(keyPair, 0, []);
    const e = chain.append({ note: 'grüße \u{1F531} 中文' });
    const r = readChainTail(homeWith(linesOf([e])));
    assert.strictEqual(r.status, 'ok');
    assert.deepStrictEqual(r.tail, e);
  });

  it('never treats a torn last line as the tail', PENDING_LANDING, () => {
    const keyPair = loadOrCreateKeyPair(tempHome());
    const es = seedEntries(keyPair, 3);
    const torn = JSON.stringify(createChain(keyPair, 3, es).append({ t: 1 }));
    // Every proper prefix of the next line, including one that happens to be
    // valid JSON-ish up to a brace, must be reported as an anomaly.
    for (const cut of [1, 10, Math.floor(torn.length / 2), torn.length - 1, torn.length]) {
      const r = readChainTail(homeWith(linesOf(es) + torn.slice(0, cut)));
      assert.strictEqual(r.status, 'anomaly', `cut ${cut} was not flagged`);
    }
  });

  it('flags non-entry and unparseable last lines as anomalies', PENDING_LANDING, () => {
    const keyPair = loadOrCreateKeyPair(tempHome());
    const es = seedEntries(keyPair, 2);
    for (const tailLine of ['garbage', '{"hello":"world"}', 'null', '0', '{"seq":"1","hash":"x"}',
      JSON.stringify({ ...es[1], seq: -1 }), JSON.stringify({ ...es[1], hash: 'abc' })]) {
      const r = readChainTail(homeWith(linesOf(es) + tailLine + '\n'));
      assert.strictEqual(r.status, 'anomaly', `"${tailLine.slice(0, 30)}" was not flagged`);
    }
  });
});

describe('store tail-only append: torn tail behaves exactly as it did before', () => {
  it('links to the last good entry, not to the torn bytes', () => {
    const home = tempHome();
    const keyPair = loadOrCreateKeyPair(home);
    const es = seedEntries(keyPair, 3);
    const torn = JSON.stringify(createChain(keyPair, 3, es).append({ t: 1 })).slice(0, 80);
    fs.mkdirSync(path.join(home, 'receipts'), { recursive: true });
    fs.writeFileSync(chainFileOf(home), linesOf(es) + torn);

    const entry = createStore(home).appendReceipt({ after: 'crash' });
    assert.strictEqual(entry.seq, 3);
    assert.strictEqual(entry.prevHash, es[2].hash);

    // Pre-existing behaviour, preserved deliberately (this PR does not change
    // chain semantics): appendFileSync writes straight after the torn bytes,
    // so the new entry is glued onto the torn line and that line stays
    // unparseable. loadChain skips it. If the store is ever changed to start
    // a fresh line after a torn tail, update this assertion on purpose.
    const raw = fs.readFileSync(chainFileOf(home), 'utf-8');
    assert.ok(raw.endsWith(torn + JSON.stringify(entry) + '\n'));
    assert.strictEqual(loadChain(home).length, 3);

    // The next append is on a newline-terminated but unparseable tail: it
    // falls back to the full read and lands as seq 3 again, linked to es[2],
    // exactly like the old path. The chain as loadChain sees it verifies.
    const next = createStore(home).appendReceipt({ after: 'crash-2' });
    assert.strictEqual(next.seq, 3);
    assert.strictEqual(next.prevHash, es[2].hash);
    const pub = crypto.createPublicKey(keyPair.publicKey);
    assert.deepStrictEqual(verifyChain(loadChain(home), pub), { ok: true });

    // And from there on the fast path resumes.
    const third = createStore(home).appendReceipt({ after: 'crash-3' });
    assert.strictEqual(third.seq, 4);
    assert.strictEqual(third.prevHash, next.hash);
  });
});

describe('store tail-only append: cost does not depend on chain length', () => {
  /**
   * Instrument fs for the duration of fn: record every readFileSync of the
   * chain file and every byte returned by readSync. Structural, not timing
   * based, so it cannot flake on a slow CI box.
   */
  function instrumentReads(chainFile, fn) {
    const realReadFileSync = fs.readFileSync;
    const realReadSync = fs.readSync;
    const fullReads = [];
    let bytesViaReadSync = 0;
    fs.readFileSync = function (p, ...rest) {
      if (typeof p === 'string' && path.resolve(p) === path.resolve(chainFile)) fullReads.push(p);
      return realReadFileSync.call(this, p, ...rest);
    };
    fs.readSync = function (...args) {
      const n = realReadSync.apply(this, args);
      bytesViaReadSync += n;
      return n;
    };
    try {
      fn();
    } finally {
      fs.readFileSync = realReadFileSync;
      fs.readSync = realReadSync;
    }
    return { fullReads, bytesViaReadSync };
  }

  function bigHome(n) {
    const home = tempHome();
    const keyPair = loadOrCreateKeyPair(home);
    fs.mkdirSync(path.join(home, 'receipts'), { recursive: true });
    const es = seedEntries(keyPair, n, 'x'.repeat(400));
    fs.writeFileSync(chainFileOf(home), linesOf(es));
    return { home, es };
  }

  it('createStore does not read the chain until entries is used', PENDING_LANDING, () => {
    const { home, es } = bigHome(2000);
    let store;
    const r = instrumentReads(chainFileOf(home), () => { store = createStore(home); });
    assert.deepStrictEqual(r.fullReads, [], 'createStore read the whole chain');
    // ...and entries is still the full chain when someone asks for it.
    assert.strictEqual(store.entries.length, es.length);
    assert.strictEqual(store.entries[es.length - 1].hash, es[es.length - 1].hash);
  });

  it('appendReceipt reads only the tail of a clean chain', PENDING_LANDING, () => {
    const { home, es } = bigHome(2000);
    const size = fs.statSync(chainFileOf(home)).size;
    const store = createStore(home);
    let entry;
    const r = instrumentReads(chainFileOf(home), () => { entry = store.appendReceipt({ p: 1 }); });
    assert.deepStrictEqual(r.fullReads, [], 'append read the whole chain');
    assert.ok(r.bytesViaReadSync < 256 * 1024 && r.bytesViaReadSync < size / 4,
      `append read ${r.bytesViaReadSync} of ${size} bytes`);
    assert.strictEqual(entry.seq, es.length);
    assert.strictEqual(entry.prevHash, es[es.length - 1].hash);
  });

  it('createStore + appendReceiptGuarded(build, { withChain: false }) reads only the tail', PENDING_LANDING, () => {
    const { home, es } = bigHome(2000);
    let entry;
    let argCount = -1;
    const r = instrumentReads(chainFileOf(home), () => {
      entry = createStore(home).appendReceiptGuarded(function () {
        argCount = arguments.length;
        return { step: 1 };
      }, { withChain: false });
    });
    assert.deepStrictEqual(r.fullReads, [], 'hook-step shape read the whole chain');
    assert.strictEqual(argCount, 0, 'buildPayload should get no chain when withChain is false');
    assert.strictEqual(entry.seq, es.length);
    assert.strictEqual(entry.prevHash, es[es.length - 1].hash);
  });

  it('appendReceiptGuarded without the option still hands buildPayload the full chain', () => {
    const { home, es } = bigHome(50);
    let seen;
    const entry = createStore(home).appendReceiptGuarded((current) => {
      seen = current;
      return { step: 1 };
    });
    assert.strictEqual(seen.length, es.length);
    assert.strictEqual(seen[es.length - 1].hash, es[es.length - 1].hash);
    assert.strictEqual(entry.seq, es.length);
    assert.strictEqual(entry.prevHash, es[es.length - 1].hash);

    // A null payload still means "skip".
    const before = fs.statSync(chainFileOf(home)).size;
    assert.strictEqual(createStore(home).appendReceiptGuarded(() => null, { withChain: false }), null);
    assert.strictEqual(fs.statSync(chainFileOf(home)).size, before);
  });
});

describe('store tail-only append: store.entries stays consistent with disk', () => {
  it('a materialized entries array keeps its identity and gains the new entry', () => {
    const home = tempHome();
    const store = createStore(home);
    const arr = store.entries;
    const e1 = store.appendReceipt({ n: 1 });
    const e2 = store.appendReceiptGuarded(() => ({ n: 2 }), { withChain: false });
    assert.strictEqual(store.entries, arr, 'array identity changed');
    assert.deepStrictEqual(arr.map((e) => e.hash), [e1.hash, e2.hash]);
    assert.strictEqual(arr[1], e2, 'the appended entry object should be the one returned');
  });

  it('refreshes a materialized array to the full disk view after an out-of-band append', () => {
    const home = tempHome();
    const mine = createStore(home);
    const arr = mine.entries; // materialize while empty
    const other = createStore(home);
    const o1 = other.appendReceipt({ who: 'other', n: 1 });
    const o2 = other.appendReceipt({ who: 'other', n: 2 });
    const m = mine.appendReceipt({ who: 'mine' });
    assert.strictEqual(m.prevHash, o2.hash);
    assert.strictEqual(m.seq, 2);
    assert.strictEqual(mine.entries, arr);
    assert.deepStrictEqual(arr.map((e) => e.hash), [o1.hash, o2.hash, m.hash]);
    assert.deepStrictEqual(mine.verify(), { ok: true });
  });

  it('an unmaterialized store loads the full chain, including its own append, on first access', () => {
    const home = tempHome();
    createStore(home).appendReceipt({ n: 0 });
    const store = createStore(home);
    const e = store.appendReceipt({ n: 1 });
    assert.strictEqual(store.entries.length, 2);
    assert.strictEqual(store.entries[1].hash, e.hash);
    assert.deepStrictEqual(store.verify(), { ok: true });
  });

  it('reload() and verify() still see the whole chain', () => {
    const home = tempHome();
    const store = createStore(home);
    for (let i = 0; i < 5; i++) createStore(home).appendReceipt({ i });
    assert.strictEqual(store.reload().length, 5);
    assert.strictEqual(store.entries.length, 5);
    assert.deepStrictEqual(store.verify(), { ok: true });
  });

  it('createStore still creates receipts/ eagerly', () => {
    const home = tempHome();
    createStore(home);
    assert.ok(fs.existsSync(path.join(home, 'receipts')));
  });
});

describe('store tail-only append: two processes appending at once', () => {
  function writeLoopScript(dir) {
    const storeUrl = pathToFileURL(path.join(REPO_ROOT, 'src', 'store', 'index.js')).href;
    const script = `
import { createStore, loadChain } from ${JSON.stringify(storeUrl)};
const [home, id, startAtStr, countStr, mode] = process.argv.slice(2);
const startAt = Number(startAtStr);
const count = Number(countStr);
const view = new Int32Array(new SharedArrayBuffer(4));
for (;;) { const r = startAt - Date.now(); if (r <= 0) break; Atomics.wait(view, 0, 0, Math.min(r, 5)); }
const store = createStore(home);
if (mode === 'materialized') void store.entries.length;
for (let i = 0; i < count; i++) {
  if (mode === 'materialized') store.appendReceipt({ id, i });
  else createStore(home).appendReceiptGuarded(() => ({ id, i }), { withChain: false });
  // Leave the lock free for a moment so the other writer gets in between
  // appends (the lock retries every 25 ms; without a gap one writer can run
  // its whole loop before the other wakes, and nothing interleaves).
  Atomics.wait(view, 0, 0, 2 + Math.floor(Math.random() * 6));
}
const mem = mode === 'materialized' ? store.entries.map((e) => e.hash) : null;
process.stdout.write(JSON.stringify({ id, mem }));
`;
    const p = path.join(dir, 'append-loop.mjs');
    fs.writeFileSync(p, script, 'utf-8');
    return p;
  }

  function run(script, args) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('exit', (code) => resolve({ code, out, err }));
      child.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
    });
  }

  it('serializes interleaved appends and leaves a chain that verifies', { timeout: 120000 }, async () => {
    const home = tempHome('lotor-tail-conc-');
    const keyPair = loadOrCreateKeyPair(home);
    fs.mkdirSync(path.join(home, 'receipts'), { recursive: true });
    const PRE = 500;
    fs.writeFileSync(chainFileOf(home), linesOf(seedEntries(keyPair, PRE)));

    const scratch = tempHome('lotor-tail-script-');
    const script = writeLoopScript(scratch);
    const COUNT = 60;
    const startAt = Date.now() + 1500;
    const [a, b] = await Promise.all([
      run(script, [home, 'A', String(startAt), String(COUNT), 'materialized']),
      run(script, [home, 'B', String(startAt), String(COUNT), 'fresh-store'])
    ]);
    assert.strictEqual(a.code, 0, `A failed: ${a.err}`);
    assert.strictEqual(b.code, 0, `B failed: ${b.err}`);

    const entries = loadChain(home);
    assert.strictEqual(entries.length, PRE + 2 * COUNT);
    assert.deepStrictEqual(entries.map((e) => e.seq), Array.from({ length: entries.length }, (_, i) => i));
    const pub = crypto.createPublicKey(keyPair.publicKey);
    assert.deepStrictEqual(verifyChain(entries, pub), { ok: true });

    // Both writers really interleaved (otherwise this test proves nothing
    // about the lock). With a 1.5 s barrier this holds in practice; if it
    // ever does not, the assertion says so instead of passing vacuously.
    const ids = entries.slice(PRE).map((e) => e.payload.id).join('');
    assert.ok(/AB|BA/.test(ids) && ids.replace(/(.)\1*/g, '$1').length > 2,
      `appends did not interleave: ${ids}`);

    // Process A's in-memory view equals a prefix of the disk chain.
    const memA = JSON.parse(a.out).mem;
    assert.deepStrictEqual(memA, entries.slice(0, memA.length).map((e) => e.hash));
    assert.ok(memA.length >= PRE + COUNT);
    assert.strictEqual(entries[0].prevHash, GENESIS_PREV_HASH);
  });
});
