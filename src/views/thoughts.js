/**
 * src/views/thoughts.js
 *
 * The thought sidecar reader (KNOWN-LIMITS 60, reader half). At ingest,
 * src/ingest/index.js collapses the parser's cost.thoughts array into a
 * binding on the receipt -- { schema: 'thoughts/1', count, digest } --
 * and, only when count > 0, writes the detail rows to
 * <home>/thoughts/<safeId>-s<subsession>.jsonl, where digest is SHA-256
 * over the exact sidecar bytes. Until now nothing read that file back, so
 * a deleted or edited sidecar was silent.
 *
 * WHAT checkThoughtSidecars REPORTS, ONE STATUS PER EXAMINED RECEIPT
 *   none-expected  count is 0. Ingest writes no file for an empty session.
 *   match          the file is present and its raw bytes hash to the digest the receipt bound.
 *   mismatch       the file is present but the hash differs; actualDigest carries the hash found.
 *   missing        count > 0 and there is no readable file at the expected path.
 *   orphan         a file present in <home>/thoughts/ that no examined receipt expects.
 *   malformed      the binding itself is not well-formed -- count is not a
 *                  non-negative integer, or digest is not 64-char lowercase
 *                  hex -- so nothing was expected at any path. file and
 *                  actualDigest are null, and a file on disk for it shows
 *                  as orphan.
 *
 * KNOWN-LIMITS 60: `missing` cannot distinguish a crash between the chain
 * append and the sidecar write (the seam ingest itself discloses) from a
 * later deletion. The chain cannot tell them apart, and neither does this
 * view; it reports the fact and leaves the cause unstated.
 *
 * The digest is always computed over the file's raw bytes, not re-encoded
 * text, same bytes-first rule as the transcript hash.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const THOUGHTS_SCHEMA = 'thoughts/1';

/** Same sanitize rule as src/ingest/index.js, so a hostile id cannot traverse out of <home>/thoughts/. */
const safeName = id => String(id).replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * Check every thought sidecar binding in the given entries against the
 * files on disk, and the directory against the entries.
 *
 * @param {Array} entries chain entries (objects with .payload), oldest first
 * @param {string} home  the Lotor home directory
 * @returns {{rows: Array, summary: object}} rows in entry order, orphans
 *          last; summary counts each status with every key always present.
 */
export function checkThoughtSidecars(entries, home) {
  const list = Array.isArray(entries) ? entries : [];
  const dir = path.join(String(home), 'thoughts');

  const rows = [];
  const expected = new Set();

  for (const e of list) {
    const t = e?.payload?.cost?.thoughts;
    // Skip everything else: no binding, or not the schema this view reads.
    if (!t || typeof t !== 'object' || t.schema !== THOUGHTS_SCHEMA) continue;

    const session = e?.payload?.session || {};
    const sessionId = session.id ?? null;
    const subsession = session.subsession ?? null;
    const count = t.count;
    const digest = typeof t.digest === 'string' ? t.digest : null;
    const digestOk = digest !== null && /^[0-9a-f]{64}$/.test(digest);

    // A binding that is not well-formed never expected anything at any
    // path, so calling it 'missing' would be a false statement. It gets
    // its own status, owns no expected file (a file on disk for it reads
    // as orphan), and never throws.
    if (!Number.isInteger(count) || count < 0 || !digestOk) {
      rows.push({
        sessionId,
        subsession,
        count,
        digest,
        file: null,
        status: 'malformed',
        actualDigest: null
      });
      continue;
    }

    const expectedFile = count > 0
      ? path.join(dir, `${safeName(sessionId)}-s${subsession}.jsonl`)
      : null;

    const row = {
      sessionId,
      subsession,
      count,
      digest,
      file: expectedFile,
      status: 'missing',
      actualDigest: null
    };

    if (count === 0) {
      row.status = 'none-expected';
    } else {
      // Registered before the read so a present file is never double-counted.
      expected.add(expectedFile);
      let bytes = null;
      try {
        bytes = fs.readFileSync(expectedFile);
      } catch (err) {
        row.status = 'missing';
        // A plain absence is the normal missing case; only a real read
        // failure is worth carrying a message for. Never throw.
        if (err && err.code !== 'ENOENT') row.error = err.message;
      }
      if (bytes !== null) {
        const actual = crypto.createHash('sha256').update(bytes).digest('hex');
        row.actualDigest = actual;
        row.status = actual === digest ? 'match' : 'mismatch';
      }
    }
    rows.push(row);
  }

  // Orphans: files on disk that no examined receipt expects. A missing
  // <home>/thoughts/ directory is not an error; it just yields none.
  let dirents = [];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) { /* no thoughts dir */ }
  for (const d of dirents) {
    if (!d.isFile()) continue;
    const full = path.join(dir, d.name);
    if (expected.has(full)) continue;
    rows.push({
      sessionId: null,
      subsession: null,
      count: null,
      digest: null,
      file: full,
      status: 'orphan',
      actualDigest: null
    });
  }

  const summary = { match: 0, mismatch: 0, missing: 0, 'none-expected': 0, orphan: 0, malformed: 0 };
  for (const r of rows) summary[r.status]++;

  return { rows, summary };
}