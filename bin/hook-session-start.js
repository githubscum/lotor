#!/usr/bin/env node
/**
 * bin/hook-session-start.js
 *
 * Claude Code `SessionStart` hook target. Opens the record for a session at
 * the moment it begins, rather than waiting for `SessionEnd` to write it.
 *
 * WHY THIS EXISTS (KNOWN-LIMITS 14)
 *   Capture used to be driven entirely by `SessionEnd`. A session that was
 *   force-killed, crashed, OOM'd, or lost power wrote no receipt at all, so
 *   the chain showed an unbroken run of well-behaved sessions and no trace
 *   that any others existed. The sessions most worth a record were exactly
 *   the ones the design dropped.
 *
 *   Opening the record here inverts that. An abnormal exit now leaves an
 *   opened-but-never-closed entry, which is evidence rather than silence.
 *   A `session-open` with no later session receipt for the same id is the
 *   signal. `npm run receipts` surfaces the count.
 *
 * WHAT IT ANCHORS
 *   - session id, source (startup | resume | clear | compact), cwd
 *   - the herding-mode policy in force (herded | grazing | loose | custom),
 *     plus a digest so a between-session policy edit is visible as a
 *     changed digest rather than having to be diffed
 *   - the chain head at open (seq + hash), so the log's own starting point
 *     for this session is recorded inside the log
 *   - a verify result at open
 *   - which Lotor hooks are actually registered in the user's settings
 *
 *   That last one is the snapshot KNOWN-LIMITS 11 refers to. Hook
 *   registration lives in a user-editable settings file, so a hostile or
 *   careless edit landing between sessions is only ever caught at the next
 *   session's start. This is that catch. It is a snapshot, not real-time
 *   protection, and it is recorded rather than enforced.
 *
 * SIDE EFFECT THAT IS THE POINT
 *   `createStore()` creates the keys directory, the chain keypair, and the
 *   receipts directory if they do not exist. Running it here means the local
 *   store is established at session start, before the first tool call, not
 *   lazily on whatever happens to touch it first.
 *
 * STDIN CONTRACT
 *   Reads one JSON object from stdin (the Claude Code hook payload). Fields
 *   used, all optional: `session_id`, `transcript_path`, `cwd`, `source`.
 *   A payload can also be passed positionally as argv[2] for manual testing,
 *   which takes precedence and makes stdin optional.
 *
 * OUTPUT CONTRACT
 *   Nothing is ever written to stdout. For `SessionStart` specifically,
 *   Claude Code folds hook stdout into the session context, which would make
 *   this an injection surface into the very session it is recording. All
 *   diagnostics go to stderr, one line each.
 *
 * EXIT-0-ALWAYS RULE
 *   This hook must never break the user's session. Every failure mode is
 *   caught, reported on stderr, and exits 0. There is no non-zero exit path.
 *   A receipt layer that can stop you opening an editor is worse than a
 *   missing open receipt.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store/index.js';
import { resolveHome } from '../src/home.js';
import { loadPolicy, MATCHER_SCHEMA, matcherVersionHash } from '../src/policy/index.js';
import { PARSER_SCHEMA, parserVersionHash } from '../src/parser/index.js';
import { verifyChain } from '../src/chain/index.js';

/**
 * Read this package's own version. Best-effort: an unreadable
 * package.json must not stop the session from opening. Returns null on
 * any failure (file missing, malformed JSON, no version field).
 */
function readPackageVersion() {
  try {
    const pkgPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..', 'package.json'
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch (e) {
    return null;
  }
}
import { snapshotHookRegistration } from '../src/registration.js';
import { resolveHarness } from '../src/harness.js';
import { fingerprintTool, diffPins, summaryDiff } from '../src/toolpins/tool-pin.js';

/**
 * Read the most recent session-open that carried toolPins, walking the
 * chain from the tail. Best-effort: a missing chain, a malformed entry,
 * or a store that throws all become "no prior pins" so a fresh install
 * never wedges session-open.
 */
function readPriorToolPins(entries) {
  try {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e && e.payload
          && e.payload.type === 'session-open'
          && e.payload.toolPins) {
        return {
          pins: e.payload.toolPins,
          defs: e.payload.toolDefs || {},
          schemaVersion: e.payload.toolPinSchemaVersion || null
        };
      }
    }
    return { pins: {}, defs: {}, schemaVersion: null };
  } catch (e) {
    return { pins: {}, defs: {}, schemaVersion: null };
  }
}

