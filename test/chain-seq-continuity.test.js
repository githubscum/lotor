/**
 * test/chain-seq-continuity.test.js
 *
 * Work order WO-SEQ-CONTINUITY: verifyChain checks hash recomputation, the
 * signature, the genesis prevHash and prevHash linkage, but never `seq` — so a
 * writer that signs an entry with a wrong seq (skip, duplicate, non-integer)
 * verifies { ok: true } while its numbering is wrong.
 *
 * STAGED, NOT YET LANDED. The fix is core (src/chain/), so it lands only at
 * the owner's signing sitting, as a patch: proposals/
 * verifychain-seq-continuity.patch. Until it is applied, the seq-specific
 * cases in the FIRST describe fail and are reported as TODO (same shape as the
 * WIRED flag in test/hook-post-tool-use-toolio.test.js); the patch's own
 * reason string, checked against the live module's text, is the landing
 * tripwire that flips them into ordinary tests.
 *
 * The SECOND describe runs the same cases against the QUEUED PATCH, not todo:
 * in a temp dir it copies today's source, applies the patch with git apply,
 * imports the patched module and runs all six cases against it. That proves
 * the patch applies cleanly to today's source, that it adds nothing but those
 * eleven lines, and that the checks fire once it lands.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createChain, verifyChain, generateKeyPair } from '../src/chain/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVE_MODULE = path.join(__dirname, '..', 'src', 'chain', 'index.js');
const PATCH_PATH = path.join(__dirname, '..', 'proposals', 'verifychain-seq-continuity.patch');

// Landing tripwire: read the live core module's text (READ ONLY — src/ is
// protected core, this file never writes there) and look for the staged
// check's own reason string.
const sourceText = fs.readFileSync(LIVE_MODULE, 'utf8');
const LANDED = sourceText.includes('seq discontinuity');
const TODO_MSG = 'lands with proposals/verifychain-seq-continuity.patch at the signing sitting';

const newlineCount = (text) => (text.match(/\n/g) || []).length;

/**
 * The six cases, as a helper so they can run against two implementations of
 * the chain module: the live one, and the temp-dir copy with the staged patch
 * applied to it. `verify` is read at run time (inside each fn), not at list
 * build time, so the queued-patch block can pass an object whose fields are
 * getters bound to the module it imports only after the before() hook.
 *
 * Cases (b)-(e) hold only once the seq check exists; the live block marks
 * them todo while the patch is un-landed. Cases (a) and (f) hold today — (a)
 * is the happy path, (f) is precedence proof that the existing checks run
 * first — so they are never todo.
 *
 * Returns an array of { name, isSeqCase, fn }.
 */
function cases(verify) {
  return [
    {
      name: '(a) a normal 4-entry chain from createChain(kp) verifies { ok: true }',
      isSeqCase: false,
      fn() {
        const { createChain, verifyChain } = verify;
        const kp = generateKeyPair();
        const chain = createChain(kp);
        chain.append({ action: 'first' });
        chain.append({ action: 'second' });
        chain.append({ action: 'third' });
        chain.append({ action: 'fourth' });
        const result = verifyChain(chain.entries, kp.publicKey);
        assert.deepStrictEqual(result, { ok: true });
      }
    },
    {
      name: '(b) SKIP: an entry carrying seq 3 at index 2 is a seq discontinuity',
      isSeqCase: true,
      fn() {
        const { createChain, verifyChain } = verify;
        const kp = generateKeyPair();
        const chain = createChain(kp);
        chain.append({ action: 'first' });
        chain.append({ action: 'second' });
        // Resume as if the writer had skipped seq 2: the appended entry is
        // index 2 but carries seq 3.
        const resumed = createChain(kp, 3, chain.entries);
        resumed.append({ action: 'third' });
        assert.strictEqual(resumed.entries.length, 3);
        assert.strictEqual(resumed.entries[2].seq, 3, 'precondition: the entry is signed with the wrong seq');
        const result = verifyChain(resumed.entries, kp.publicKey);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.brokenAt, 2);
        assert.match(result.reason, /seq discontinuity at entry 2: expected 2, got 3/);
      }
    },
    {
      name: '(c) DUPLICATE: an entry re-using seq 1 at index 2 is a seq discontinuity',
      isSeqCase: true,
      fn() {
        const { createChain, verifyChain } = verify;
        const kp = generateKeyPair();
        const chain = createChain(kp);
        chain.append({ action: 'first' });
        chain.append({ action: 'second' });
        const resumed = createChain(kp, 1, chain.entries);
        resumed.append({ action: 'third' });
        assert.strictEqual(resumed.entries[2].seq, 1, 'precondition: the entry re-uses seq 1');
        const result = verifyChain(resumed.entries, kp.publicKey);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.brokenAt, 2);
        assert.match(result.reason, /seq discontinuity at entry 2: expected 2, got 1/);
      }
    },
    {
      name: "(d) NON-INTEGER: a genesis entry whose seq is the string '0' is a seq discontinuity",
      isSeqCase: true,
      fn() {
        const { createChain, verifyChain } = verify;
        const kp = generateKeyPair();
        // computeHash is not exported, so build the bad entry with the module's
        // own writer: startSeq '0' yields a genesis entry whose seq is a string.
        const chain = createChain(kp, '0');
        chain.append({ action: 'first' });
        assert.strictEqual(typeof chain.entries[0].seq, 'string', 'precondition: the genesis seq is a string');
        const result = verifyChain(chain.entries, kp.publicKey);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.brokenAt, 0);
        assert.match(result.reason, /seq discontinuity at entry 0: expected 0, got "0"/);
      }
    },
    {
      name: '(e) GENESIS OFFSET: a fresh chain whose first entry carries seq 5 is a seq discontinuity',
      isSeqCase: true,
      fn() {
        const { createChain, verifyChain } = verify;
        const kp = generateKeyPair();
        const chain = createChain(kp, 5);
        chain.append({ action: 'first' });
        const result = verifyChain(chain.entries, kp.publicKey);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.brokenAt, 0);
        assert.match(result.reason, /seq discontinuity at entry 0: expected 0, got 5/);
      }
    },
    {
      name: "(f) PRECEDENCE: a tampered payload in a skip chain reports the hash mismatch, not seq",
      isSeqCase: false,
      fn() {
        const { createChain, verifyChain } = verify;
        const kp = generateKeyPair();
        const chain = createChain(kp);
        chain.append({ action: 'first' });
        chain.append({ action: 'second' });
        const resumed = createChain(kp, 3, chain.entries);
        const signed = resumed.append({ action: 'third' });
        signed.payload = { action: 'TAMPERED' };
        const result = verifyChain(resumed.entries, kp.publicKey);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.brokenAt, 2);
        // The existing checks run first: this is the hash mismatch's reason,
        // not the seq check's — even though the entry also has a wrong seq.
        assert.ok(result.reason.includes('hash mismatch'));
        assert.ok(!result.reason.includes('seq discontinuity'));
      }
    }
  ];
}

