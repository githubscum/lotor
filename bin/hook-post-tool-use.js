#!/usr/bin/env node
/**
 * bin/hook-post-tool-use.js
 *
 * Claude Code `PostToolUse` hook target. Records an attestation for
 * egress-shaped tool calls after the host has observed both the
 * `tool_input` and the `tool_response`. This is a real step toward
 * capturing what actually left the machine, but it is NOT wire-level:
 * we trust what the host reports about the tool's outcome, and we
 * only digest content (never store raw params or raw responses).
 *
 * STDIN CONTRACT
 *   Reads one JSON object from stdin. Required field: `tool_name`.
 *   `tool_input` (object) and `tool_response` (anything) are optional
 *   but expected for real firings. A payload can also be passed
 *   positionally as argv[2] for manual testing, which takes precedence
 *   and makes stdin optional.
 *
 * OUTPUT CONTRACT
 *   Nothing is ever written to stdout: the hook system may interpret
 *   stdout. All diagnostics go to stderr, one line each.
 *
 * EXIT-0-ALWAYS RULE
 *   `PostToolUse` cannot block a completed tool call, so there is no
 *   exit-2 path here. Every failure mode (no stdin, malformed JSON,
 *   missing fields, engine error, store I/O failure) is caught,
 *   reported on stderr, and exits 0. There is no non-zero exit path.
 *
 * PRIVACY
 *   The receipt stores only digests of `tool_input` and `tool_response`.
 *   Raw content is never written to the chain. This is the same
 *   posture every other receipt in this repo follows.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../src/store/index.js';
import { resolveHome } from '../src/home.js';
import {
  isEgressOther,
  isPushForce,
  isPushProtected,
  isPublish
} from '../src/policy/index.js';

const STDIN_TIMEOUT_MS = 5000;

function note(message) {
  process.stderr.write(`lotor hook-post-tool-use: ${message}\n`);
}

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let done = false;
    const chunks = [];
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(chunks.join(''));
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/**
 * Parse and minimally validate the hook payload.
 * @param {string} raw
 * @returns {{ok: true, toolName: string, toolInput: object, toolResponse: any}
 *          | {ok: false, reason: string}}
 */
function parsePayload(raw) {
  if (!raw || raw.trim() === '') return { ok: false, reason: 'empty stdin' };
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `stdin was not valid JSON (${e.message})` };
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'stdin JSON was not an object' };
  }
  const toolName = payload.tool_name;
  if (typeof toolName !== 'string' || toolName.trim() === '') {
    return { ok: false, reason: 'payload missing tool_name' };
  }
  const toolInput = payload.tool_input;
  let toolInputObj = {};
  if (toolInput !== undefined && toolInput !== null) {
    if (typeof toolInput !== 'object' || Array.isArray(toolInput)) {
      return { ok: false, reason: 'payload tool_input is not an object' };
    }
    toolInputObj = toolInput;
  }
  return { ok: true, toolName, toolInput: toolInputObj, toolResponse: payload.tool_response };
}

/**
 * Deterministic short digest of the tool input. Empty input -> 'empty'.
 * @param {object} toolInput
 * @returns {string}
 */
