/**
 * src/mcp/build-identity.js
 *
 * Which build is answering, and is it still the one on disk.
 *
 * KNOWN-LIMITS 41. An MCP server is spawned once by the client and lives
 * across sessions, so a change under src/ is invisible to it until the client
 * restarts. On 2026-07-26 a fix landed at 19:36 and the same tool returned
 * pre-fix output at 20:45; that stale output was read as a live defect and
 * reported to the operator as a new finding. It was not a defect. It was a
 * process older than the commit, and nothing in the response said so.
 *
 * That is worse than an ordinary stale cache, because the tools this server
 * exposes are the ones whose whole job is to answer what actually happened.
 * The chain was intact and signed the entire time. The reader in front of it
 * was running code that no longer existed.
 *
 * The fix is a fingerprint of the source taken once at process start and
 * recomputed on demand. Content, not mtime: a checkout, a touch, or a
 * change-then-revert all leave the loaded code equal to the code on disk, and
 * a reader should not be told to restart over any of them.
 *
 * WHAT THIS DOES NOT SEE, stated here rather than discovered later:
 *   - Changes under node_modules. A dependency upgrade moves no digest here.
 *   - Anything the process loaded that is not a .js file under the source
 *     dirs: policy files, settings, the chain itself.
 *   - Whether the running process actually loaded the file it is hashing. It
 *     compares disk against disk-at-start, which is a proxy for the loaded
 *     code and is not the loaded code.
 *   - A digest is a detector, not an explanation. It says the source moved,
 *     never what moved (the same edge as limit 53).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * The directories whose contents are this repository's own executable source.
 * Everything the server can behave differently because of lives under one of
 * these two.
 */
const SOURCE_DIRS = ['src', 'bin'];

/**
 * Collect every .js file under `dir`, depth-first, as paths relative to
 * `rootDir` with forward slashes.
 *
 * Unreadable entries are skipped rather than thrown, because this runs on the
 * status path and status must never throw.
 *
 * @param {string} rootDir
 * @param {string} dir
 * @param {string[]} out
 * @returns {string[]}
 */
function collectJsFiles(rootDir, dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);

    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (!isDir && !isFile) {
      // Symlinks and anything exotic: resolve once, and skip if that fails.
      try {
        const st = statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }

    if (isDir) {
      collectJsFiles(rootDir, full, out);
    } else if (isFile && entry.name.endsWith('.js')) {
      out.push(path.relative(rootDir, full).split(path.sep).join('/'));
    }
  }

  return out;
}

/**
 * Fingerprint the repository's own source.
 *
 * Path and length are folded in alongside the bytes so that a rename, or two
 * files swapping contents, moves the digest. Files are hashed in sorted order
 * so the result does not depend on directory-read order.
 *
 * @param {string} rootDir Repository root.
 * @returns {{digest: string|null, fileCount: number, byteCount: number}}
 *   `digest` is null when no source was found at all, which is an answer
 *   ("nothing to hash") rather than a hash of nothing.
 */
export function computeSourceDigest(rootDir) {
  const files = [];
  try {
    for (const d of SOURCE_DIRS) {
      collectJsFiles(rootDir, path.join(rootDir, d), files);
    }
  } catch {
    return { digest: null, fileCount: 0, byteCount: 0 };
  }

  files.sort();

  const hash = createHash('sha256');
  let fileCount = 0;
  let byteCount = 0;

  for (const rel of files) {
    let bytes;
    try {
      bytes = readFileSync(path.join(rootDir, rel));
    } catch {
      continue;
    }
    hash.update(rel);
    hash.update('\n');
    hash.update(String(bytes.length));
    hash.update('\n');
    hash.update(bytes);
    hash.update('\n');
    fileCount += 1;
    byteCount += bytes.length;
  }

  if (fileCount === 0) {
    return { digest: null, fileCount: 0, byteCount: 0 };
  }

  return { digest: hash.digest('hex'), fileCount, byteCount };
}

/**
 * Take the identity of the build that is about to start answering.
 *
 * Called once at module load. Every field degrades to null rather than
 * throwing: a server that cannot say which build it is must still start, and
 * saying "unknown" is the honest form of not knowing.
 *
 * @param {string} rootDir Repository root.
 * @returns {{name: string|null, version: string|null, sourceDigest: string|null,
 *            fileCount: number, byteCount: number, startedAt: string, pid: number}}
 */
export function captureBuildIdentity(rootDir) {
  const startedAt = new Date().toISOString();

  let name = null;
  let version = null;
  try {
    const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    name = pkg.name ?? null;
    version = pkg.version ?? null;
  } catch {
    // A tree with no manifest is a legitimate shape in tests and in a
    // partially-installed checkout. Report unknown, keep going.
  }

  let source = { digest: null, fileCount: 0, byteCount: 0 };
  try {
    source = computeSourceDigest(rootDir);
  } catch {
    // computeSourceDigest already swallows; this is belt and braces on the
    // one path where status must never throw.
  }

  return {
    name,
    version,
    sourceDigest: source.digest,
    fileCount: source.fileCount,
    byteCount: source.byteCount,
    startedAt,
    pid: process.pid
  };
}

/**
 * Is the answering process still the build that is on disk.
 *
 * @param {{sourceDigest: string|null}} captured Value from captureBuildIdentity.
 * @param {string} rootDir Repository root.
 * @returns {{stale: boolean|null, currentDigest: string|null, reason: string}}
 *   `stale` is true when the source moved under a live process, false when it
 *   matches, and **null when it could not be determined**. Null is not a quiet
 *   false: an undetermined answer that reads as fresh is exactly the failure
 *   this module exists to stop.
 */
export function checkFreshness(captured, rootDir) {
  const capturedDigest = captured && typeof captured.sourceDigest === 'string'
    ? captured.sourceDigest
    : null;

  let currentDigest = null;
  try {
    currentDigest = computeSourceDigest(rootDir).digest;
  } catch {
    currentDigest = null;
  }

  if (capturedDigest === null || currentDigest === null) {
    return {
      stale: null,
      currentDigest,
      reason:
        'Could not determine whether this process matches the source on disk: ' +
        (capturedDigest === null
          ? 'no digest was captured at start.'
          : 'the source could not be read now.') +
        ' Treat a surprising answer as possibly a version question.'
    };
  }

  if (capturedDigest === currentDigest) {
    return {
      stale: false,
      currentDigest,
      reason: 'This process is running the source that is currently on disk.'
    };
  }

  return {
    stale: true,
    currentDigest,
    reason:
      'The source on disk has changed since this server process started, so ' +
      'these answers come from a build that no longer exists. Restart the MCP ' +
      'client before trusting them.'
  };
}
