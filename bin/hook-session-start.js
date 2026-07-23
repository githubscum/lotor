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
 *   - the policy in force, plus a digest so a between-session policy edit
 *     is visible as a changed digest rather than having to be diffed
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
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStore } from '../src/store/index.js';
import { resolveHome } from '../src/home.js';
import { loadPolicy } from '../src/policy/index.js';
import { verifyChain } from '../src/chain/index.js';

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
 * Which Lotor hooks are registered in the user's Claude Code settings.
 *
 * Read-only and best-effort: an unreadable or absent settings file yields
 * `{ readable: false }` rather than throwing. A false here means "not found
 * in the files we looked at", not "provably absent everywhere" — project and
 * enterprise settings can also register hooks and are not read.
 */
function snapshotHookRegistration() {
  const candidates = [
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.local.json')
  ];

  let readable = false;
  let blob = '';
  const sourcesRead = [];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      blob += fs.readFileSync(file, 'utf8');
      sourcesRead.push(file);
      readable = true;
    } catch (e) {
      // best-effort; a settings file we cannot read is simply not counted
    }
  }

  if (!readable) return { readable: false };

  const has = needle => blob.includes(needle);
  return {
    readable: true,
    sessionStart: has('hook-session-start.js'),
    preToolUse: has('hook-pre-tool-use.js'),
    postToolUse: has('hook-post-tool-use.js'),
    sessionEnd: has('hook-session-end.js'),
    sourcesRead
  };
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

      return {
        type: 'session-open',
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
          ? { version: policy.version, modes: policy.modes, digest: digestPolicy(policy) }
          : null,
        hooks,
        lotorVersion: 1,
        timestamp: Date.now()
      };
    });

    if (entry) {
      note(`opened session ${sessionId || 'unknown'} (${source}) at seq ${entry.seq}`);
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
