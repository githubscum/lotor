/*
 * src/reach/ollama-chat.js
 *
 * V3-05 wiring: perform an Ollama /api/chat call and return the reach
 * report alongside the response body, so a caller can never believe a
 * rung it did not get. Reach is computed from the response, never the
 * request.
 *
 * The measured reason this lane exists: Ollama cloud models drop R4
 * silently with HTTP 200 (2026-10-18 measurement): the response carries
 * no logprobs field while the caller believes it was granted. The reach
 * report in the returned `record` makes that drop loud.
 *
 * The record holds no text (no message content, no thinking text, no
 * tool call arguments, no token text), only shapes and digests.
 * (reach.logprobs is already digest-only.) It also holds no credentials:
 * userinfo in the host URL is redacted before storage, including in a
 * thrown fetch error message, which Node quotes the whole URL from. A
 * failed call is loud, never silent: a non-2xx without a body error
 * string becomes `{ error: 'http <status>' }`, and a thrown fetch
 * becomes `{ error: 'fetch: <message>' }` with userinfo redacted.
 *
 * Writing the record to the chain is a core change and is not done here;
 * this adapter only performs the call and returns the report.
 */

import { reachReport } from './index.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Redact a host string before it is stored on the record. The record
 * must never hold credentials, so userinfo in a URL (user:password@)
 * never reaches it: a parseable URL contributes only its origin, which
 * cannot carry userinfo. The fetch still uses the original host.
 */
function redactHost(host) {
  try {
    return new URL(host).origin;
  } catch {
    return 'unparseable-host';
  }
}

/**
 * Redact userinfo (user:password@) out of free text. Node's fetch
 * throws on a URL that includes credentials and its error message
 * quotes the whole URL, so a raw err.message would carry the password
 * into the record. This strips the authority portion of any URL found
 * in the text, keeping scheme, host and path.
 */
function redactUserinfo(text) {
  return String(text).replace(/\/\/[^\/@\s]*@/g, '//');
}

/**
 * Perform one Ollama /api/chat call and observe which reach rungs the
 * response actually reached.
 * @param {object} request - the request body to send; `stream` is forced off
 * @param {object} [options] - host, fetchImpl, now
 * @returns {Promise<{status: number|null, body: object|null, reach: object, record: object}>}
 */
export async function chatWithReach(
  request,
  { host = 'http://127.0.0.1:11434', fetchImpl = globalThis.fetch, now = () => new Date().toISOString() } = {}
) {
  if (!isPlainObject(request)) throw new TypeError('request must be an object');

  let status = null;
  let body = null;
  try {
    const response = await fetchImpl(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, stream: false })
    });
    status = response.status;
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (status < 200 || status >= 300) {
      const hasError = isPlainObject(body) && typeof body.error === 'string';
      if (!hasError) body = { error: 'http ' + status };
    }
  } catch (err) {
    // Network down: the call failed loudly, not the model's fault, so
    // report the failure instead of throwing.
    body = { error: 'fetch: ' + redactUserinfo(err.message) };
    status = null;
  }

  const reach = reachReport(request, body);

  const record = {
    kind: 'reach.ollama-chat',
    at: now(),
    host: redactHost(host),
    model: request.model ?? null,
    status,
    requested: reach.requested,
    observed: reach.observed,
    silentlyDropped: reach.silentlyDropped,
    deepest: reach.deepest,
    error: reach.error,
    r3Sources: reach.r3Sources,
    logprobs: reach.logprobs
  };

  return { status, body, reach, record };
}