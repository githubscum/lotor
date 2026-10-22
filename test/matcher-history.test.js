/**
 * test/matcher-history.test.js
 *
 * KNOWN-LIMITS 53, reader half: matcherHashAt / matcherHistory /
 * findMatcherHash. The fixtures are throwaway git repos (unique temp dir per
 * test, user.name/email configured inside the temp repo only) with a literal
 * `src/policy/index.js` per commit, because the whole point of the module is
 * that an ERA's own exports answer for that era — the tests import the
 * historical code rather than reimplementing the stamp.
 *
 * The literal-hash discipline of this suite (inherited from
 * grant-core-paths.test.js): 'aaaaaaaaaaaaaaaa' and 'bbbbbbbbbbbbbbbb' are
 * fixed strings, not derived from anything, so a reader that quietly agreed
 * with itself would fail here rather than match.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  matcherHashAt,
  matcherHistory,
  findMatcherHash
} from '../src/views/matcher-history.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-mh-test-'));
  git(['init', '-q'], dir);
  // Identity INSIDE the throwaway repo only, per the work order: the temp
  // repo has no reason to share anything with the real clone.
  git(['config', 'user.email', 'matcher-history-test@example.invalid'], dir);
  git(['config', 'user.name', 'matcher-history-test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  return dir;
}

function writePolicy(repo, body) {
  const dir = path.join(repo, 'src', 'policy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), body);
}

function commitAll(repo, msg) {
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', msg], repo);
  return git(['rev-parse', 'HEAD'], repo).trim();
}

const A_HASH = 'aaaaaaaaaaaaaaaa';
const B_HASH = 'bbbbbbbbbbbbbbbb';

const POLICY_A = `export function matcherVersionHash() { return '${A_HASH}'; }\n`;
const POLICY_B = `export function matcherVersionHash() { return '${B_HASH}'; }\n`;

describe('matcher-history (KNOWN-LIMITS 53, reader half)', () => {
  it('matcherHistory returns the policy-touching commits newest-first, hashes b, a, null', async () => {
    const repo = makeTempRepo();
    try {
      // Commit 0: SRC/POLICY existed but predates the stamp function. It
      // still counts as a policy commit; only its hash is unanswerable.
      writePolicy(repo, 'export const version = 0;\n');
      const sha0 = commitAll(repo, 'policy before the stamp existed');
      writePolicy(repo, POLICY_A);
      const sha1 = commitAll(repo, 'stamp a');
      writePolicy(repo, POLICY_B);
      const sha2 = commitAll(repo, 'stamp b');
      // A commit that touches NO policy file must not appear at all.
      fs.writeFileSync(path.join(repo, 'README.txt'), 'unrelated\n');
      const sha3 = commitAll(repo, 'unrelated file');
      assert.notStrictEqual(sha3, sha2);

      const hist = await matcherHistory(repo);
      assert.strictEqual(hist.length, 3, 'the unrelated commit must be filtered out by git log -- src/policy/');
      assert.deepStrictEqual(hist.map(h => h.sha), [sha2, sha1, sha0],
        'newest-first, matching git log order');
      assert.deepStrictEqual(hist.map(h => h.hash), [B_HASH, A_HASH, null],
        'b, a, then unanswerable: the pre-stamp commit reads as null, not as 0 or as a guess');
      assert.deepStrictEqual(hist.map(h => h.hashCrlf), [B_HASH, A_HASH, null],
        'the crlf column is populated too; equal to the lf column here BY CONSTRUCTION: the fixtures are one line ending in \\n and toString() excludes the trailing newline, so the CRLF rewrite touches nothing the stamp sees (the dedicated EOL test below proves the columns differ once a fixture is multi-line)');
      // Dates came from %cI (strict ISO), so a reader can sort them.
      for (const row of hist) {
        assert.ok(typeof row.date === 'string' && row.date.includes('T'),
          `date must be ISO (%cI), got ${row.date}`);
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('findMatcherHash(full a-hash) finds exactly the a commit, first === last', async () => {
    const repo = makeTempRepo();
    try {
      writePolicy(repo, 'export const version = 0;\n');
      commitAll(repo, 'pre-stamp');
      writePolicy(repo, POLICY_A);
      const shaA = commitAll(repo, 'stamp a');
      writePolicy(repo, POLICY_B);
      commitAll(repo, 'stamp b');

      const found = await findMatcherHash(repo, A_HASH);
      assert.strictEqual(found.commits.length, 1, 'exactly the a commit');
      assert.strictEqual(found.commits[0].sha, shaA);
      assert.strictEqual(found.first.sha, shaA, 'first is the oldest match');
      assert.strictEqual(found.last.sha, shaA, 'last is the newest match');
      assert.strictEqual(found.first, found.last, 'one match: first and last are the same commit');
      // These one-line fixtures stamp identically in both columns, so the
      // match hits hash AND hashCrlf; the prefer-'lf' rule decides.
      assert.strictEqual(found.commits[0].eol, 'lf', 'both columns match; lf wins by the prefer-lf rule');
      assert.strictEqual(found.eol, 'lf', 'the result names the eol of first');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('findMatcherHash accepts an 8-char prefix ("bbbbbbbb")', async () => {
    const repo = makeTempRepo();
    try {
      writePolicy(repo, POLICY_A);
      commitAll(repo, 'stamp a');
      writePolicy(repo, POLICY_B);
      const shaB = commitAll(repo, 'stamp b');

      const found = await findMatcherHash(repo, 'bbbbbbbb');
      assert.strictEqual(found.commits.length, 1, '8 chars is enough to look up, not enough to guess');
      assert.strictEqual(found.commits[0].sha, shaB);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('an unknown hash returns commits: [] and does not throw', async () => {
    const repo = makeTempRepo();
    try {
      writePolicy(repo, POLICY_A);
      commitAll(repo, 'stamp a');

      const found = await findMatcherHash(repo, 'deadbeefdeadbeef');
      assert.deepStrictEqual(found.commits, []);
      assert.strictEqual(found.first, undefined, 'not-found carries no first/last to misread');
      assert.strictEqual(found.last, undefined);
      // A short (< 8 char) probe must not prefix-match its way to a hit.
      const short = await findMatcherHash(repo, 'bbbb');
      assert.deepStrictEqual(short.commits, [],
        'a sub-8-char probe is a guess, not a lookup: exact equality only');
      // And a repo with NO policy history answers the same way. That repo is
      // created inline, so it must be captured and removed here too — a
      // inline makeTempRepo() would leak a lotor-mh-test- dir into tmpdir
      // and defeat the cleanup test below.
      const emptyRepo = makeTempRepo();
      try {
        const empty = await findMatcherHash(emptyRepo, A_HASH);
        assert.deepStrictEqual(empty.commits, []);
      } finally {
        fs.rmSync(emptyRepo, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('a commit whose policy file throws on import reads as null, and never crashes the reader', async () => {
    const repo = makeTempRepo();
    try {
      writePolicy(repo, 'throw new Error("probe: historical policy crash");\n');
      commitAll(repo, 'policy that crashes on import');

      const at = await matcherHashAt(repo, 'HEAD');
      assert.strictEqual(at, null,
        'unanswerable history reads as null, exactly like a pre-stamp commit');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("a sha or ref starting with '-' is refused before git can read it as an option", async () => {
    const repo = makeTempRepo();
    const outLog = path.join(os.tmpdir(), `mh-optprobe-log-${process.pid}.txt`);
    const outShow = path.join(os.tmpdir(), `mh-optprobe-show-${process.pid}.txt`);
    try {
      writePolicy(repo, POLICY_A);
      commitAll(repo, 'stamp a');
      // Before the guard, `git log ... --output=<file>` wrote that file.
      assert.deepStrictEqual(await matcherHistory(repo, { ref: `--output=${outLog}` }), []);
      assert.strictEqual(fs.existsSync(outLog), false, 'git log must never see the ref as an option');
      assert.strictEqual(await matcherHashAt(repo, `--output=${outShow}`), null);
      assert.strictEqual(fs.existsSync(outShow), false, 'git must never see the sha as an option');
      assert.deepStrictEqual((await findMatcherHash(repo, A_HASH, { ref: '-p' })).commits, []);
      // The guard refuses only option-shaped input; an ordinary ref still works.
      assert.strictEqual(await matcherHashAt(repo, 'HEAD'), A_HASH);
    } finally {
      for (const f of [outLog, outShow]) fs.rmSync(f, { force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("eol: 'bogus' is a TypeError, not a silent default", async () => {
    const repo = makeTempRepo();
    try {
      writePolicy(repo, POLICY_A);
      commitAll(repo, 'stamp a');
      // eol names WHICH stamp to recompute (see caveat 4 of the reader); an
      // unknown value must refuse loudly rather than quietly stamp the lf way.
      await assert.rejects(() => matcherHashAt(repo, 'HEAD', { eol: 'bogus' }), TypeError);
      // The default is still 'lf': omitting eol keeps the original behaviour.
      assert.strictEqual(await matcherHashAt(repo, 'HEAD'), A_HASH);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('a MULTI-LINE policy stamps differently per EOL, and findMatcherHash resolves each column', async () => {
    const repo = makeTempRepo();
    try {
      // A fixture that derives its stamp from its own source: toString() of a
      // function carries the materialized file's line endings, so the LF and
      // CRLF materializations of the SAME commit produce DIFFERENT stamps.
      // This is the shape KNOWN-LIMITS 75 bites on; one-line fixtures cannot
      // show it because toString() excludes the trailing newline.
      const multilinePolicy = [
        "import crypto from 'node:crypto';",
        'export function matcherVersionHash() {',
        "  return crypto.createHash('sha256').update(matcherVersionHash.toString()).digest('hex').slice(0, 16);",
        '}'
      ].join('\n') + '\n';
      writePolicy(repo, multilinePolicy);
      const sha = commitAll(repo, 'self-hashing multi-line policy');

      const lf = await matcherHashAt(repo, sha, { eol: 'lf' });
      const crlf = await matcherHashAt(repo, sha, { eol: 'crlf' });
      assert.ok(typeof lf === 'string' && typeof crlf === 'string',
        'both recomputes must produce a stamp for a working policy file');
      assert.notStrictEqual(lf, crlf,
        'same commit, two checkouts, two stamps: that is the line-ending limit');

      // A receipt minted on each checkout resolves, and the reader says
      // WHICH checkout shape it matched.
      const viaCrlf = await findMatcherHash(repo, crlf);
      assert.strictEqual(viaCrlf.commits.length, 1,
        'the CRLF receipt resolves through the crlf column');
      assert.strictEqual(viaCrlf.commits[0].sha, sha);
      assert.strictEqual(viaCrlf.commits[0].eol, 'crlf');
      assert.strictEqual(viaCrlf.eol, 'crlf', "the result names first's eol");

      const viaLf = await findMatcherHash(repo, lf);
      assert.strictEqual(viaLf.commits.length, 1,
        'and the LF receipt still resolves the same commit');
      assert.strictEqual(viaLf.commits[0].sha, sha);
      assert.strictEqual(viaLf.commits[0].eol, 'lf');
      assert.strictEqual(viaLf.eol, 'lf');

      // matcherHistory exposes both columns for that one commit.
      const hist = await matcherHistory(repo);
      assert.deepStrictEqual(
        hist.find(h => h.sha === sha),
        { sha, date: hist.find(h => h.sha === sha).date, hash: lf, hashCrlf: crlf },
        'the row carries hash (LF) and hashCrlf (CRLF), distinct for a multi-line source'
      );
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('temp dirs prefixed lotor-mh- are cleaned up (count before/after in os.tmpdir())', async () => {
    const countTmp = () => fs.readdirSync(os.tmpdir())
      .filter(n => n.startsWith('lotor-mh-')).length;
    const before = countTmp();
    let repo;
    try {
      repo = makeTempRepo();
      const withRepo = countTmp(); // the throwaway repo itself is lotor-mh-prefixed
      writePolicy(repo, POLICY_A);
      const shaA = commitAll(repo, 'stamp a');
      writePolicy(repo, POLICY_B);
      commitAll(repo, 'stamp b');

      await matcherHistory(repo);
      await matcherHashAt(repo, shaA);
      await findMatcherHash(repo, A_HASH);

      assert.strictEqual(countTmp(), withRepo,
        'every lotor-mh- dir the reader created must be gone; the only survivor is the test repo it started with');
    } finally {
      if (repo) fs.rmSync(repo, { recursive: true, force: true });
    }
    assert.strictEqual(countTmp(), before, 'after the test itself cleans up, the tmpdir count returns to where it was');
  });

  it('REAL-REPO smoke: HEAD recompute equals the live matcherVersionHash when src/policy is clean vs HEAD', async t => {
    let clean = true;
    try {
      execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'src/policy/'],
        { cwd: REPO_ROOT, stdio: 'ignore' });
    } catch {
      clean = false;
    }
    if (!clean) {
      return t.skip('working-tree src/policy/ differs from HEAD; recompute would legitimately differ');
    }
    const { matcherVersionHash } = await import('../src/policy/index.js');
    const live = matcherVersionHash();
    const atLf = await matcherHashAt(REPO_ROOT, 'HEAD', { eol: 'lf' });
    const atCrlf = await matcherHashAt(REPO_ROOT, 'HEAD', { eol: 'crlf' });
    // caveat 4 of the reader: the live stamp depends on THIS checkout's line
    // endings. A git blob is LF, but a Windows autocrlf working tree hashes
    // CRLF source — so "correct" is EITHER recompute, and a mismatch against
    // both means the historical recompute path itself is broken.
    assert.ok(live === atLf || live === atCrlf,
      `live stamp ${live} must equal the LF (${atLf}) or CRLF (${atCrlf}) recompute of HEAD: this checkout is one of those two shapes`);
    // Whichever shape this checkout is, a reader holding THIS receipt must
    // be able to walk it back through the matcher. (The matched commit is
    // some src/policy toucher, not necessarily HEAD itself; this does not
    // assume the stamp is unique in history — only that the row that matched
    // actually carries it, with an eol verdict named.)
    const found = await findMatcherHash(REPO_ROOT, live);
    assert.ok(found.commits.length >= 1,
      'the live stamp resolves to at least one policy commit');
    assert.ok(found.commits.every(m => m.hash === live || m.hashCrlf === live),
      'every matched row carries the live stamp');
    assert.ok(found.eol === 'lf' || found.eol === 'crlf',
      `findMatcherHash must name which column matched, got eol ${found.eol}`);
  });
});