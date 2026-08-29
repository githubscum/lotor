import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseSession } from '../parser/index.js';
import { createStore } from '../store/index.js';
import { resolveHome } from '../home.js';

/**
 * src/ingest/index.js
 *
 * Session → Receipt → Chain ingestion.
 */

/**
 * Ingest a session JSONL file into the receipt chain.
 *
 * Each qualifying SessionEnd appends a NEW receipt for the same session,
 * indexed `subsession` 0, 1, 2, ... n. The no-change guard prevents
 * inflation: if the transcript has not grown since the last receipt for
 * that session, nothing is appended.
 *
 * @param {string} jsonlText - Raw JSONL content from a session file
 * @returns {{entry: (Object|null), skipped: boolean, subsession: (number|null), sessionId: string}}
 */
function ingestSession(jsonlText, opts = {}) {
  // Parse the session into a ReceiptSummary. The count of successfully
  // parsed entries is the growth marker the no-change guard compares.
  // opts is forwarded verbatim (transcriptBytes for the transcriptHash
  // bind); existing single-arg callers are unchanged.
  const receiptSummary = parseSession(jsonlText, opts);
  const sessionId = receiptSummary.session.id;
  const thisSize = receiptSummary.counts.transcriptEntries;

  const home = resolveHome();
  const store = createStore(home);

  // Thought sidecar (2026-08-29). The parser's cost.thoughts array is one
  // row per distinct assistant message; embedding it would grow a heavy
  // session's receipt by two orders of magnitude, so the DETAIL goes to a
  // sidecar file and the RECEIPT keeps a binding summary. Same precedent
  // as transcriptHash: bind by digest, do not embed. The digest is computed
  // over the exact bytes the sidecar will hold, BEFORE the append, because
  // the chain hashes the payload; the file itself is written only after a
  // successful append (a skipped ingest writes nothing).
  let sidecarText = null;
  if (receiptSummary.cost && Array.isArray(receiptSummary.cost.thoughts)) {
    const rows = receiptSummary.cost.thoughts;
    sidecarText = rows.length
      ? rows.map(r => JSON.stringify(r)).join('\n') + '\n'
      : '';
    receiptSummary.cost.thoughts = {
      schema: 'thoughts/1',
      count: rows.length,
      digest: crypto.createHash('sha256').update(sidecarText, 'utf-8').digest('hex')
    };
  }

  // Atomic check-then-append under the chain lock. buildPayload runs
  // against the current chain tail, so two concurrent firings cannot
  // both decide to append subsession 0.
  const entry = store.appendReceiptGuarded((currentEntries) => {
    const existing = currentEntries.filter(
      e => e?.payload?.session?.id === sessionId
    );

    if (existing.length === 0) {
      receiptSummary.session.subsession = 0;
      return receiptSummary;
    }

    const lastSize = existing.reduce(
      (max, e) => Math.max(max, e?.payload?.counts?.transcriptEntries || 0),
      0
    );

    if (thisSize <= lastSize) {
      // No new activity since the last receipt for this session.
      return null;
    }

    receiptSummary.session.subsession = existing.length;
    return receiptSummary;
  });

  if (entry == null) {
    return { entry: null, skipped: true, subsession: null, sessionId };
  }

  // Write the sidecar the receipt's digest now binds. Failure here is
  // reported by the caller's catch, and the seam is disclosed: a receipt
  // can reference a digest whose file never landed (crash between append
  // and write). The digest still proves what the rows WERE; only the local
  // copy is missing. Session ids are uuids in practice; sanitize anyway so
  // a hostile id cannot traverse out of <home>/thoughts/.
  if (sidecarText !== null && entry.payload.cost.thoughts.count > 0) {
    const dir = path.join(home, 'thoughts');
    fs.mkdirSync(dir, { recursive: true });
    const safeId = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_');
    const file = path.join(
      dir, `${safeId}-s${entry.payload.session.subsession}.jsonl`
    );
    fs.writeFileSync(file, sidecarText, 'utf-8');
  }

  return {
    entry,
    skipped: false,
    subsession: entry.payload.session.subsession,
    sessionId
  };
}

export { ingestSession };