/**
 * Pin the tool listing the harness handed us, if it handed one at all.
 * Claude Code's SessionStart payload carries NO tool listing today
 * (verified against the live payload shape 2026-08-15), so on this
 * harness the receipt records that absence honestly instead of
 * pretending an empty listing was observed. A harness (or wrapper)
 * that provides `tools: [...]` gets the full pin/diff flow.
 * KNOWN-LIMITS: the diff is listing-time only either way.
 */
function buildToolPins(payload, entries) {
  const listing = Array.isArray(payload.tools) ? payload.tools : null;
  if (!listing) {
    return {
      toolPins: null,
      toolDefs: null,
      toolPinDiff: null,
      toolPinDiffSummary: 'harness exposed no tool listing at session-open',
      toolPinSchemaVersion: 'tp/1'
    };
  }
  const currentPins = {};
  const currentDefsMap = {};
  for (const def of listing) {
    if (!def || typeof def.name !== 'string') continue;
    try {
      currentPins[def.name] = fingerprintTool(def);
      currentDefsMap[def.name] = def;
    } catch (e) { /* a malformed def is skipped, not fatal */ }
  }
  const prior = readPriorToolPins(entries);
  const pinDiff = diffPins(prior.pins, currentPins, prior.defs, currentDefsMap);
  return {
    toolPins: currentPins,
    toolDefs: currentDefsMap,
    toolPinDiff: pinDiff,
    toolPinDiffSummary: summaryDiff(pinDiff),
    toolPinSchemaVersion: 'tp/1'
  };
}

const STDIN_TIMEOUT_MS = 5000;

function note(message) {
  process.stderr.write(`lotor hook-session-start: ${message}\n`);
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
  if (!raw || raw.trim() === '') return {};
  try {
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
    return payload;
  } catch (e) {
    note(`stdin was not valid JSON (${e.message}); recording the open anyway`);
    return {};
  }
}

/**
 * Stable digest of the effective policy modes. Key order is sorted so an
 * unchanged policy always digests identically regardless of how the JSON
 * was written.
 */
