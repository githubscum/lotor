/**
 * src/views/matcher-history.js
 *
 * KNOWN-LIMITS 53, reader half: a receipt carries `matcherHash` (16 hex), and
 * two receipts carrying different hashes prove the matcher changed. But the
 * hash DETECTS, it does not EXPLAIN: nothing on the receipt says WHICH COMMIT
 * each hash came from, so a reader could not get the diff the change implies.
 * This module re-derives the stamp at historical commits so a reader can walk
 * from "these two hashes differ" to "here is the commit that produced each,
 * and here is the diff between them".
 *
 * WHY EXECUTION, NOT PARSING: the stamp is `matcherVersionHash()` over the
 * rule sources (MATCHER_SCHEMA names the hashing method). Re-parsing history
 * would be a second, drifting implementation of the stamp. Importing each
 * commit's actual `src/policy/index.js` and calling its own
 * `matcherVersionHash` recomputes the value exactly as its era computed it.
 *
 * WHAT IT CANNOT TELL YOU, AND WHY THAT IS STATED ON ITS OWN SURFACE
 *   1. It only resolves hashes a commit in THIS clone produced. A hash minted
 *      in an uncommitted working tree, or by another fork, reads as
 *      not-found. That is "unknown provenance", never "tampered": absence
 *      here is evidence about this clone, not about the holder of the hash.
 *   2. It hashes only src/policy, matching what matcherVersionHash covers.
 *      Behaviour reached from OUTSIDE that directory (git-context.js, the
 *      gate, the grant checker) is not in the stamp; KNOWN-LIMITS 64 covers
 *      the rest with the whole-tree source digest on session-open receipts.
 *   3. It executes historical repo code to recompute. On your own clone that
 *      is the reader explaining their own history; run against a stranger's
 *      tree it is arbitrary code execution by another name. This is a reader
 *      for your own clone, not a verifier of anyone else's.
 *   4. The stamp is line-ending-sensitive (KNOWN-LIMITS 75): it digests
 *      Function.prototype.toString(), and that string carries the checkout's
 *      line endings, so the same commit stamps differently on a CRLF clone
 *      than it did in its LF era. This reader recomputes the stamp BOTH ways
 *      (hash = LF, hashCrlf = CRLF) and findMatcherHash reports which one a
 *      receipt's hash actually matched, so a Windows autocrlf receipt still
 *      resolves. Any OTHER byte-level transform of the checkout — a BOM, a
 *      formatter that rewrapped the code — still reads as not-found.
 *
 * NOTE ON ASYNCHRONY: `import()` is asynchronous by definition, so these
 * three functions return promises. The resolved values follow the shapes in
 * the signatures below.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TMP_PREFIX = 'lotor-mh-';

// execFileSync passes arguments as an argv vector with no shell, so a sha
// taken from a receipt can never fragment into extra git arguments.
function gitRead(repoDir, args) {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
}

// Best-effort cleanup on Windows, where antivirus and lingering module
// handles can hold a freshly-imported file for a moment: rmSync retries
// EBUSY/EPERM before giving up, and force ignores ENOENT.
function rmTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // The tmpdir is scratch space; a leftover dir is an annoyance, not a
    // failure of the answer. The cleanup test counts these, so a leak here
    // is caught by the suite rather than hidden behind a throw.
  }
}

/**
 * The matcherVersionHash value a given commit would have stamped, recomputed
 * from that commit's own src/policy code.
 *
 * @param {string} repoDir - the clone to read (your own; see caveat 3 above)
 * @param {string} sha     - a commit, ref name, or 'HEAD'
 * @param {object} [opts]
 * @param {'lf'|'crlf'} [opts.eol='lf'] - which line endings to give the
 *   materialized files before importing. The stamp is line-ending-sensitive
 *   (caveat 4 above), so this selects WHICH stamp the commit would have
 *   carried at that checkout: 'lf' is how the source reads in git itself,
 *   'crlf' exists to resolve a receipt minted on a Windows autocrlf clone.
 *   Anything else rejects with a TypeError rather than silently defaulting.
 * @returns {Promise<string|null>} the 16-hex stamp, or null when the commit
 *   predates the stamp, has no src/policy .js files, or the historical code
 *   cannot be imported (see the throwaway-import contract in matcherHistory).
 */
