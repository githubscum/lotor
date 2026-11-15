/**
 * proposals/seal-cli/seal-cli.test.js
 *
 * WO-L86-01: proposals/seal-cli/seal.js — the checkpoint workflow outside the code. Seal,
 * hand the note to someone who is not the key holder, check the chain against
 * the note later, and verify the sealed chain from genesis.
 *
 * WO-L86-02 (round 2): `check` runs BOTH verifyIncremental against the kept
 * note (fork detection and the forward walk) AND verifySealed (the full walk
 * from genesis), and reports CONSISTENT only when both pass. A same-length
 * rewrite of an entry UNDER a kept checkpoint — the case a kept note exists to
 * catch — is therefore INCONSISTENT by default: verifyIncremental never re-reads
 * entries the note covers, but the full walk reads all of them. `check --fast`
 * keeps the round-1 incremental-only behaviour and prints exactly what it
 * skipped (KNOWN-LIMITS 85); the flag may sit before or after the note path.
 *
 * Each test runs the real CLI (child_process.spawnSync) against a fresh
 * LOTOR_HOME, so what is under test is what an operator types, not the store
 * API. Chains are built by importing createStore and appending receipts — the
 * same approach test/chain-checkpoints.test.js uses (appendReceipt through the
 * real store), not a guessed writer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStore } from '../../src/store/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-seal-cli-'));
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

function chainPath(home) {
  return path.join(home, 'receipts', 'chain.jsonl');
}

function sidecarPath(home) {
  return path.join(home, 'receipts', 'checkpoints.jsonl');
}

function runSeal(args, home) {
  return spawnSync(process.execPath, ['proposals/seal-cli/seal.js', ...args], {
    cwd: REPO,
    env: { ...process.env, LOTOR_HOME: home },
    encoding: 'utf8'
  });
}

/** Append n receipts through the real store — same approach as test/chain-checkpoints.test.js. */
function appendMany(store, n, tag = 'r') {
  for (let i = 0; i < n; i++) store.appendReceipt({ type: 'test', tag, i });
}

