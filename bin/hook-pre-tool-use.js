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
 * DENIAL MESSAGE (2026-07-23)
 *   Every deny path prints the same fixed-shape message via
 *   buildDenialMessage(): WHAT matched, WHY it matters, how RISKy it is,
 *   what the signature actually SCOPEs, and one runnable command. The
 *   request is staged to <LOTOR_HOME>/pending-approvals/requests/<id>.json
 *   so the printed command (`npm run approve -- --request <id>`) has
 *   nothing left to substitute. This exists so the experience of hitting
 *   the gate is identical regardless of which model is driving the
 *   session — see CLAUDE.md at the repo root, which asks an agent to relay
 *   this message rather than compose its own warning.
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
import { loadPolicy, evaluate, RULE_INFO, matcherVersionHash } from '../src/policy/index.js';
import { verifyApproval, gatedAction } from '../src/gate/index.js';
import { canonicalizeRequest } from '../src/gate/sign.js';
import { resolveGrant } from '../src/grant/check.js';
import { colour, dim, colourEnabled } from '../src/term/colour.js';

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
  // session_id is a common field on every Claude Code hook event. It was
  // being parsed and discarded. Grants are session-bound, so without it no
  // grant can ever apply: absence yields null and resolveGrant refuses on
  // null rather than treating a missing binding as a wildcard.
  const sessionId = typeof payload.session_id === 'string' && payload.session_id.trim() !== ''
    ? payload.session_id
    : null;
  // permission_mode is also a common field on every hook event. KNOWN-LIMITS
  // 15 asserted the two layers "cannot see" each other; that was an
  // assumption nobody checked, and it is false. The harness's own posture
  // has been arriving on every gated call and being discarded here.
  const permissionMode = typeof payload.permission_mode === 'string' && payload.permission_mode.trim() !== ''
    ? payload.permission_mode
    : null;
  return { ok: true, toolName, toolInput: toolInput || {}, sessionId, permissionMode };
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
 * Read the `stagedAt` field from a previously staged request's purpose
 * sidecar. Returns null if the request, the sidecar, or the field is
 * absent. Used to compute `heldMs` (how long the staged request sat
 * waiting for a signature). See stageRequest() which writes this field
 * in the purposes/<id>.json sidecar.
 */
