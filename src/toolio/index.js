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
 *     { schema: 'toolio/1', hash: <16 hex>,
 *       response: { recorded: true, digest: <64 hex>, bytes: <int>,
 *                   error: true | false | null } }
 *
 *   Unrecorded (no digest field AT ALL, never an empty or sentinel digest):
 *
 *     { schema: 'toolio/1', hash: <16 hex>,
 *       response: { recorded: false, reason: 'absent' | 'null' | 'unserializable' } }
 *
 *   'absent' means the host payload had no tool_response. 'null' means the host
 *   sent tool_response: null. 'unserializable' means a value was there and has
 *   no exact JSON form (see THE CANONICAL FORM, step 0). In every one of those
 *   the honest reading is "Lotor did not see what came back", which is a
 *   different fact from "the tool returned nothing". A tool that returned an
 *   empty string or an empty object IS recorded, with the digest of `""` or
 *   `{}`, because an empty answer is still an answer.
 *
 * THE CODE STAMP (`hash`)
 *   `schema` names the method; `hash` names the code that ran it, the same pair
 *   the session-start receipt carries as `parser: { schema, hash }`. It is the
 *   first 16 hex of SHA-256 over the source text of every function in this
 *   module that shapes the record (toolioVersionHash below). An edit to any of
 *   them moves the stamp even if nobody remembers to bump the schema, so two
 *   `toolio/1` entries made by different code are told apart on the chain.
 *   Unlike matcherHash and parserVersionHash, the source text has CRLF folded
 *   to LF before hashing, so a CRLF checkout and an LF checkout of the same
 *   commit stamp the same.
 *
 * THE toolio/1 CANONICAL FORM (bump the marker if any of this changes)
 *   0. The value must have an exact JSON form, or it is 'unserializable'.
 *      Rejected anywhere in the tree: undefined, a function, a symbol, a
 *      BigInt, NaN or an infinity, an array hole, a symbol-keyed property, an
 *      object whose prototype is neither Object.prototype nor null (a Date, a
 *      Map, a class instance: anything whose JSON.stringify output is not its
 *      own keys), and a cycle. Each of these is something JSON.stringify would
 *      silently drop, null out or substitute, so two different values would
 *      share a digest. A value from JSON.parse never trips this.
 *   1. Every STRING LEAF has each CRLF ("\r\n") replaced by LF ("\n"). A lone
 *      CR is left alone: it is content (progress bars, old Mac files), not a
 *      line ending. Object KEYS are not rewritten.
 *   2. Object keys sorted at every depth, arrays kept in order. Built into
 *      null-prototype objects, so an own "__proto__" key (which JSON.parse
 *      creates) is kept as data instead of being swallowed by the inherited
 *      setter. Byte-identical to the params/1 canonicalizer in
 *      src/parser/index.js for every value without such a key; deliberately
 *      not that function, whose object-literal pattern drops the key (see
 *      KNOWN-LIMITS 78) and whose output is pinned on gate receipts already.
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
 *   PRECEDENCE OVER THE LEGACY responseOk. The egress-event receipt also
 *   carries `responseOk`, computed in bin/hook-post-tool-use.js. It treats ANY
 *   `error` key that is not undefined or null as failure, so it reads
 *   `error: false`, `error: ''` and `error: 0` as "not ok", where this module
 *   reads false, null and null. On those inputs one signed receipt carries two
 *   readings that disagree. When `toolIo.response.recorded` is true, `toolIo`
 *   is authoritative: `error === false` means the host said it succeeded,
 *   `error === true` that it failed, `null` that it said nothing a reader can
 *   use. `responseOk` is kept only so older readers keep working. On every
 *   other input the two agree (`responseOk === !error`, or both null), and
 *   test/hook-post-tool-use-toolio.test.js holds both halves of that against
 *   the real hook. Tightening responseOk is a core edit and is not staged.
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

export const TOOLIO_SCHEMA = 'toolio/1';

/**
 * Steps 0 to 2 of the canonical form in one walk: reject anything without an
 * exact JSON form, fold CRLF in string leaves, sort keys into null-prototype
 * objects. Returns a new structure; the caller's value is never mutated.
 * Throws a TypeError on anything step 0 rejects.
 * @param {*} value
 * @param {Set<object>} ancestors - the objects on the current path (cycle check)
 * @returns {*}
 */
function canonicalValue(value, ancestors) {
  switch (typeof value) {
    case 'string':
      return value.replace(/\r\n/g, '\n');
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('toolio/1: non-finite number');
      return value;
    case 'object':
      break;
    default:
      // undefined, function, symbol, bigint: JSON drops, nulls or throws.
      throw new TypeError(`toolio/1: a ${typeof value} has no JSON form`);
  }
  if (value === null) return null;
  if (ancestors.has(value)) throw new TypeError('toolio/1: circular structure');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const out = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) throw new TypeError('toolio/1: array hole');
        out[i] = canonicalValue(value[i], ancestors);
      }
      return out;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('toolio/1: not a plain object');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('toolio/1: symbol-keyed property');
    }
    const out = Object.create(null);
    for (const k of Object.keys(value).sort()) out[k] = canonicalValue(value[k], ancestors);
    return out;
  } finally {
    ancestors.delete(value);
  }
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
    text = JSON.stringify(canonicalValue(toolResponse, new Set()));
  } catch (_) {
    // Step 0 rejected something. There is no canonical form.
    return null;
  }
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
  const hash = toolioVersionHash();
  if (toolResponse === undefined) {
    return { schema: TOOLIO_SCHEMA, hash, response: { recorded: false, reason: 'absent' } };
  }
  if (toolResponse === null) {
    return { schema: TOOLIO_SCHEMA, hash, response: { recorded: false, reason: 'null' } };
  }
  const text = canonicalResponseText(toolResponse);
  if (text === null) {
    return { schema: TOOLIO_SCHEMA, hash, response: { recorded: false, reason: 'unserializable' } };
  }
  const bytes = Buffer.from(text, 'utf8');
  return {
    schema: TOOLIO_SCHEMA,
    hash,
    response: {
      recorded: true,
      digest: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      error: reportedError(toolResponse)
    }
  };
}

let cachedToolioHash = null;

/**
 * The code stamp. See THE CODE STAMP above. Pure, in-memory, cached after the
 * first call in a process. Covers every function that shapes the record,
 * including the stamp's own definition, so the list cannot quietly shrink.
 * @returns {string} 16 lowercase hex chars
 */
export function toolioVersionHash() {
  if (cachedToolioHash) return cachedToolioHash;
  const parts = [
    TOOLIO_SCHEMA,
    canonicalValue.toString(),
    canonicalResponseText.toString(),
    reportedError.toString(),
    describeToolResponse.toString(),
    toolioVersionHash.toString()
  ].map(s => s.replace(/\r\n/g, '\n'));
  cachedToolioHash = crypto.createHash('sha256')
    .update(parts.join('\n'))
    .digest('hex')
    .slice(0, 16);
  return cachedToolioHash;
}