export async function matcherHashAt(repoDir, sha, { eol = 'lf' } = {}) {
  if (eol !== 'lf' && eol !== 'crlf') {
    throw new TypeError(`eol must be 'lf' or 'crlf', got ${JSON.stringify(eol)}`);
  }
  let files;
  try {
    files = gitRead(repoDir, ['ls-tree', '--name-only', sha, 'src/policy/'])
      .split(/\r?\n/).filter(Boolean);
  } catch {
    // A sha that is not in this clone, or a commit with no src/policy tree:
    // nothing to recompute, and "unknown" is the honest answer.
    return null;
  }
  const jsFiles = files.filter(f => f.endsWith('.js'));
  if (jsFiles.length === 0) return null;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  try {
    // The materialized tree must be an ESM package. A bare .js under
    // os.tmpdir() imports as CommonJS (no package.json above it), so the
    // `export` syntax in a historical policy file would read as a parse
    // error and every pre-modern commit would look like "null" for the
    // wrong reason.
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}\n');
    for (const f of jsFiles) {
      const body = gitRead(repoDir, ['show', `${sha}:${f}`]);
      // git show yields the blob as git stores text (LF); the checkout the
      // stamp was minted in may have seen it differently, so normalize to the
      // requested shape before the historical file is imported. Anything this
      // does not fix (a BOM, a reformat) is caveat 4's not-found, not a guess.
      const shaped = eol === 'crlf'
        ? body.replace(/\r?\n/g, '\r\n')
        : body.replace(/\r\n/g, '\n');
      const dest = path.join(tmp, ...f.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, shaped);
    }
    const url = pathToFileURL(path.join(tmp, 'src', 'policy', 'index.js'));
    let hash = null;
    try {
      const mod = await import(url);
      if (typeof mod.matcherVersionHash === 'function') {
        const v = mod.matcherVersionHash();
        hash = typeof v === 'string' ? v : null;
      }
      // No matcherVersionHash export: the commit predates the stamp (null).
    } catch {
      // An import that throws (a historical file that crashed on load) reads
      // the same as a pre-stamp commit: null. It must never crash the reader.
      hash = null;
    }
    return hash;
  } finally {
    rmTempDir(tmp);
  }
}

/**
 * Every commit that touched src/policy, newest-first, with the matcher stamp
 * each one would have carried.
 *
 * @param {string} repoDir
 * @param {object} [opts]
 * @param {string} [opts.ref='HEAD']
 * @param {number} [opts.limit] - truncates the RETURNED list (newest first);
 *                  it does not widen the search, so a match older than the
 *                  limit cannot be found by findMatcherHash in the same call.
 * @returns {Promise<Array<{sha, date, hash, hashCrlf}>>}
 *   `hash` is the LF stamp (what git itself stores), `hashCrlf` the CRLF one
 *   (what a Windows autocrlf checkout of the same commit would stamp; see
 *   caveat 4). Both are null for pre-stamp or failed-import commits.
 */
export async function matcherHistory(repoDir, opts = {}) {
  const ref = opts.ref ?? 'HEAD';
  let out = '';
  try {
    out = gitRead(repoDir, ['log', '--format=%H%x09%cI', ref, '--', 'src/policy/']);
  } catch {
    // No history for src/policy in this clone (or not a repo at all): an
    // empty history is the honest empty answer for a reader.
    return [];
  }
  // git log already lists newest-first; keep that order and say so.
  const rows = out.split(/\r?\n/).filter(Boolean).map(line => {
    const sep = line.indexOf('\t');
    return { sha: line.slice(0, sep), date: line.slice(sep + 1) };
  });
  const stamped = await Promise.all(
    rows.map(async r => {
      const [hash, hashCrlf] = await Promise.all([
        matcherHashAt(repoDir, r.sha, { eol: 'lf' }),
        matcherHashAt(repoDir, r.sha, { eol: 'crlf' })
      ]);
      return { ...r, hash, hashCrlf };
    })
  );
  return Number.isFinite(opts.limit) ? stamped.slice(0, opts.limit) : stamped;
}

/**
 * Which commits produced a given matcherHash, so a reader can get the diff.
 *
 * The probe is matched against BOTH stamp columns (LF and CRLF — caveat 4);
 * each returned commit carries `eol: 'lf' | 'crlf'` naming which column it
 * matched, preferring 'lf' when a commit stamps the same both ways.
 *
 * @param {string} repoDir
 * @param {string} hash  - full 16-hex stamp, or a prefix of at least 8 chars
 * @param {object} [opts] - forwarded to matcherHistory ({ ref, limit })
 * @returns {Promise<{hash, commits: Array<{sha,date,hash,hashCrlf,eol}>, first?, last?, eol?}>}
 *   `first` is the OLDEST matching commit and `last` the newest (the history
 *   is newest-first, so first is the tail and last the head); `eol` is
 *   `first`'s. Never throws: an unknown hash, an unread repo and a short
 *   hash all read as not-found — the empty shape has no commits and no eol.
 */
export async function findMatcherHash(repoDir, hash, opts = {}) {
  const clean = typeof hash === 'string' ? hash.trim().toLowerCase() : '';
  const empty = { hash: hash ?? null, commits: [] };
  if (clean === '') return empty;

  let history;
  try {
    history = await matcherHistory(repoDir, opts);
  } catch {
    return empty;
  }
  // BELOW 8 CHARACTERS a prefix match is a guess, not a lookup: too many
  // stamps share any shorter prefix, so only exact equality is accepted.
  const byPrefix = clean.length >= 8;
  const hit = candidate => Boolean(candidate) && (byPrefix
    ? candidate.toLowerCase().startsWith(clean)
    : candidate.toLowerCase() === clean);
  // One commit can match through either column — same commit, two checkouts —
  // so it is reported once, with 'lf' preferred when both columns match.
  const matches = history
    .filter(row => hit(row.hash) || hit(row.hashCrlf))
    .map(row => ({ ...row, eol: hit(row.hash) ? 'lf' : 'crlf' }));
  if (matches.length === 0) return empty;
  const first = matches[matches.length - 1];
  return {
    hash,
    eol: first.eol,
    commits: matches,
    first,
    last: matches[0]
  };
}