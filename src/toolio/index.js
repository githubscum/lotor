/**
 * src/toolio/index.js
 *
 * Rung R2 (tool I/O) for Lotor v3, work order V3-03. Describes what a tool
 * RETURNED, as a digest, so a receipt can say "this call came back with these
 * bytes" without ever holding the bytes. Spec: the brain's
 * projects/meter/LOTOR-V3-SPEC-2026-10-18.md, the R2 row and evals E2/E5.
 *
 * Lotor captures; it never judges intent. Nothing here interprets a response.
 * It hashes it, measures it, and copies the host's own error signal.
 *
 * WHAT A RECEIPT CARRIES
 *   describeToolResponse(toolResponse) returns the `toolIo` object a receipt
 *   embeds. Recorded:
 *
 *     { schema: 'toolio/1',
 *       response: { recorded: true, digest: <64 hex>, bytes: <int>,
 *                   error: true | false | null } }
 *
 *   Unrecorded (no digest field AT ALL, never an empty or sentinel digest):
 *
 *     { schema: 'toolio/1',
 *       response: { recorded: false, reason: 'absent' | 'null' | 'unserializable' } }
 *
 *   'absent' means the host payload had no tool_response. 'null' means the host
 *   sent tool_response: null. 'unserializable' means a value was there and could
 *   not be put into canonical form (circular, BigInt, a bare function). In every
 *   one of those the honest reading is "Lotor did not see what came back", which
 *   is a different fact from "the tool returned nothing". A tool that returned
 *   an empty string or an empty object IS recorded, with the digest of `""` or
 *   `{}`, because an empty answer is still an answer.
 *
 * THE toolio/1 CANONICAL FORM (bump the marker if any of this changes)
 *   1. Every STRING LEAF has each CRLF ("\r\n") replaced by LF ("\n"). A lone
 *      CR is left alone: it is content (progress bars, old Mac files), not a
 *      line ending. Object KEYS are not rewritten.
 *   2. Object keys sorted recursively at every depth, arrays kept in order:
 *      the params/1 canonicalizer, imported from src/parser/index.js rather
 *      than copied a third time.
 *   3. JSON.stringify of the result, UTF-8 encoded.
 *   digest = full SHA-256 hex of those bytes (64 chars; no truncation, for the
 *   same birthday-bound reason as paramsDigestCanonical). bytes = their count.
 *
 *   Step 1 exists because the same file read from a Windows checkout
 *   (core.autocrlf=true) and an LF checkout comes back from the Read tool with
 *   different line endings while being the same content. Without it the R2
 *   digest would answer "which checkout" instead of "which content", which is
 *   the line-ending dependence a stamp has shown before. The cost, stated:
 *   two responses that differ ONLY in CRLF vs LF digest the same. `bytes` is
 *   measured after normalization for the same reason, so it is not the raw
 *   size the tool emitted.
 *
 * THE ERROR FLAG
 *   Copied from the host's own signal, never inferred from content:
 *   `is_error` or `isError` (boolean) wins; then a boolean `error`; then a
 *   non-empty string or object `error` means true; then an HTTP-shaped
 *   `status`/`statusCode`. Nothing recognizable gives null, which reads "no
 *   signal", NOT "succeeded". Grepping stderr for the word "error" would be
 *   judging content, which is the meter's job, not the witness's.
 *
 * PRIVACY
 *   No response content, no prefix, no excerpt, no field name from the
 *   response is ever returned. Two things DO leave: the size (bytes), and a
 *   digest that is dictionary-reversible when the response is short or
 *   guessable (a "yes", a 6-digit code, a known file). That second property is
 *   shared with paramsDigest and is recorded, not solved, here: a keyed digest
 *   would close it and would also stop two installs comparing digests.
 */

import crypto from 'node:crypto';
import { canonicalize } from '../parser/index.js';

export const TOOLIO_SCHEMA = 'toolio/1';

/**
 * Replace CRLF with LF in every string leaf, recursively. Keys untouched.
 * Returns a new structure; the caller's value is never mutated.
 * @param {*} value
 * @returns {*}
 */
function normalizeLineEndings(value) {
  if (typeof value === 'string') return value.replace(/\r\n/g, '\n');
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalizeLineEndings);
  const out = {};
  for (const k of Object.keys(value)) out[k] = normalizeLineEndings(value[k]);
  return out;
}

/**
 * The toolio/1 canonical text of a response, or null when there is none.
 * Exported for tests and for any later reader that needs to recompute a
 * digest from a response it holds legitimately (the meter's evals).
 * @param {*} toolResponse
 * @returns {string|null}
 */
export function canonicalResponseText(toolResponse) {
  if (toolResponse === undefined || toolResponse === null) return null;
  let text;
  try {
    text = JSON.stringify(canonicalize(normalizeLineEndings(toolResponse)));
  } catch (_) {
    // Circular structure (RangeError from the recursion) or BigInt (TypeError
    // from JSON.stringify). Either way there is no canonical form.
    return null;
  }
  // JSON.stringify returns undefined for a bare function or symbol.
  return typeof text === 'string' ? text : null;
}

/**
 * The host's own error signal, tri-state. See THE ERROR FLAG above.
 * @param {*} toolResponse
 * @returns {boolean|null}
 */
export function reportedError(toolResponse) {
  if (toolResponse === null || typeof toolResponse !== 'object' || Array.isArray(toolResponse)) {
    return null;
  }
  if (typeof toolResponse.is_error === 'boolean') return toolResponse.is_error;
  if (typeof toolResponse.isError === 'boolean') return toolResponse.isError;
  const err = toolResponse.error;
  if (typeof err === 'boolean') return err;
  if (typeof err === 'string') return err.length > 0 ? true : null;
  if (err !== null && typeof err === 'object') return true;
  for (const key of ['status', 'statusCode']) {
    const s = toolResponse[key];
    if (typeof s === 'number' && s >= 100 && s < 600) return !(s >= 200 && s < 400);
  }
  return null;
}

/**
 * Build the `toolIo` object a post-tool-use receipt embeds. Pure: no I/O, no
 * clock, no randomness, so the same response always yields the same object.
 * @param {*} toolResponse - the host payload's tool_response, as parsed
 * @returns {{schema: string, response: object}}
 */
export function describeToolResponse(toolResponse) {
  if (toolResponse === undefined) {
    return { schema: TOOLIO_SCHEMA, response: { recorded: false, reason: 'absent' } };
  }
  if (toolResponse === null) {
    return { schema: TOOLIO_SCHEMA, response: { recorded: false, reason: 'null' } };
  }
  const text = canonicalResponseText(toolResponse);
  if (text === null) {
    return { schema: TOOLIO_SCHEMA, response: { recorded: false, reason: 'unserializable' } };
  }
  const bytes = Buffer.from(text, 'utf8');
  return {
    schema: TOOLIO_SCHEMA,
    response: {
      recorded: true,
      digest: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      error: reportedError(toolResponse)
    }
  };
}
