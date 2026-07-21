import { parseSession } from '../parser/index.js';
import { createStore } from '../store/index.js';

/**
 * src/ingest/index.js
 *
 * Session → Receipt → Chain ingestion.
 */

/**
 * Ingest a session JSONL file into the receipt chain.
 * @param {string} jsonlText - Raw JSONL content from a session file
 * @returns {Object} The created chain entry
 */
function ingestSession(jsonlText) {
  // Parse the session into a ReceiptSummary
  const receiptSummary = parseSession(jsonlText);

  // Create store and append to chain
  const store = createStore();
  const entry = store.appendReceipt(receiptSummary);

  return entry;
}

export { ingestSession };
