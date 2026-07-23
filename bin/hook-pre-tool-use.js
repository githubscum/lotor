#!/usr/bin/env node
/**
 * bin/hook-pre-tool-use.js
 *
 * Claude Code `PreToolUse` hook target. Enforces Lotor's gated-runs policy
 * (see src/policy/index.js) before each tool call is allowed to run.
 *
 * STDIN CONTRACT
 *   Reads one JSON object from stdin. Required fields: `tool_name` and
 *   `tool_input` (object). `tool_input` may be `{}` for tools that take no
 *   parameters. A payload can also be passed positionally as argv[2] for
 *   manual testing, which takes precedence and makes stdin optional.
 *
 * OUTPUT CONTRACT
 *   Nothing is ever written to stdout: the hook system may interpret stdout.
 *   All diagnostics go to stderr, one line each.
 *
 * EXIT CODES
 *   0  allow the tool call. (default; also used for warn matches and for
 *      any engine error — fail-open on engine error is the locked posture)
 *   2  BLOCK the tool call. Used only when a gate-mode rule matches and no
 *      valid signed token is available in <LOTOR_HOME>/pending-approvals/.
 *      stderr is shown back to the model with the rule id and the exact
 *      canonicalized request the owner must sign.
 *
 * FAIL-OPEN ON ENGINE ERROR
 *   A Lotor bug must not brick every tool call. If policy loading, evaluation,
 *   or chain I/O throws unexpectedly, we log to stderr, append a best-effort
 *   receipt, and exit 0. The exception is the token layer: an invalid,
 *   expired, or replayed token for a gate rule is a DENY (fail closed) — that
 *   is a security check, not an engine error.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createStore } from '../src/store/index.js';
import { resolveHome } from '../src/home.js';
import { loadPolicy, evaluate } from '../src/policy/index.js';
import { verifyApproval, gatedAction } from '../src/gate/index.js';
import { canonicalizeRequest } from '../src/gate/sign.js';

const STDIN_TIMEOUT_MS = 5000;

function note(message) {
  process.stderr.write(`lotor hook-pre-tool-use: ${message}\n`);
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
  const toolInput = payload.tool_input;
  if (typeof toolName !== 'string' || toolName.trim() === '') {
    return { ok: false, reason: 'payload missing tool_name' };
  }
  if (toolInput !== undefined && (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput))) {
    return { ok: false, reason: 'payload tool_input is not an object' };
  }
  return { ok: true, toolName, toolInput: toolInput || {} };
}

function digestParams(toolInput) {
  if (!toolInput || Object.keys(toolInput).length === 0) return 'empty';
  const text = JSON.stringify(toolInput);
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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

function loadTokenFiles(home) {
  const dir = path.join(home, 'pending-approvals');
  ensureDir(dir);
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  return entries
    .filter(name => name.endsWith('.json'))
    .map(name => ({
      name,
      path: path.join(dir, name)
    }));
}

function readTokenFile(tokenPath) {
  try {
    const text = fs.readFileSync(tokenPath, 'utf8');
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function deleteTokenFile(tokenPath) {
  try {
    fs.unlinkSync(tokenPath);
  } catch (e) {
    // best-effort
  }
}

/**
 * Try every token in pending-approvals/; the first one that validates
 * (and whose nonce is not already used) wins. Returns:
 *   - { token, tokenFile } on success
 *   - { rejected: { reason } } if a token was found but failed verification
 *     (e.g. nonce reuse, signature failure). The caller must treat this
 *     as a deny with the specific reason — fail-closed at the token layer.
 *   - null if no token files were present at all
 * Never writes a nonce — the caller hands the winning token to gatedAction,
 * which records the nonce exactly once.
 */
function findValidToken(actionRequest, home) {
  const candidates = loadTokenFiles(home);
  if (candidates.length === 0) return null;
  for (const cand of candidates) {
    const token = readTokenFile(cand.path);
    if (token == null) continue;
    let result;
    try {
      result = verifyApproval(actionRequest, token, home);
    } catch (e) {
      // Treat exception as a verification failure; move on to the next file.
      continue;
    }
    if (result && result.valid) {
      return { token, tokenFile: cand.path };
    }
    // Token was present but invalid. Return the first rejection with its
    // specific reason so the caller can fail closed with the right receipt.
    if (result && !result.valid) {
      return { rejected: { reason: result.reason || 'token invalid', tokenFile: cand.path } };
    }
  }
  return null;
}