describe('verifyChain seq continuity (live module)', () => {
  for (const c of cases({ createChain, verifyChain })) {
    it(c.name, c.isSeqCase && !LANDED ? { todo: TODO_MSG } : {}, c.fn);
  }
});

describe('queued patch: proposals/verifychain-seq-continuity.patch', () => {
  if (LANDED) {
    it('the staged patch is already landed in src/chain/index.js', {
      skip: LANDED ? 'seq continuity is live; nothing left to rehearse' : undefined
    }, () => {});
    return;
  }

  let tmp;
  const patchedModule = {
    get createChain() { return mod.createChain; },
    get verifyChain() { return mod.verifyChain; }
  };
  let mod;

  before(async () => {
    // Rehearse the landing: today's source, plus exactly the staged diff.
    // The copy is this checkout's text with CRLF normalised to LF, so the
    // LF patch (the house format, like v3-03-tool-io-digest) applies
    // byte-exactly: the code is today's code, only line endings differ.
    // AutoCRLF checkouts are CRLF on disk; the patch is LF, so both sides are
    // normalised to LF or git apply will not match.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seq-continuity-'));
    fs.mkdirSync(path.join(tmp, 'src', 'chain'), { recursive: true });
    const lf = (s) => s.replace(/\r\n/g, '\n');
    const LF_SOURCE = lf(sourceText);
    fs.writeFileSync(path.join(tmp, 'src', 'chain', 'index.js'), LF_SOURCE);
    const patchText = fs.readFileSync(PATCH_PATH, 'utf8');
    fs.writeFileSync(path.join(tmp, 'seq.patch'), lf(patchText));
    execFileSync('git', ['init', '-q'], { cwd: tmp }); // own repo, so git apply cannot resolve paths against an enclosing repository
    execFileSync('git', ['apply', 'seq.patch'], { cwd: tmp });
    mod = await import(pathToFileURL(path.join(tmp, 'src', 'chain', 'index.js')).href);

    // The patch must be pure addition: eleven added lines, and every original
    // line surviving in order.
    // git apply honours the global autocrlf in the temp repo, so normalise the result too.
    const patchedText = lf(fs.readFileSync(path.join(tmp, 'src', 'chain', 'index.js'), 'utf8'));
    assert.strictEqual(
      newlineCount(patchedText),
      newlineCount(LF_SOURCE) + 11,
      'the patched file is the original plus exactly 11 lines'
    );
    const origLines = LF_SOURCE.split('\n');
    const patchedLines = patchedText.split('\n');
    let matched = 0;
    for (const line of patchedLines) {
      if (line === origLines[matched]) matched++;
    }
    assert.strictEqual(
      matched,
      origLines.length,
      'every original line survives in order: the patch adds lines and changes nothing else'
    );
    assert.ok(patchedText.includes('seq discontinuity'), 'the staged check is in the patched copy');
  });
  after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  it('the staged patch applies cleanly to today\'s source', () => {
    assert.ok(mod, 'the patched module imported (see the before hook)');
  });

  for (const c of cases(patchedModule)) {
    it(c.name, {}, c.fn);
  }
});