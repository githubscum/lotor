/*
 * src/reach/index.js
 *
 * Lane V3-05 of the v3 spec: observe which rungs of the reach ladder an
 * Ollama /api/chat response actually reached. Reach is computed from what
 * came back, never from what was asked. The request is consulted only to
 * build the `requested` list in reachReport, and `observed` is identical
 * for the same body regardless of what the caller requested.
 *
 * The measured reason this lane exists: Ollama cloud models return HTTP 200
 * with no `logprobs` field when logprobs are requested (2026-10-18
 * measurement), so R4 silently drops while the caller believes it was
 * granted; and `think:false` does not stop reasoning appearing in content.
 * glm-5.3-flash ended content with a stray `</think>`,
 * meaning reasoning leaked into the answer channel even with thinking
 * nominally off.
 */

import crypto from 'node:crypto';

export const RUNG_ORDER = Object.freeze(['R0', 'R1', 'R3', 'R4']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonWhitespaceString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function canonicalTopLogprobs(entry) {
  if (!Array.isArray(entry.top_logprobs)) return [];
  return entry.top_logprobs.map(x => ({ t: x.token, l: x.logprob }));
}

/**
 * R4 logprob digest. Hashes only shapes derived from the response. Token
 * text never appears in the returned object, since tokens may contain
 * secrets; only their hashed image does.
 */
function logprobsDigest(entries) {
  const shape = entries.map(e => ({
    t: e.token,
    l: e.logprob,
    top: canonicalTopLogprobs(e)
  }));
  const hex = crypto.createHash('sha256')
    .update(JSON.stringify(shape))
    .digest('hex');
  return 'sha256:' + hex;
}

/**
 * Observe the reach rungs from a parsed Ollama /api/chat non-stream
 * response body. Pure function of the body alone.
 * @param {object|null} body - the parsed response body
 */
export function observeRungs(body) {
  const base = {
    model: null,
    error: null,
    rungs: { R0: false, R1: false, R3: false, R4: false },
    r3Sources: [],
    logprobs: null
  };

  if (!isPlainObject(body)) return base;

  const error = typeof body.error === 'string' ? body.error : null;

  // An error body is the final word, even if it also carries message or
  // logprobs fields: nothing was reached, and nothing is reported reached.
  if (error !== null) {
    return {
      model: body.model ?? null,
      error,
      rungs: { R0: false, R1: false, R3: false, R4: false },
      r3Sources: [],
      logprobs: null
    };
  }

  const message = isPlainObject(body.message) ? body.message : {};

  // R0: content is a string with non-whitespace characters.
  const hasContent = isNonWhitespaceString(message.content);

  // R1: tool_calls is an array with length > 0.
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;

  // R3: visible reasoning, via channel or marker. Sources in fixed order.
  const r3Sources = [];
  if (isNonWhitespaceString(message.thinking)) {
    r3Sources.push('thinking');
  }
  if (typeof message.content === 'string' &&
      (message.content.includes('<think>') || message.content.includes('</think>'))) {
    r3Sources.push('content-markers');
  }

  // R4: every logprobs entry carries a finite numeric logprob; any
  // violation means the rung is false and the data is withheld entirely.
  let logprobs = null;
  const lp = body.logprobs;
  const lpValid = Array.isArray(lp) && lp.length > 0 &&
    lp.every(e => isPlainObject(e) && isFiniteNumber(e.logprob));
  if (lpValid) {
    const values = lp.map(e => e.logprob);
    const count = values.length;
    const minLogprob = Math.min(...values);
    const meanLogprob = values.reduce((sum, v) => sum + v, 0) / count;
    logprobs = {
      count,
      digest: logprobsDigest(lp),
      minLogprob,
      meanLogprob
    };
  }

  return {
    model: body.model ?? null,
    error,
    rungs: {
      R0: hasContent,
      R1: hasToolCalls,
      R3: r3Sources.length > 0,
      R4: lpValid
    },
    r3Sources,
    logprobs
  };
}

/**
 * Build a reach report pairing what was requested with what was observed.
 * `requested` derives from the request object alone; `observed` derives
 * from the response body alone and is identical for the same body
 * regardless of `request`. An error response is loud, not silent, so
 * silentlyDropped is always [] when an error is set.
 * @param {object|null} request - the request object that was sent (may be null)
 * @param {object|null} body - the parsed response body
 */
export function reachReport(request, body) {
  const obs = observeRungs(body);

  const requested = [];
  if (request !== null && typeof request === 'object') {
    requested.push('R0'); // R0 always, when the request is an object
    if (Array.isArray(request.tools) && request.tools.length > 0) requested.push('R1');
    if (request.think === true) requested.push('R3');
    if (request.logprobs === true) requested.push('R4');
  }

  const observed = RUNG_ORDER.filter(r => obs.rungs[r]);

  const silentlyDropped = obs.error !== null
    ? []
    : requested.filter(r => !obs.rungs[r]);

  return {
    model: obs.model,
    error: obs.error,
    requested,
    observed,
    silentlyDropped,
    deepest: observed.length > 0 ? observed[observed.length - 1] : null,
    r3Sources: obs.r3Sources,
    logprobs: obs.logprobs
  };
}