function readSidecar(home) {
  if (!fs.existsSync(sidecarPath(home))) return [];
  return fs.readFileSync(sidecarPath(home), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Seal at the head through the CLI and keep the note, as the operator would. */
function sealAtHead(home, notePath) {
  const r = runSeal(['seal', '--at-head', '--out', notePath], home);
  assert.equal(r.status, 0, `setup seal failed: ${r.stderr}`);
  return r;
}

describe('proposals/seal-cli/seal.js (WO-L86-01)', () => {
  it('case 1: a usage error exits 1 with usage on stderr', () => {
    const home = tmpHome();
    try {
      const bad = runSeal(['frobnicate'], home);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /usage:/);

      const none = runSeal([], home);
      assert.equal(none.status, 1);
      assert.match(none.stderr, /usage:/);
    } finally {
      cleanup(home);
    }
  });

  it('case 2: seal without --at-head on a 5-entry chain seals nothing (exit 0)', () => {
    const home = tmpHome();
    try {
      const store = createStore(home);
      appendMany(store, 5);

      const r = runSeal(['seal'], home);
      assert.equal(r.status, 0);
      assert.ok(r.stdout.includes('nothing sealed'), r.stdout);
      assert.ok(r.stdout.includes('pass --at-head to seal the head now'), r.stdout);
      // The segment size is 1024, so 5 entries never become a checkpoint.
      assert.deepEqual(readSidecar(home), []);
      // The honest line is printed unconditionally on the seal path.
      assert.ok(r.stdout.includes('A kept note catches a later rewrite only if the holder is not the key holder'), r.stdout);
    } finally {
      cleanup(home);
    }
  });

  it('case 3: seal --at-head --out writes a non-empty note file and one size-5 sidecar record', () => {
    const home = tmpHome();
    try {
      const store = createStore(home);
      appendMany(store, 5);

      const notePath = path.join(home, 'note.txt');
      const r = sealAtHead(home, notePath);
      assert.ok(r.stdout.includes('sealed 1 new checkpoint(s); newest covers 5 entries'), r.stdout);

      const recs = readSidecar(home);
      assert.equal(recs.length, 1);
      assert.equal(recs[0].size, 5);

      const note = fs.readFileSync(notePath, 'utf8');
      assert.ok(note.length > 0);
      assert.ok(note.endsWith('\n'), 'the note format ends with a newline');
      assert.equal(note, recs[0].note, 'the note file is the signed note text, byte for byte');
      assert.ok(r.stdout.includes('KNOWN-LIMITS 84'), r.stdout);
    } finally {
      cleanup(home);
    }
  });

  it('case 4: check of the kept note stays CONSISTENT while the chain grows forward', () => {
    const home = tmpHome();
    try {
      const store = createStore(home);
      appendMany(store, 5);
      const notePath = path.join(home, 'note.txt');
      sealAtHead(home, notePath);

      appendMany(store, 3);
      const r = runSeal(['check', notePath], home);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /CONSISTENT  chain still contains the checkpoint you kept \(size 5\), verifies forward to 8 entries, and every entry from genesis verifies/);
    } finally {
      cleanup(home);
    }
  });

  it("case 5: a one-byte tamper of a field inside the first five lines is INCONSISTENT (exit 2)", () => {
    const home = tmpHome();
    try {
      const store = createStore(home);
      appendMany(store, 5);
      const notePath = path.join(home, 'note.txt');
      sealAtHead(home, notePath);

      // One byte of a string value inside the covered prefix is gone. The kept
      // note's record certified that entries 0..4 end at a byte offset; one
      // byte less and the certified extent fails closed.
      const lines = fs.readFileSync(chainPath(home), 'utf8').split('\n');
      assert.ok(lines[2].includes('"type":"test"'), lines[2]);
      lines[2] = lines[2].replace('"type":"test"', '"type":"tet"');
      fs.writeFileSync(chainPath(home), lines.join('\n'));

      const r = runSeal(['check', notePath], home);
      assert.equal(r.status, 2);
      assert.match(r.stdout, /INCONSISTENT/);
      assert.match(r.stdout, /truncated/, `the certified byte extent is what caught it: ${r.stdout}`);
    } finally {
      cleanup(home);
    }
  });

  it('case 5 companion, flipped (WO-L86-02): a same-length rewrite UNDER the kept checkpoint is INCONSISTENT from check', () => {
    const home = tmpHome();
    try {
      const store = createStore(home);
      appendMany(store, 5);
      const notePath = path.join(home, 'note.txt');
      sealAtHead(home, notePath);

      // Same-length substitution inside the covered prefix: verifyIncremental
      // never reads entries 0..4 from the kept checkpoint, so incremental
      // alone would pass — but check also runs the full walk from genesis,
      // which reads all of them, and CONSISTENT requires both. This is the
      // case a kept note exists to catch.
      const lines = fs.readFileSync(chainPath(home), 'utf8').split('\n');
      assert.ok(lines[2].includes('"tag":"r"'), lines[2]);
      lines[2] = lines[2].replace('"tag":"r"', '"tag":"R"');
      fs.writeFileSync(chainPath(home), lines.join('\n'));

      const r = runSeal(['check', notePath], home);
      assert.equal(r.status, 2);
      assert.match(r.stdout, /INCONSISTENT/);
      assert.match(r.stdout, /hash mismatch at entry 2/, `the full walk is what caught it: ${r.stdout}`);
    } finally {
      cleanup(home);
    }
  });

  it('case 5 companion (WO-L86-02): check --fast keeps the incremental-only behaviour on that same tamper', () => {
    const home = tmpHome();
    try {
      const store = createStore(home);
      appendMany(store, 5);
      const notePath = path.join(home, 'note.txt');
      sealAtHead(home, notePath);

      const lines = fs.readFileSync(chainPath(home), 'utf8').split('\n');
      assert.ok(lines[2].includes('"tag":"r"'), lines[2]);
      lines[2] = lines[2].replace('"tag":"r"', '"tag":"R"');
      fs.writeFileSync(chainPath(home), lines.join('\n'));

      // --fast before the path: incremental-only, so the covered rewrite stays
      // unseen — and the output says so.
      const r = runSeal(['check', '--fast', notePath], home);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /CONSISTENT/);
      assert.match(r.stdout, /--fast skipped the full walk: a same-length rewrite of entries the note covers is not checked \(KNOWN-LIMITS 85\)\./, r.stdout);
    } finally {
      cleanup(home);
    }
  });

  it('case 5 companion (WO-L86-02): check <note> --fast (flag after the path) behaves identically', () => {
    const home = tmpHome();
    try {
      const store = createStore(home);
      appendMany(store, 5);
      const notePath = path.join(home, 'note.txt');
      sealAtHead(home, notePath);

      const lines = fs.readFileSync(chainPath(home), 'utf8').split('\n');
      assert.ok(lines[2].includes('"tag":"r"'), lines[2]);
      lines[2] = lines[2].replace('"tag":"r"', '"tag":"R"');
      fs.writeFileSync(chainPath(home), lines.join('\n'));

      const r = runSeal(['check', notePath, '--fast'], home);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /CONSISTENT/);
      assert.match(r.stdout, /--fast skipped the full walk: a same-length rewrite of entries the note covers is not checked \(KNOWN-LIMITS 85\)\./, r.stdout);
    } finally {
      cleanup(home);
    }
  });

  it('case 5 companion (WO-L86-02): check with an unknown extra argument is a usage error (exit 1)', () => {
    const home = tmpHome();
    try {
      const store = createStore(home);
      appendMany(store, 5);
      const notePath = path.join(home, 'note.txt');
      sealAtHead(home, notePath);

      const r = runSeal(['check', notePath, '--bogus'], home);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /usage:/);
    } finally {
      cleanup(home);
    }
  });

  it('case 5 companion: a same-length rewrite the note does NOT cover is caught by the forward walk', () => {
    const home = tmpHome();
    try {
      const store = createStore(home);
      appendMany(store, 5);
      const notePath = path.join(home, 'note.txt');
      sealAtHead(home, notePath);

      appendMany(store, 3);
      // Entry 5 is the first entry after the kept checkpoint: the walk reads
      // it, and this one-byte substitution breaks its hash.
      const lines = fs.readFileSync(chainPath(home), 'utf8').split('\n');
      assert.ok(lines[5].includes('"tag":"r"'), lines[5]);
      lines[5] = lines[5].replace('"tag":"r"', '"tag":"R"');
      fs.writeFileSync(chainPath(home), lines.join('\n'));

      const r = runSeal(['check', notePath], home);
      assert.equal(r.status, 2);
      assert.match(r.stdout, /INCONSISTENT/);
    } finally {
      cleanup(home);
    }
  });

  it('case 6: a note from another chain under the same key is a fork (exit 2)', () => {
    const homeA = tmpHome();
    const homeB = tmpHome();
    try {
      const storeA = createStore(homeA);
      appendMany(storeA, 5, 'a');
      const noteA = path.join(homeA, 'note.txt');
      sealAtHead(homeA, noteA);

      // Home B: same key (copied keys dir), a DIFFERENT 5-entry chain, sealed
      // at the head. Same size, same signature, different root.
      fs.cpSync(path.join(homeA, 'keys'), path.join(homeB, 'keys'), { recursive: true });
      const storeB = createStore(homeB);
      appendMany(storeB, 5, 'b');
      assert.equal(runSeal(['seal', '--at-head'], homeB).status, 0);

      const r = runSeal(['check', noteA], homeB);
      assert.equal(r.status, 2);
      assert.match(r.stdout, /INCONSISTENT/);
      assert.match(r.stdout, /fork|does not/, r.stdout);
    } finally {
      cleanup(homeA);
      cleanup(homeB);
    }
  });

  it('case 7: verify on a good sealed chain is VALID (exit 0)', () => {
    const home = tmpHome();
    try {
      const store = createStore(home);
      appendMany(store, 5);
      sealAtHead(home, path.join(home, 'note.txt'));

      const r = runSeal(['verify'], home);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /VALID  5 entries, 1 checkpoint\(s\), all from genesis/);
    } finally {
      cleanup(home);
    }
  });
});