function digestParams(toolInput) {
  if (!toolInput || Object.keys(toolInput).length === 0) return 'empty';
  const text = JSON.stringify(toolInput);
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Deterministic short digest of the tool response. Missing / null /
 * undefined -> 'empty'. Anything else is JSON-stringified first so the
 * digest is stable across shape changes.
 * @param {any} toolResponse
 * @returns {string}
 */
function digestResponse(toolResponse) {
  if (toolResponse === undefined || toolResponse === null) return 'empty';
  if (typeof toolResponse === 'string' && toolResponse === '') return 'empty';
  let text;
  try {
    text = JSON.stringify(toolResponse);
  } catch (e) {
    // Should not happen for normal MCP responses, but be defensive.
    text = String(toolResponse);
  }
  if (text === undefined || text === null || text === '') return 'empty';
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Best-effort boolean extraction from a tool response. Looks for a few
 * obvious success/error signals: an `is_error` field (Claude Code's
 * tool-result convention), an `error` field, or an HTTP-status-shaped
 * top-level field. Returns null when no signal is recognizable.
 * @param {any} toolResponse
 * @returns {boolean|null}
 */
function responseOk(toolResponse) {
  if (toolResponse === undefined || toolResponse === null) return null;
  if (typeof toolResponse === 'object' && !Array.isArray(toolResponse)) {
    if (typeof toolResponse.is_error === 'boolean') return !toolResponse.is_error;
    if (typeof toolResponse.isError === 'boolean') return !toolResponse.isError;
    if (typeof toolResponse.error !== 'undefined' && toolResponse.error !== null) return false;
    if (typeof toolResponse.status === 'number' && toolResponse.status >= 100 && toolResponse.status < 600) {
      return toolResponse.status >= 200 && toolResponse.status < 400;
    }
    if (typeof toolResponse.statusCode === 'number' && toolResponse.statusCode >= 100 && toolResponse.statusCode < 600) {
      return toolResponse.statusCode >= 200 && toolResponse.statusCode < 400;
    }
    return null;
  }
  return null;
}

/**
 * Decide which egress-shaped rule this tool call hits, if any. The
 * matchers are reused from src/policy/index.js unchanged. Returns the
 * matching ruleId or null.
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {string|null}
 */
function matchEgress(toolName, toolInput) {
  if (toolName !== 'Bash') return null;
  if (isPushForce(toolInput)) return 'push-force';
  if (isPushProtected(toolInput)) return 'push-protected';
  if (isPublish(toolInput)) return 'publish';
  if (isEgressOther(toolInput)) return 'egress-other';
  return null;
}

function probePolicyReadable(home) {
  const policyPath = path.join(home, 'policy.json');
  if (!fs.existsSync(policyPath)) return { ok: true };
  let st;
  try {
    st = fs.statSync(policyPath);
  } catch (e) {
    return { ok: false, reason: `policy.json stat failed (${e.message})` };
  }
  if (!st.isFile()) return { ok: false, reason: 'policy.json is not a regular file' };
  let text;
  try {
    text = fs.readFileSync(policyPath, 'utf8');
  } catch (e) {
    return { ok: false, reason: `policy.json unreadable (${e.message})` };
  }
  try {
    JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `policy.json malformed (${e.message})` };
  }
  return { ok: true };
}

function tryAppendReceipt(home, payload) {
  try {
    const store = createStore(home);
    store.appendReceipt(payload);
    return true;
  } catch (e) {
    note(`receipt append failed (${e.message}); continuing`);
    return false;
  }
}

async function main() {
  let home;
  try {
    home = resolveHome();
  } catch (e) {
    note(`could not resolve LOTOR_HOME (${e.message}); no chain write`);
    return;
  }

  const argPayload = process.argv[2];
  const stdinText = argPayload != null ? '' : await readStdin();
  const raw = (typeof argPayload === 'string' && argPayload !== '') ? argPayload : stdinText;

  const parsed = parsePayload(raw);
  if (!parsed.ok) {
    note(`${parsed.reason}; no chain write`);
    return;
  }
  const { toolName, toolInput, toolResponse } = parsed;

  const ruleId = matchEgress(toolName, toolInput);
  if (ruleId == null) {
    // Fast path: nothing egress-shaped, no chain I/O.
    return;
  }

  // Engine-error probe before we attempt to write: if policy.json is
  // unreadable or malformed, append a best-effort engine-error receipt
  // (same posture as the PreToolUse hook) and exit 0.
  const policyCheck = probePolicyReadable(home);
  if (!policyCheck.ok) {
    note(`${policyCheck.reason}; appending engine-error receipt`);
    tryAppendReceipt(home, {
      type: 'policy-warn',
      ruleId: 'engine-error',
      tool: toolName,
      paramsDigest: digestParams(toolInput),
      timestamp: Date.now()
    });
    return;
  }

  const receipt = {
    type: 'egress-event',
    ruleId,
    tool: toolName,
    paramsDigest: digestParams(toolInput),
    responseDigest: digestResponse(toolResponse),
    responseOk: responseOk(toolResponse),
    timestamp: Date.now()
  };

  if (!tryAppendReceipt(home, receipt)) {
    return;
  }
  note(`egress: ${ruleId} (${toolName})`);
}

main()
  .catch(e => {
    try {
      note(`unexpected failure (${e && e.message ? e.message : e}); no chain write`);
    } catch (_) {
      // stderr itself failed; there is nothing further to do
    }
  })
  .finally(() => {
    process.exit(0);
  });