function digestPolicy(policy) {
  const modes = (policy && policy.modes) || {};
  const sorted = {};
  for (const k of Object.keys(modes).sort()) sorted[k] = modes[k];
  const text = JSON.stringify({ version: policy?.version ?? null, modes: sorted });
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Verify the chain as loaded, using the public half of the chain key.
 * Never throws; a failure to verify is itself a recordable result.
 */
function verifyAtOpen(entries, home) {
  try {
    const pubKeyFile = path.join(home, 'keys', 'chain.pub');
    if (!fs.existsSync(pubKeyFile)) {
      return { ok: false, reason: 'no chain public key on disk' };
    }
    const publicKey = crypto.createPublicKey(fs.readFileSync(pubKeyFile, 'utf-8'));
    const result = verifyChain(entries, publicKey);
    return { ok: !!result.ok, reason: result.reason, brokenAt: result.brokenAt };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function main() {
  let home;
  try {
    home = resolveHome();
  } catch (e) {
    note(`could not resolve LOTOR_HOME (${e.message}); nothing recorded`);
    return;
  }

  const argPayload = process.argv[2];
  const raw = (typeof argPayload === 'string' && argPayload !== '')
    ? argPayload
    : await readStdin();
  const payload = parsePayload(raw);

  // Resolved once here, from the payload as received, so the recorded basis
  // reflects what this hook was actually handed rather than anything derived
  // later. Self-attested, like capture itself: it makes a mixed chain
  // separable under honest conditions and proves nothing adversarially.
  const harness = resolveHarness(payload);

  const sessionId = typeof payload.session_id === 'string' && payload.session_id.trim() !== ''
    ? payload.session_id
    : (typeof payload.sessionId === 'string' && payload.sessionId.trim() !== ''
      ? payload.sessionId
      : null);
  const source = typeof payload.source === 'string' ? payload.source : 'unknown';
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  const transcriptPath = typeof payload.transcript_path === 'string'
    ? payload.transcript_path
    : (typeof payload.transcriptPath === 'string' ? payload.transcriptPath : null);

  // Establishing the store IS the gateway coming up: keys dir, chain keypair,
  // receipts dir are all created here if absent.
  let store;
  try {
    store = createStore(home);
  } catch (e) {
    note(`could not open the store (${e.message}); nothing recorded`);
    return;
  }

  let policy = null;
  try {
    policy = loadPolicy(home);
  } catch (e) {
    note(`could not load policy (${e.message}); recording the open without it`);
  }

  if (policy && policy.mode === 'loose') {
    note('WARNING: herding mode is LOOSE — nothing is blocked this session, only recorded');
  }

  const hooks = snapshotHookRegistration();
  if (hooks.readable && !hooks.preToolUse) {
    note('WARNING: the PreToolUse gate is NOT registered in your settings; actions are ungated');
  }

  try {
    const entry = store.appendReceiptGuarded(current => {
      // openIndex mirrors the subsession idea: SessionStart fires again on
      // resume, clear and compact, and each firing is a real event worth its
      // own entry. Index them rather than collapsing or skipping them.
      let openIndex = 0;
      for (const e of current) {
        if (e.payload?.type === 'session-open' && e.payload?.sessionId === sessionId) {
          openIndex++;
        }
      }

      const head = current.length > 0 ? current[current.length - 1] : null;
      const verified = verifyAtOpen(current, home);
      const pins = buildToolPins(payload, current);

      return {
        type: 'session-open',
        ...pins,
        // Deliberately NOT nested under a `session` key: the view layer treats
        // any payload carrying `session` as a full session receipt, and an
        // open is not one.
        sessionId,
        openIndex,
        source,
        cwd,
        transcriptPath,
        chainHeadAtOpen: head ? { seq: head.seq, hash: head.hash } : null,
        chainLengthAtOpen: current.length,
        verifiedAtOpen: verified,
        policy: policy
          ? { version: policy.version, mode: policy.mode, modes: policy.modes, digest: digestPolicy(policy) }
          : null,
        hooks,
        // Which harness wrote this, and on what basis (KNOWN-LIMITS 13).
        // Never a bare name: `basis` says declared / inferred / unknown, and
        // an unknown harness stays "unknown" rather than defaulting to the
        // common case, because defaulting would attribute a foreign harness's
        // entries to this one and a reader could not tell.
        //
        // This has to exist BEFORE a second harness starts writing. The chain
        // is append-only, so an entry written without the field can never
        // acquire it.
        // Answers "what was the witness capable of seeing at this moment",
        // distinct from `policy` above (which versions the user's policy.json,
        // not the matcher CODE). Absence on an older entry means "before
        // instrumentation was versioned", not an error: additive field on a
        // payload the chain hashes as-is, so old entries verify unchanged.
        observer: {
          schema: 'observer/1',
          packageVersion: readPackageVersion(),
          matcher: { schema: MATCHER_SCHEMA, hash: matcherVersionHash() },
          parser: { schema: PARSER_SCHEMA, hash: parserVersionHash() }
        },
        harness,
        lotorVersion: 1,
        timestamp: Date.now()
      };
    });

    if (entry) {
      note(`opened session ${sessionId || 'unknown'} (${source}, mode ${policy?.mode || 'unknown'}) at seq ${entry.seq}`);
    } else {
      note('nothing appended');
    }
  } catch (e) {
    note(`could not append the open receipt (${e.message}); continuing`);
  }
}

main()
  .catch(e => {
    try {
      note(`unexpected failure (${e && e.message ? e.message : e})`);
    } catch (_) {
      // stderr itself failed; there is nothing further to do
    }
  })
  .finally(() => {
    process.exit(0);
  });
