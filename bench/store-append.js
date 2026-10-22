#!/usr/bin/env node
/**
 * bench/store-append.js
 *
 * Per-append cost of the receipt store against chain length.
 *
 * Not part of `npm test` (node --test only collects files under test/ and
 * *.test.js). Run it by hand:
 *
 *     node bench/store-append.js            # sizes 0, 10000, 40000
 *     node bench/store-append.js 0 1000     # custom sizes
 *
 * It measures whichever store module is LIVE at src/store/index.js. Before the
 * tail-append candidate lands, that is main's module, so a plain run gives the
 * "before" numbers. The "after" numbers come from the same bench run against
 * the candidate through the test-only module hook:
 *
 *     NODE_OPTIONS="--import=file:///<repo>/proposals/store-tail-append/run-against-candidate.mjs" node bench/store-append.js
 *
 * Every step is measured in-process, the way a hook that already exists pays
 * it (node start-up excluded), in the two shapes the code base uses:
 *
 *   hook-step    createStore(home) + appendReceiptGuarded(build, { withChain: false })
 *                (the V3-04 reasoning-step shape: one fresh store per tool call,
 *                payload built inside the lock, the chain itself not consulted)
 *   append-only  appendReceipt(payload) on one long-lived store
 *
 * The synthetic chain is written with the real chain code (createChain), so it
 * is a valid signed chain of ~1.1 KB entries, like the live one.
 *
 * Scratch homes go under os.tmpdir() and are removed afterwards. The real
 * Lotor home is never touched.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { createStore, loadOrCreateKeyPair } from '../src/store/index.js';
import { createChain } from '../src/chain/index.js';

const STEPS = 40;
const sizes = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
const SIZES = sizes.length ? sizes : [0, 10000, 40000];

/** A payload of roughly the size of a live reasoning-step receipt. */
function payloadFor(i) {
  return {
    type: 'bench-step',
    session: { id: 'bench-session', model: 'bench' },
    step: i,
    digests: Array.from({ length: 12 }, (_, k) =>
      (`${i}-${k}-`.padEnd(64, 'a')).slice(0, 64))
  };
}

function seedChain(home, n) {
  const keyPair = loadOrCreateKeyPair(home);
  const receiptsDir = path.join(home, 'receipts');
  fs.mkdirSync(receiptsDir, { recursive: true });
  const chainFile = path.join(receiptsDir, 'chain.jsonl');
  const chain = createChain(keyPair, 0, []);
  const fd = fs.openSync(chainFile, 'w', 0o600);
  try {
    let buf = [];
    for (let i = 0; i < n; i++) {
      const entry = chain.append(payloadFor(i));
      buf.push(JSON.stringify(entry) + '\n');
      // Do not keep 40k entries in memory twice.
      chain.entries.length = 0;
      chain.entries.push(entry);
      if (buf.length >= 1000) {
        fs.writeSync(fd, buf.join(''));
        buf = [];
      }
    }
    if (buf.length) fs.writeSync(fd, buf.join(''));
  } finally {
    fs.closeSync(fd);
  }
  return fs.statSync(chainFile).size;
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const pick = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { median: pick(0.5), p95: pick(0.95), max: s[s.length - 1] };
}

const fmt = (ms) => `${ms.toFixed(2)} ms`;

const rows = [];
for (const n of SIZES) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-bench-'));
  try {
    const bytes = seedChain(home, n);

    // Shape 1: fresh store per step, guarded append that does not read the chain.
    const hook = [];
    for (let i = 0; i < STEPS; i++) {
      const t0 = performance.now();
      const store = createStore(home);
      store.appendReceiptGuarded(() => payloadFor(n + i), { withChain: false });
      hook.push(performance.now() - t0);
    }

    // Shape 2: one long-lived store, plain appendReceipt.
    const store = createStore(home);
    const plain = [];
    for (let i = 0; i < STEPS; i++) {
      const t0 = performance.now();
      store.appendReceipt(payloadFor(n + STEPS + i));
      plain.push(performance.now() - t0);
    }

    rows.push({ n, bytes, hook: stats(hook), plain: stats(plain) });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log(`node ${process.version}, ${os.platform()} ${os.arch()}, ${STEPS} steps per size`);
console.log('');
console.log('| chain entries | chain size | hook-step median | hook-step p95 | append-only median | append-only p95 |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(
    `| ${r.n.toLocaleString('en-US')} | ${(r.bytes / 1048576).toFixed(1)} MB | ` +
    `${fmt(r.hook.median)} | ${fmt(r.hook.p95)} | ${fmt(r.plain.median)} | ${fmt(r.plain.p95)} |`
  );
}