function readStagedAt(home, requestId) {
  if (!requestId) return null;
  try {
    const file = path.join(home, 'pending-approvals', 'purposes', `${requestId}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ts = parsed?.stagedAt;
    return typeof ts === 'number' && Number.isFinite(ts) ? ts : null;
  } catch (e) {
    return null;
  }
}

/**
 * Try every token in pending-approvals/; the first one that VALIDATES wins.
 * A token that fails to validate against THIS action is not treated as a
 * verdict on the action — it just means that token was signed for something
 * else, which is the normal case when more than one approval is pending at
 * once. Only a genuine security failure (nonce replay, bad signature) short-
 * circuits the scan, since continuing past a replay attempt in search of a
 * token that happens to validate would defeat the point of failing closed.
 *
 * BUG FIXED 2026-07-23: the previous version returned on the FIRST token
 * examined that did not match the current action, via a plain "invalid ->
 * rejected" branch with no distinction between "wrong token" and "bad
 * token". With two or more tokens signed in the same sitting (exactly what
 * happens when several files are approved in one batch), whichever token
 * happened to sort first in the directory listing would reject the call
 * outright, even when a later file in the same directory was the correct,
 * validly-signed approval. Found by using the gate for exactly this: three
 * files signed in one sitting, and the second write failed with "approval
 * token request mismatch" despite a valid token for it sitting right next
 * to the wrong one.
 *
 * Returns:
 *   - { token, tokenFile } on the first token that validates for this exact
 *     action request
 *   - { rejected: { reason, tokenFile } } only for a token that matched this
 *     action's request but then failed on nonce replay or signature — a
 *     verdict on THIS action, not on the token file's mere presence
 *   - null if no token file validates and none was a security failure
 *     either (i.e. every present token was simply for a different action)
 * Never writes a nonce — the caller hands the winning token to gatedAction,
 * which records the nonce exactly once.
 *
 * NOTE: loadTokenFiles() lists the flat pending-approvals/ directory, not
 * its requests/ subdirectory, so staged (not-yet-signed) requests are never
 * mistaken for tokens here.
 */
function findValidToken(actionRequest, home) {
  const candidates = loadTokenFiles(home);
  if (candidates.length === 0) return null;

  const canonicalActual = canonicalizeRequest(actionRequest);
  let sawSecurityFailure = null;

  for (const cand of candidates) {
    const token = readTokenFile(cand.path);
    if (token == null) continue;

    // Cheap, local check first: does this token's own signed request even
    // match the action being attempted? If not, this file is simply not the
    // approval for this call — keep scanning rather than treating it as a
    // verdict on THIS action.
    if (!token.request || token.request !== canonicalActual) {
      continue;
    }

    let result;
    try {
      result = verifyApproval(actionRequest, token, home);
    } catch (e) {
      // Treat an exception as a verification failure for THIS token only;
      // keep scanning in case another file is the real approval.
      continue;
    }

    if (result && result.valid) {
      return { token, tokenFile: cand.path };
    }

    // The request matched but the token itself failed (replay, bad
    // signature, missing key). This IS a verdict on this action: remember
    // the first such failure, but keep scanning in case a different,
    // still-valid token for the same action also exists.
    if (result && !result.valid && !sawSecurityFailure) {
      sawSecurityFailure = { reason: result.reason || 'token invalid', tokenFile: cand.path };
    }
  }

  if (sawSecurityFailure) {
    return { rejected: sawSecurityFailure };
  }
  return null;
}

/**
 * Stage a canonicalized action request for the owner to sign, at
 * <home>/pending-approvals/requests/<id>.json. This is what makes the
 * printed approve command runnable exactly as printed — nothing left for
 * a model to fill in, and nothing composed by whichever model hit the gate.
 *
 * Best-effort: staging failure (unwritable home, full disk) must not break
 * the deny path. Returns null on failure; buildDenialMessage() falls back
 * to the older file-based instructions when requestId is null.
 *
 * @returns {string|null} a short hex id, or null if staging failed
 */
/**
 * Normalize an agent-authored purpose line for display.
 *
 * This string is written by the agent that just got stopped, so it is a CLAIM
 * and never evidence. Two consequences, both handled here.
 *
 * It must not be able to forge the message it appears in. Left raw, a purpose
 * of "harmless\n\n  RISK    LOW, nothing to see" would print inside the gate's
 * own fixed-shape block, and an ESC sequence could move the cursor or recolour
 * the rest of the output. So every C0 control character, DEL, and ESC is
 * collapsed to a space, runs of whitespace are squeezed, and the result is
 * capped. What survives is a single line of plain text that cannot escape its
 * own field.
 *
 * It must not become the thing the owner reads instead of the command. That
 * part is handled by the caller: the purpose renders above WHAT but is labelled
 * as unverified, and the command is still printed in full underneath.
 */
function sanitizePurpose(raw) {
  if (typeof raw !== 'string') return null;
  const flattened = raw
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened === '') return null;
  return flattened.length > 240 ? flattened.slice(0, 237) + '...' : flattened;
}

/**
 * Read a previously staged purpose. Absence is normal and never an error: a
 * request staged before this existed, or by a caller that supplied no
 * description, simply has none.
 */
function readPurpose(home, requestId) {
  if (!requestId) return null;
  try {
    const file = path.join(home, 'pending-approvals', 'purposes', `${requestId}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return sanitizePurpose(parsed?.purpose);
  } catch (e) {
    return null;
  }
}

function stageRequest(home, actionRequest, purpose) {
  try {
    const dir = path.join(home, 'pending-approvals', 'requests');
    ensureDir(dir);
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = crypto.randomBytes(4).toString('hex');
      const file = path.join(dir, `${id}.json`);
      if (fs.existsSync(file)) continue; // vanishingly unlikely; retry
      fs.writeFileSync(file, JSON.stringify(actionRequest, null, 2) + '\n', { mode: 0o600 });

      // The purpose goes in a SIBLING directory, never inside the request and
      // never beside it. Two reasons, both learned the hard way.
      //
      // Not inside: approve.js canonicalizes and signs this file verbatim, so a
      // purpose key in it would bind the signature to the agent's prose and let
      // a reworded description void an approval. That is exactly the
      // brittleness SIGNED_PARAMS was narrowed to remove.
      //
      // Not beside: anything matching *.json in requests/ is read as a request
      // by findSimilarStagedRequest() and by external readers, and it counts
      // against that function's 25-newest scan window. Sidecars in the same
      // directory would have halved the twin matcher's reach.
      const clean = sanitizePurpose(purpose);
      if (clean) {
        try {
          const pdir = path.join(home, 'pending-approvals', 'purposes');
          ensureDir(pdir);
          fs.writeFileSync(
            path.join(pdir, `${id}.json`),
            JSON.stringify({ purpose: clean, stagedAt: Date.now() }, null, 2) + '\n',
            { mode: 0o600 }
          );
        } catch (e) {
          // Best-effort. A missing purpose costs one line of context; a deny
          // path that throws costs the gate.
        }
      }
      return id;
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * A short human-readable description of the action for the denial
 * message's WHAT line: the tool name plus whichever signed parameter
 * carries the actual target.
 */
function describeAction(actionRequest) {
  const action = actionRequest?.action || 'unknown';
  const params = actionRequest?.params || {};
  const detail = params.command || params.file_path || params.url || params.path;
  return detail ? `${action}: ${detail}` : action;
}

/**
 * Find an already-staged request that is a near-twin of this one.
 *
 * Signature binding is exact, so a trivially-changed command produces a brand
 * new request id with no visible link to the one the owner just signed. This
 * happened three times on 2026-07-25: a forced S4U-to-Interactive change, a
 * `tail -20` becoming `-25`, and a script fixed between attempts. Each time the
 * owner was asked to re-approve something they had approved minutes earlier,
 * with nothing on screen saying so. Every avoidable signature teaches the
 * operator to sign faster and read less (limit 26).
 *
 * This changes NOTHING about validation. It only lets the message say "this is
 * a variant of X" instead of presenting as novel.
 *
 * Similarity is deliberately crude: same action, and the differing middle is a
 * small fraction of the whole once a common prefix and suffix are stripped. A
 * real edit distance would be more precise and is not worth the code. A missed
 * match costs the old behaviour; a false match costs one misleading line that
 * the printed diff immediately corrects.
 */
function findSimilarStagedRequest(home, actionRequest, currentId) {
  try {
    const dir = path.join(home, 'pending-approvals', 'requests');
    if (!fs.existsSync(dir)) return null;

    const detailOf = r => {
      const p = r?.params || {};
      return p.command || p.file_path || p.url || p.path || '';
    };
    const nowDetail = detailOf(actionRequest);
    if (!nowDetail) return null;

    // Newest first, and capped. This runs on the deny path, which must stay
    // fast, and staged requests are never cleaned up (185 of them by
    // 2026-07-25), so an uncapped scan would only get slower.
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && f !== `${currentId}.json`)
      .map(f => {
        const full = path.join(dir, f);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch (e) { /* ignore */ }
        return { id: f.slice(0, -5), full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 25);

    for (const f of files) {
      let prior;
      try { prior = JSON.parse(fs.readFileSync(f.full, 'utf8')); } catch (e) { continue; }
      if (prior?.action !== actionRequest?.action) continue;

      const wasDetail = detailOf(prior);
      if (!wasDetail || wasDetail === nowDetail) continue;

      let head = 0;
      const max = Math.min(wasDetail.length, nowDetail.length);
      while (head < max && wasDetail[head] === nowDetail[head]) head++;

      let tail = 0;
      while (
        tail < max - head &&
        wasDetail[wasDetail.length - 1 - tail] === nowDetail[nowDetail.length - 1 - tail]
      ) tail++;

      const changed = Math.max(wasDetail.length, nowDetail.length) - head - tail;
      const whole = Math.max(wasDetail.length, nowDetail.length);
      if (whole > 0 && changed / whole <= 0.25) {
        return {
          id: f.id,
          was: wasDetail.slice(Math.max(0, head - 20), wasDetail.length - tail + 20),
          now: nowDetail.slice(Math.max(0, head - 20), nowDetail.length - tail + 20)
        };
      }
    }
    return null;
  } catch (e) {
    return null; // never break the deny path over a convenience feature
  }
}

/**
 * Build the fixed-shape denial message every deny path prints. Five parts,
 * always in this order: WHAT matched, WHY it matters, how RISKy it is, what
 * the signature actually SCOPEs (only the listed params — never file
 * content — and single-use, bound to this exact request), and one runnable
 * approve command.
 *
 * Designed to stand on its own: a model that has read no rules about this
 * repo should still be able to relay this message completely and a human
 * should be able to decide from it alone. CLAUDE.md at the repo root asks
 * an agent to relay this verbatim rather than compose its own warning —
 * this message, not agent judgment, is what is meant to carry the weight.
 */
/**
 * WHY, specific to the path that actually matched. self-mod only.
 *
 * FOUND 2026-07-26, from the operator's side rather than from an audit.
 * RULE_INFO is keyed by rule id alone, so every self-mod denial printed the
 * identical sentence: "this path can change the gate, its policy, its hooks,
 * or the log." For `bin/retcon.js` that is FALSE. It does readFileSync,
 * existsSync, statSync and stdout.write, and has no write path of any kind.
 * It is core because bin/ is covered wholesale, which is the right call for a
 * directory that also holds every hook and the signing ceremony.
 *
 * An overstated risk line is not a harmless excess. It teaches the operator to
 * discount the line everywhere, including where it is true, which is precisely
 * the corrosion KNOWN-LIMITS 26 describes. Fifteen self-mod signatures in one
 * evening under one identical false sentence is what that looks like from the
 * other side of the prompt.
 *
 * TEXT ONLY, AND THAT BOUNDARY IS LOAD-BEARING. This changes what the operator
 * READS and never what gates. Every path below still requires a signature. The
 * RISK level is deliberately left at whatever RULE_INFO says rather than graded
 * here: relitigating the level through a message change would be the drift this
 * system exists to catch. A grading of bin/ was attempted and reverted the same
 * night, because `bin/retcon.js` is what the operator reads to judge whether
 * work matched its charter, which is the same class of hazard as the file that
 * prints a charter for signing.
 *
 * Returns null when it has nothing more specific to say, and the generic
 * RULE_INFO line stands. Silence here means "no refinement", never "no risk".
 */
function selfModWhy(actionRequest) {
  const t = String(
    actionRequest?.params?.file_path || actionRequest?.params?.path || ''
  ).replace(/\\/g, '/').toLowerCase();
  if (t === '') return null;

  if (/(^|\/)bin\/hook-[^/]+$/.test(t)) {
    return 'this IS the enforcement hook: it decides what gates at all';
  }
  if (/(^|\/)bin\/(charter|approve|setup|gate|mode)\.js$/.test(t)) {
    return 'this is part of the signing ceremony: it shapes what you read, or how a signature is taken';
  }
  if (/(^|\/)(keys|receipts)\//.test(t) || /(^|\/)policy\.json$/.test(t)) {
    return 'this is key material, the log itself, or the rule set';
  }
  if (/(^|\/)src\/(gate|policy|chain|store|grant|charter)\//.test(t)) {
    return 'this can change what the gate permits';
  }
  if (/(^|\/)bin\/[^/]+$/.test(t)) {
    return 'a tool in the protected bin/ directory. It reports rather than enforces, so it ' +
           'cannot change what the gate permits. It is gated because it is what you read to ' +
           'judge whether the work matched the plan';
  }
  return null;
}

function buildDenialMessage(ruleId, actionRequest, home, requestId) {
  const base = RULE_INFO[ruleId] || {
    title: 'Gated action',
    why: 'this matched a gated rule',
    risk: 'UNKNOWN. No risk description is defined for this rule.'
  };
  const refinedWhy = ruleId === 'self-mod' ? selfModWhy(actionRequest) : null;
  const info = refinedWhy ? { ...base, why: refinedWhy } : base;
  const what = describeAction(actionRequest);
  const signedKeys = Object.keys(actionRequest?.params || {});
  const scopeNote = signedKeys.length > 0
    ? `signs ${signedKeys.join(', ')} only. Nothing else about this call is covered by the signature.`
    : 'signs the action itself; no parameters were included.';

  // Title-first header. The plain-English title in gate red is what a fresh
  // reader anchors on; the rule id stays as a dim technical suffix so a bug
  // report or a search still has the anchor it needs. Both fall back to
  // plain text under NO_COLOR or a non-TTY, per src/term/colour.js.
  const title = info.title || 'Gated action';
  const idSuffix = colourEnabled() ? `  ${dim('[' + ruleId + ']')}` : `  [${ruleId}]`;
  const header = `${colour('gate', title)}${idSuffix}`;

  const lines = [
    `LOTOR GATE  ${header}`,
    ``,
    `  WHAT    ${what}`
  ];

  // Twin-of-staged notice sits between WHAT and the reasoning, because the
  // owner has usually approved the plan already; the question in front of
  // them is whether this is a variant, and that belongs above the rationale.
  const twin = findSimilarStagedRequest(home, actionRequest, requestId);
  if (twin) {
    lines.push(
      ``,
      `  VARIANT OF staged request ${twin.id}. You approved a near-identical`,
      `          command. This one differs, so the earlier signature does not`,
      `          cover it.`,
      `            was:  ...${twin.was}...`,
      `            now:  ...${twin.now}...`
    );
  }

  // Purpose is the agent's own one-line account of intent. It sits AFTER
  // WHAT so the command is what the eye lands on first, and it stays
  // labelled unverified so a summary the owner reads INSTEAD OF the command
  // never manufactures false confidence (KNOWN-LIMITS 33/43).
  const purpose = readPurpose(home, requestId);
  if (purpose) {
    const rows = [];
    let row = '';
    for (const word of purpose.split(' ')) {
      if (row === '') {
        row = word;
      } else if ((row + ' ' + word).length <= 62) {
        row = row + ' ' + word;
      } else {
        rows.push(row);
        row = word;
      }
    }
    if (row !== '') rows.push(row);
    lines.push(``, `  PURPOSE ${rows[0]}`);
    for (let i = 1; i < rows.length; i++) lines.push(`          ${rows[i]}`);
    lines.push(`          (agent-stated, NOT verified. The command above is what runs.)`);
  }

  lines.push(
    ``,
    `  WHY     ${info.why}`,
    `  RISK    ${info.risk}`,
    `  SCOPE   ${scopeNote}`,
    `          Single use. Bound to this exact request. Review before you sign.`,
    `          Expires 60 minutes after staging if not signed. Doing nothing`,
    `          is a complete answer.`
  );

  if (requestId) {
    lines.push(
      ``,
      `  Approve, in a real terminal:`,
      `    npm run approve -- --request ${requestId}`
    );
  } else {
    // Staging failed (best-effort). Fall back to the older file-based flow
    // so the owner still has a path to approve, just a more manual one.
    const canonical = canonicalizeRequest(actionRequest);
    const outDir = path.join(home, 'pending-approvals');
    lines.push(
      ``,
      `  Could not stage the request for --request. Approve it by hand instead:`,
      `  Sign the exact canonicalized request below, then write the resulting`,
      `  token JSON to <LOTOR_HOME>/pending-approvals/<name>.json.`,
      ``,
      `  Action request (canonicalized):`,
      `  ${canonical}`,
      ``,
      `    npm run approve -- --action-file <f> --out ${path.join(outDir, '<name>.json')}`
    );
  }

  lines.push(``, `  Doing nothing denies. The denial is already receipted.`);
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
      matcherHash: matcherVersionHash(),
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
      matcherHash: matcherVersionHash(),
      timestamp: Date.now()
    });
    process.exit(0);
  }

  // KNOWN-LIMITS 15, corrected 2026-07-24.
  //
  // That entry claimed Lotor and the harness "cannot see" each other. False:
  // permission_mode arrives on every hook event and was simply discarded.
  // The combination the entry warns about — Lotor in Loose, plus a harness
  // that also skips tool-call review — means nothing stands between the
  // agent and the action on either layer, and it was invisible while being
  // detectable all along.
  //
  // A WARNING, NOT A BLOCK. Loose is an explicit operator choice and
  // escalating it to a denial would override a setting made on purpose.
  // What changes is that the combination stops being silent.
  //
  // Only the modes that broadly skip review are listed. `acceptEdits` is a
  // partial case (edits auto-accept, commands still prompt) and is left out
  // deliberately: warning on a posture that is usually reasonable is how a
  // warning gets ignored, and alarm fatigue is the same failure as approval
  // fatigue one layer up.
  const PERMISSIVE_HARNESS_MODES = ['bypassPermissions', 'dontAsk', 'auto'];
  if (policy && policy.mode === 'loose'
      && parsed.permissionMode && PERMISSIVE_HARNESS_MODES.includes(parsed.permissionMode)) {
    note(`WARNING: Lotor is in LOOSE mode and the harness reports "${parsed.permissionMode}". `
       + `Neither layer is stopping anything; both are only recording.`);
    // Record once per session rather than on every call. The chain read is
    // paid for only in this configuration, never on the fast path, which is
    // the trade this hook makes everywhere else: no chain I/O unless
    // something actually needs recording.
    try {
      const store = createStore(home);
      const already = store.entries.some(e =>
        e.payload
        && e.payload.type === 'policy-warn'
        && e.payload.ruleId === 'both-layers-permissive'
        && e.payload.sessionId === parsed.sessionId);
      if (!already) {
        store.appendReceipt({
          type: 'policy-warn',
          ruleId: 'both-layers-permissive',
          sessionId: parsed.sessionId,
          tool: toolName,
          lotorMode: policy.mode,
          harnessMode: parsed.permissionMode,
          matcherHash: matcherVersionHash(),
          timestamp: Date.now()
        });
      }
    } catch (e) {
      // Recording this is best-effort. It is an observation about posture,
      // not an authorisation decision, so a failure to write it must not
      // change what happens to the tool call.
      note(`could not record the permissive-posture warning (${e.message}); continuing`);
    }
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
      matcherHash: matcherVersionHash(),
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
      matcherHash: matcherVersionHash(),
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

    // Staged once per hook invocation and reused across whichever deny path
    // below actually fires, so the owner sees one consistent --request id
    // for this exact call regardless of why it was denied.
    //
    // `description` is the agent's own one-line account of why it is making
    // this call. It has always arrived on tool_input and has always been
    // discarded right here, which is why every denial jumped straight from the
    // rule name to a raw command with no statement of intent anywhere. It is
    // deliberately absent from SIGNED_PARAMS and stays out of the request
    // object, so it can never bind a signature or be voided by rewording; it
    // is staged alongside, for display only.
    const requestId = stageRequest(home, actionRequest, toolInput?.description);

    if (tokenResult == null) {
      const store = createStore(home);

      // No single-use token. Before denying, see whether a signed delegation
      // grant covers this exact request.
      //
      // The grant check and the grant-use append MUST be atomic. resolveGrant
      // counts prior uses from the chain; if that count is read before the
      // lock and the append lands after (as an earlier version did, counting
      // from a pre-lock store.entries snapshot and then calling appendReceipt),
      // two overlapping calls under one grant both observe the same count and
      // both proceed, exceeding maxActions. That contradicted the ceiling's own
      // guarantee. See KNOWN-LIMITS 20 / 21, finding 6.
      //
      // appendReceiptGuarded runs this callback INSIDE the chain lock with the
      // freshly re-read chain, so the count the decision uses is the same view
      // the grant-use entry lands on. resolveGrant never throws (every failure
      // is a refusal), so a null return here is an honest deny, never an
      // exception escaping to the outer fail-open handler.
      let grantDecision = { allow: false, reason: 'no grant evaluated' };
      let grantEntry = null;
      try {
        grantEntry = store.appendReceiptGuarded((current) => {
          grantDecision = resolveGrant({
            actionRequest,
            sessionId: parsed.sessionId,
            home,
            chainEntries: current,   // fresh, under the lock
            now: Date.now()
          });
          if (!grantDecision.allow) return null;   // no append; fall through to deny
          return {
            type: 'grant-use',
            grantId: grantDecision.grantId,
            useIndex: grantDecision.useIndex,
            ruleId,
            tool: toolName,
            paramsDigest,
            matcherHash: matcherVersionHash(),
            timestamp: Date.now()
          };
        });
      } catch (e) {
        // A use that cannot be recorded must not be allowed. The ceiling is
        // enforced by COUNTING grant-use entries, so an unrecorded use is an
        // uncounted one, and a grant whose uses go uncounted has no ceiling.
        note(`grant-use append failed (${e.message}); denying`);
        grantEntry = null;
      }

      if (grantEntry) {
        note(`approved by grant ${grantDecision.grantId} (use ${grantDecision.useIndex}): ${ruleId} (${toolName})`);
        process.exit(0);
      }

      // No token and no grant (or the ceiling was reached under the lock).
      // Deny, recording the denial exactly as before.
      const chain = {
        entries: store.entries,
        append: store.appendReceipt.bind(store)
      };
      const stagedAt = readStagedAt(home, requestId);
      const heldMs = stagedAt ? Date.now() - stagedAt : null;
      const meta = { ruleId, heldMs };
      try {
        gatedAction(actionRequest, null, chain, home, meta);
      } catch (e) {
        note(`denial receipt failed (${e.message}); still denying`);
      }
      note(`BLOCKED: ${ruleId} (${toolName}) — no valid token; ${grantDecision.reason}`);
      process.stderr.write(buildDenialMessage(ruleId, actionRequest, home, requestId) + '\n');
      process.exit(2);
    }

    if (tokenResult.rejected) {
      // Token was presented but failed verification. The reason from
      // findValidToken is the cheap local pre-screen result, not the
      // full verifyApproval outcome; the receipt classification comes
      // from gatedAction (which calls verifyApproval again). The cheap
      // pre-screen is good enough to decide whether this is a stale-
      // signature (operator signed, time ran out) or a token-was-for-
      // something-else (operator signed the wrong action).
      //
      // We classify here only for the operator-facing message; the
      // receipt decision is gatedAction's call so the two never drift.
      const token = readTokenFile(tokenResult.rejected.tokenFile);
      const reason = tokenResult.rejected.reason || 'token invalid';
      const stagedAt = readStagedAt(home, requestId);
      const heldMs = stagedAt ? Date.now() - stagedAt : null;
      const meta = { ruleId, heldMs };

      const store = createStore(home);
      const chain = {
        entries: store.entries,
        append: store.appendReceipt.bind(store)
      };

      let result;
      try {
        result = gatedAction(actionRequest, token || null, chain, home, meta);
      } catch (e) {
        // Engine-side fault (chain append threw, etc). The deny still
        // happens, but the receipt was not written. Surface as
        // unreachable so a reader of the chain sees the operator-facing
        // denial but does not falsely claim a verified outcome.
        note(`denial receipt failed (${e.message}); still denying`);
        result = { decision: 'unreachable', reason: `denial receipt failed: ${e.message}` };
      }
      // Delete the bad token so it does not get re-evaluated on every
      // subsequent tool call.
      try { fs.unlinkSync(tokenResult.rejected.tokenFile); } catch (_) { /* best-effort */ }
      note(`BLOCKED: ${ruleId} (${toolName}) — ${reason}`);
      process.stderr.write(buildDenialMessage(ruleId, actionRequest, home, requestId) + '\n');
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
    const stagedAt = readStagedAt(home, requestId);
    const heldMs = stagedAt ? Date.now() - stagedAt : null;
    const meta = { ruleId, heldMs };
    let result;
    try {
      result = gatedAction(actionRequest, tokenResult.token, chain, home, meta);
    } catch (e) {
      note(`gate check crashed (${e.message}); denying`);
      process.stderr.write(buildDenialMessage(ruleId, actionRequest, home, requestId) + '\n');
      process.exit(2);
    }
    if (result.decision === 'approved') {
      deleteTokenFile(tokenResult.tokenFile);
      note(`approved: ${ruleId} (${toolName})`);
      process.exit(0);
    }
    // Token was presented but rejected (e.g. nonce race). Deny.
    note(`BLOCKED: ${ruleId} (${toolName}) — ${result.reason || 'token invalid'}`);
    process.stderr.write(buildDenialMessage(ruleId, actionRequest, home, requestId) + '\n');
    process.exit(2);
  }

  // Unknown mode for a matched rule — treat as warn (defensive default).
  note(`unknown mode "${mode}" for ${ruleId}; treating as warn`);
  tryAppendReceipt(home, {
    type: 'policy-warn',
    ruleId,
    tool: toolName,
    paramsDigest,
    matcherHash: matcherVersionHash(),
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