function buildDenialMessage(ruleId, actionRequest, home) {
  const canonical = canonicalizeRequest(actionRequest);
  const outDir = path.join(home, 'pending-approvals');
  const lines = [
    `Lotor: rule "${ruleId}" requires owner approval.`,
    `Sign the exact canonicalized request below, then write the resulting`,
    `token JSON to <LOTOR_HOME>/pending-approvals/<name>.json.`,
    ``,
    `Action request (canonicalized):`,
    canonical,
    ``,
    `To approve, the owner runs (in a real terminal, with the same LOTOR_HOME):`,
    `  npm run approve -- --action-file <f> --out ${path.join(outDir, '<name>.json')}`,
    ``,
    `Substitute <f> with a file containing the action request above (any JSON`,
    `form that canonicalizes to the same string works).`
  ];
  return lines.join('\n');
}

async function main() {
  let home;
  try {
    home = resolveHome();
  } catch (e) {
    note(`could not resolve LOTOR_HOME (${e.message}); allowing`);
    process.exit(0);
  }

  const argPayload = process.argv[2];
  const stdinText = argPayload != null ? '' : await readStdin();
  const raw = (typeof argPayload === 'string' && argPayload !== '') ? argPayload : stdinText;

  const parsed = parsePayload(raw);
  if (!parsed.ok) {
    note(`${parsed.reason}; allowing`);
    process.exit(0);
  }
  const { toolName, toolInput } = parsed;

  // Probe for a known-bad policy file BEFORE loading. If the user has a
  // policy.json that the engine cannot honor (directory, symlink loop,
  // permission denied, malformed JSON, etc.), treat that as an engine
  // error and fail open: allow the call, log to stderr. Doing this before
  // loadPolicy means loadPolicy's own graceful fallback does not mask the
  // situation — the operator sees the warning AND the call is allowed.
  let engineDegraded = false;
  try {
    const policyPath = path.join(home, 'policy.json');
    if (fs.existsSync(policyPath)) {
      const st = fs.statSync(policyPath);
      if (!st.isFile()) {
        note(`policy.json exists but is not a regular file; allowing (engine degraded)`);
        engineDegraded = true;
      } else {
        let text;
        try {
          text = fs.readFileSync(policyPath, 'utf8');
        } catch (e) {
          note(`policy.json is not readable (${e.message}); allowing (engine degraded)`);
          engineDegraded = true;
        }
        if (text !== undefined) {
          try {
            JSON.parse(text);
          } catch (e) {
            note(`policy.json is malformed (${e.message}); allowing (engine degraded)`);
            engineDegraded = true;
          }
        }
      }
    }
  } catch (e) {
    note(`policy probe failed (${e.message}); allowing (engine degraded)`);
    engineDegraded = true;
  }

  if (engineDegraded) {
    // Best-effort engine-error receipt for visibility, then fail open.
    tryAppendReceipt(home, {
      type: 'policy-warn',
      ruleId: 'engine-error',
      tool: toolName,
      paramsDigest: digestParams(toolInput),
      timestamp: Date.now()
    });
    process.exit(0);
  }

  // Load the (known-good) policy. loadPolicy() never throws; it falls back
  // to defaults on I/O/parse issues. Belt-and-braces: still wrap.
  let policy;
  try {
    policy = loadPolicy(home);
  } catch (e) {
    note(`could not load policy (${e.message}); allowing`);
    tryAppendReceipt(home, {
      type: 'policy-warn',
      ruleId: 'engine-error',
      tool: toolName,
      paramsDigest: digestParams(toolInput),
      timestamp: Date.now()
    });
    process.exit(0);
  }

  // Evaluate. evaluate() itself shouldn't throw, but wrap for fail-open.
  let match;
  try {
    match = evaluate(toolName, toolInput, policy, home);
  } catch (e) {
    note(`evaluator crashed (${e.message}); allowing`);
    tryAppendReceipt(home, {
      type: 'policy-warn',
      ruleId: 'engine-error',
      tool: toolName,
      paramsDigest: digestParams(toolInput),
      timestamp: Date.now()
    });
    process.exit(0);
  }

  if (match == null) {
    // Fast path: no rule matched, no chain I/O.
    process.exit(0);
  }

  const { ruleId, mode } = match;
  const paramsDigest = digestParams(toolInput);

  if (mode === 'warn') {
    tryAppendReceipt(home, {
      type: 'policy-warn',
      ruleId,
      tool: toolName,
      paramsDigest,
      timestamp: Date.now()
    });
    note(`warn: ${ruleId} (${toolName})`);
    process.exit(0);
  }

  if (mode === 'gate') {
    // Sign only the parameters that carry security meaning. `description`
    // and `timeout` are authored by the agent and mean nothing to the gate,
    // but including them made every token brittle: the owner had to know the
    // agent's exact prose in advance, and the agent could void an approval by
    // rewording. Both push toward signing without reading, which is worse
    // than not signing at all. Everything is still recorded in the receipt;
    // this narrows only what the signature is bound to.
    const SIGNED_PARAMS = ['command', 'file_path', 'url', 'path'];
    const signedInput = {};
    for (const k of SIGNED_PARAMS) {
      if (toolInput && toolInput[k] !== undefined) signedInput[k] = toolInput[k];
    }
    const actionRequest = { action: toolName, params: signedInput };
    const tokenResult = findValidToken(actionRequest, home);

    if (tokenResult == null) {
      // No token at all -> deny.
      const store = createStore(home);
      const chain = {
        entries: store.entries,
        append: store.appendReceipt.bind(store)
      };
      try {
        gatedAction(actionRequest, null, chain, home);
      } catch (e) {
        note(`denial receipt failed (${e.message}); still denying`);
      }
      note(`BLOCKED: ${ruleId} (${toolName}) — no valid token`);
      process.stderr.write(buildDenialMessage(ruleId, actionRequest, home) + '\n');
      process.exit(2);
    }

    if (tokenResult.rejected) {
      // Token was presented but failed verification (e.g. replay, signature
      // failure). Fail closed: pass the token to gatedAction so the denial
      // receipt records the specific reason.
      const store = createStore(home);
      const chain = {
        entries: store.entries,
        append: store.appendReceipt.bind(store)
      };
      try {
        // We need the token object to pass to gatedAction. The file is
        // still on disk; re-read it.
        const token = readTokenFile(tokenResult.rejected.tokenFile);
        gatedAction(actionRequest, token || null, chain, home);
      } catch (e) {
        note(`denial receipt failed (${e.message}); still denying`);
      }
      // Delete the bad token so it does not get re-evaluated on every
      // subsequent tool call.
      try { fs.unlinkSync(tokenResult.rejected.tokenFile); } catch (_) { /* best-effort */ }
      note(`BLOCKED: ${ruleId} (${toolName}) — ${tokenResult.rejected.reason}`);
      process.stderr.write(buildDenialMessage(ruleId, actionRequest, home) + '\n');
      process.exit(2);
    }

    // Token validated by verifyApproval; hand it to gatedAction to record
    // the nonce and append the approval receipt. If the action is somehow
    // denied at this layer (replay race, etc.), treat as deny.
    const store = createStore(home);
    const chain = {
      entries: store.entries,
      append: store.appendReceipt.bind(store)
    };
    let result;
    try {
      result = gatedAction(actionRequest, tokenResult.token, chain, home);
    } catch (e) {
      note(`gate check crashed (${e.message}); denying`);
      process.stderr.write(buildDenialMessage(ruleId, actionRequest, home) + '\n');
      process.exit(2);
    }
    if (result.decision === 'approved') {
      deleteTokenFile(tokenResult.tokenFile);
      note(`approved: ${ruleId} (${toolName})`);
      process.exit(0);
    }
    // Token was presented but rejected (e.g. nonce race). Deny.
    note(`BLOCKED: ${ruleId} (${toolName}) — ${result.reason || 'token invalid'}`);
    process.stderr.write(buildDenialMessage(ruleId, actionRequest, home) + '\n');
    process.exit(2);
  }

  // Unknown mode for a matched rule — treat as warn (defensive default).
  note(`unknown mode "${mode}" for ${ruleId}; treating as warn`);
  tryAppendReceipt(home, {
    type: 'policy-warn',
    ruleId,
    tool: toolName,
    paramsDigest,
    timestamp: Date.now()
  });
  process.exit(0);
}

main()
  .catch(e => {
    try {
      note(`unexpected failure (${e && e.message ? e.message : e}); allowing`);
    } catch (_) {
      // stderr itself failed; there is nothing further to do
    }
    process.exit(0);
  });
