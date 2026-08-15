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

  const store = createStore(resolveHome());

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

  return {
    entry,
    skipped: false,
    subsession: entry.payload.session.subsession,
    sessionId
  };
}

export { ingestSession };
