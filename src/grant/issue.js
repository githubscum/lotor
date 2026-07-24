#!/usr/bin/env node
/**
 * src/grant/issue.js
 *
 * Issue a signed delegation grant: one signature over N enumerated action
 * requests, bound to one session, with an expiry and a shared ceiling.
 *
 * USAGE (interactive, from a real terminal)
 *   npm run grant -- --session <sessionId> --all-pending --max-actions 10 --expires-in-ms 3600000
 *   npm run grant -- --session <sessionId> --requests a1b2c3d4,e5f6a7b8 --max-actions 4 --expires-in-ms 1800000
 *
 * WHERE THE REQUESTS COME FROM
 *   The gate already stages every denied request to
 *   <LOTOR_HOME>/pending-approvals/requests/<id>.json, which is what makes
 *   `npm run approve -- --request <id>` runnable exactly as printed. This
 *   command reads those same staged files. So the workflow is: work until
 *   the gate has stopped you a few times, then sign all of them at once
 *   instead of one at a time. The ids printed in each denial message are
 *   the ids passed here.
 *
 * WHY REQUESTS AND NOT PATHS
 *   The first version enumerated file paths. A baseline probe of the live
 *   gate showed the filenames it actually gates are essentially the
 *   non-delegable core, which no grant may cover, so a path-scoped grant
 *   could only ever cover paths that were never gated. Meanwhile the real
 *   friction is Bash: reads of gated files, script dispatch, egress. An
 *   enumerated request expresses all of it, and the comparison is byte
 *   equality over the gate's own canonical form.
 *
 * TTY POSTURE mirrors bin/approve.js: the passphrase is prompted with echo
 * off, PBKDF2-derived, and used to reconstruct the Ed25519 private key. The
 * key and the passphrase never touch disk, and the model process never sees
 * either.
 *
 * On wiping, precisely: the derived seed Buffer is zeroed after signing.
 * The passphrase String is not and cannot be, because JS strings are
 * immutable and survive until garbage collection. State what is true.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { signGrant, GRANT_TYPE } from './grant-schema.js';
import { requestRefusalReason } from './verify.js';
import { resolveHome } from '../home.js';
import { createStore } from '../store/index.js';

class BuildGrantError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BuildGrantError';
  }
}

// ---- staged-request loading (pure-ish, testable) ------------------------

function stagedDir(home) {
  return path.join(home, 'pending-approvals', 'requests');
}

/** Read one staged request by its short id. Throws BuildGrantError. */
function loadStagedRequest(home, id) {
  if (!/^[a-f0-9]{4,32}$/i.test(String(id))) {
    throw new BuildGrantError(`'${id}' is not a valid request id`);
  }
  const file = path.join(stagedDir(home), `${id}.json`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new BuildGrantError(`no staged request '${id}' (looked in ${stagedDir(home)})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new BuildGrantError(`staged request '${id}' is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.action !== 'string') {
    throw new BuildGrantError(`staged request '${id}' is not an action request`);
  }
  return { id, request: parsed };
}

/** Every staged request, oldest first. */
function loadAllStaged(home) {
  const dir = stagedDir(home);
  let names;
  try {
    names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
  } catch {
    throw new BuildGrantError(`no staged requests directory at ${dir}`);
  }
  const out = [];
  for (const n of names) {
    const id = n.replace(/\.json$/, '');
    try {
      out.push(loadStagedRequest(home, id));
    } catch {
      // A malformed staged file must not block signing the good ones.
    }
  }
  if (out.length === 0) throw new BuildGrantError(`no readable staged requests in ${dir}`);
  return out;
}

/**
 * Resolve the requested set, deduplicated, preserving the order given.
 * Duplicates are dropped rather than counted twice: a grant enumerating the
 * same request twice would silently consume two of the ceiling for one
 * distinct capability, which is not what a human reading the list expects.
 */
function resolveRequests(home, { ids, all }) {
  const picked = all ? loadAllStaged(home) : ids.map(id => loadStagedRequest(home, id));
  const seen = new Set();
  const out = [];
  for (const item of picked) {
    const key = JSON.stringify(item.request);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// ---- grant construction -------------------------------------------------

/**
 * Validate and produce a signed grant. Pure: no I/O, no TTY.
 * Throws BuildGrantError on any rejection. Every rejection happens HERE,
 * at issue time, so the human sees it while they can still fix it, rather
 * than discovering at use time that a grant they signed does nothing.
 */
function buildGrant(input, privateKey) {
  if (!input || typeof input !== 'object') throw new BuildGrantError('input must be an object');
  if (!privateKey) throw new BuildGrantError('privateKey is required');
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) {
    throw new BuildGrantError('sessionId is required');
  }

  const maxActions = Number(input.maxActions);
  if (!Number.isInteger(maxActions) || maxActions <= 0) {
    throw new BuildGrantError('maxActions must be a positive integer');
  }

  const expiresAt = Number(input.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    throw new BuildGrantError('expiresAt is required and must be a number');
  }
  const now = Number(input.issuedAt) || Date.now();
  if (expiresAt <= now) {
    throw new BuildGrantError(`expiresAt (${expiresAt}) must be strictly after issuedAt (${now})`);
  }

  const requests = input.requests;
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new BuildGrantError('a grant must enumerate at least one request');
  }
  for (const r of requests) {
    const bad = requestRefusalReason(r);
    if (bad) throw new BuildGrantError(`refusing to sign: ${bad}`);
  }

  // A ceiling below the number of enumerated requests is almost certainly a
  // mistake: the human listed capabilities they cannot all use. Say so
  // rather than signing something that will surprise them.
  if (maxActions < requests.length) {
    throw new BuildGrantError(
      `maxActions (${maxActions}) is lower than the number of enumerated requests (${requests.length}); ` +
      `at least ${requests.length} would be needed to use each once`
    );
  }

  const unsigned = {
    type: GRANT_TYPE,
    grantId: input.grantId || `grant-${crypto.randomBytes(8).toString('hex')}`,
    sessionId: input.sessionId,
    requests,
    maxActions,
    issuedAt: now,
    expiresAt,
    nonce: input.nonce || crypto.randomBytes(16).toString('hex')
  };
  return signGrant(unsigned, privateKey);
}

// ---- recording the authorisation ---------------------------------------

/**
 * Append the signed grant to the chain as its own entry.
 *
 * WHY THIS EXISTS (CL-005, found 2026-07-24 while deleting a stale grant)
 *   The first build wrote the grant to a file and recorded nothing. Only
 *   `grant-use` entries reached the chain, so the log could say that
 *   something was authorised under grant X and used twice, and could not
 *   say WHAT that grant authorised. That lived solely in a file any process
 *   could delete, which is how the defect was found: deleting one took no
 *   signature and nothing was left behind.
 *
 *   The design document had specified this in plain language — "the chain
 *   holds what was authorized and what was done with it, separately and in
 *   order; those two can be diffed" — and only the second half was built.
 *   The diff the design called the point was impossible.
 *
 * WHAT GOES ON THE CHAIN, AND WHY IT IS THE WHOLE GRANT
 *   The enumerated requests are recorded in full, in plaintext, including
 *   command strings. A digest would let someone verify a grant file they
 *   still have; it would not let them reconstruct what was authorised once
 *   the file is gone, and reconstruction is the requirement. Legible was
 *   the word the design used.
 *
 *   This does change what the chain contains: exact authorised command
 *   strings now sit in the log alongside the existing digests. The log is
 *   local and operator-held, which is the whole premise, but the change is
 *   worth stating rather than discovering later.
 *
 * THE SIGNATURE IS INCLUDED DELIBERATELY
 *   With it, the chain entry is independently verifiable against the
 *   owner's approval public key, which is passphrase-derived and never on
 *   disk. Without it, an entry claiming "grant X authorised Y" would rest
 *   entirely on the chain key, which KNOWN-LIMITS already discloses is
 *   stored unencrypted. Two independent keys is better than one.
 *
 * WHAT THIS IS NOT
 *   The chain entry is the RECORD, not the authority. A grant is honoured
 *   because it carries a valid signature, not because a chain entry exists,
 *   and the verifier deliberately does not require one. Making the record
 *   load-bearing for enforcement would mean a chain read on every gated
 *   call and a new failure mode, for no security gain: forging a grant
 *   already requires the passphrase.
 */
function recordGrantOnChain(home, grant) {
  const store = createStore(home);
  return store.appendReceipt({
    type: GRANT_TYPE,
    grantId: grant.grantId,
    sessionId: grant.sessionId,
    requests: grant.requests,
    maxActions: grant.maxActions,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    nonce: grant.nonce,
    signature: grant.signature,
    timestamp: Date.now()
  });
}

// ---- human-readable rendering ------------------------------------------

/**
 * Render one request the way a person needs to read it before signing.
 * The whole security value of a grant rests on the owner actually reading
 * this, so it shows the full parameter value and never truncates.
 */
function renderRequest(item, index) {
  const r = item.request;
  const params = r.params || {};
  const keys = Object.keys(params);
  const lines = [`  ${String(index + 1).padStart(2)}. [${item.id}] ${r.action}`];
  if (keys.length === 0) {
    lines.push('      (no parameters)');
  } else {
    for (const k of keys) {
      lines.push(`      ${k}: ${params[k]}`);
    }
  }
  return lines.join('\n');
}

// ---- TTY prompting (mirrors bin/approve.js) -----------------------------

function readLineSilent() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      if (c === '\n' || c === '\r') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stderr.write('\n');
        resolve(input);
      } else if (c.charCodeAt(0) === 3) {
        // Ctrl-C. Compared by code point on purpose: an invisible control
        // byte in source is unreadable in review and does not survive being
        // displayed by most tools, which is how a dead branch hides.
        process.stderr.write('\naborted.\n');
        process.exit(130);
      } else if (c.charCodeAt(0) === 127 || c.charCodeAt(0) === 8) {
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stderr.write('\b \b');
        }
      } else {
        input += c;
        process.stderr.write('*');
      }
    });
  });
}

async function promptPassphrase() {
  if (!process.stdin.isTTY) {
    console.error('error: not a TTY. the signer must be run from a terminal, not a piped process.');
    process.exit(2);
  }
  process.stderr.write('passphrase: ');
  return readLineSilent();
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function loadApprovalPubkeyFile(home) {
  const pubPath = path.join(home, 'keys', 'approval.pub');
  if (!fs.existsSync(pubPath)) {
    console.error(`error: no approval public key at ${pubPath}; run "npm run approve:init" first.`);
    process.exit(2);
  }
  const line = fs.readFileSync(pubPath, 'utf8').trim();
  const m = line.match(/^ed25519:([A-Za-z0-9_-]+):fingerprint:([a-f0-9]{32})$/);
  if (!m) {
    console.error('error: approval public key file is malformed');
    process.exit(2);
  }
  return { b64: m[1], fp: m[2] };
}

// ---- CLI ----------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const HELP = `issue.js — issue a signed delegation grant.

A grant is N single-use tokens with one signature, one expiry, and one
ceiling. It authorises the exact requests you enumerate, in one session,
and nothing else.

usage:
  npm run grant -- --session <sessionId> --all-pending \\
    --max-actions <n> --expires-in-ms <ms>

  npm run grant -- --session <sessionId> --requests <id>,<id> \\
    --max-actions <n> --expires-in-ms <ms>

options:
  --session <id>          the session the grant is bound to. Useless elsewhere.
  --requests <id,id,...>  staged request ids, as printed in each gate denial
  --all-pending           every staged request instead of named ids
  --max-actions <n>       hard ceiling on uses, independent of the clock
  --expires-in-ms <ms>    lifetime from now
  --out <path>            where to write it (default: <LOTOR_HOME>/grants/)
  --lotor-home <path>     override LOTOR_HOME

The requests come from <LOTOR_HOME>/pending-approvals/requests/, which is
where the gate stages every denial. Work until the gate has stopped you a
few times, then sign them together instead of one at a time.

Reads the approval public key from <lotor-home>/keys/approval.pub and
prompts for the passphrase at a TTY with echo off. The model process never
sees the passphrase and never sees the key.
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(HELP);
    return;
  }

  const home = args['lotor-home'] || resolveHome();

  // Argument validation runs BEFORE the key is loaded, so a typo reports the
  // typo rather than "no approval public key". Loading first meant every
  // mistake on a machine without a key produced the same misleading error.
  const sessionId = String(args.session || '');
  if (!sessionId) {
    console.error('error: --session is required');
    process.exit(2);
  }
  const all = args['all-pending'] === true;
  const idsRaw = typeof args.requests === 'string' ? args.requests : '';
  if (!all && !idsRaw) {
    console.error('error: one of --requests or --all-pending is required');
    process.exit(2);
  }
  const maxActions = Number(args['max-actions']);
  if (!Number.isInteger(maxActions) || maxActions <= 0) {
    console.error('error: --max-actions must be a positive integer');
    process.exit(2);
  }
  const expiresInMs = Number(args['expires-in-ms']);
  if (!Number.isFinite(expiresInMs) || expiresInMs <= 0) {
    console.error('error: --expires-in-ms must be a positive number');
    process.exit(2);
  }

  const pub = loadApprovalPubkeyFile(home);

  let items;
  try {
    items = resolveRequests(home, {
      all,
      ids: idsRaw.split(',').map(s => s.trim()).filter(Boolean)
    });
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(2);
  }

  // Refuse before prompting, so a bad list costs no passphrase entry.
  for (const item of items) {
    const bad = requestRefusalReason(item.request);
    if (bad) {
      console.error(`error: request [${item.id}] cannot be granted: ${bad}`);
      process.exit(2);
    }
  }

  const issuedAt = Date.now();
  const expiresAt = issuedAt + expiresInMs;

  process.stderr.write('\n--- grant to be signed ---\n');
  process.stderr.write(`session:      ${sessionId}\n`);
  process.stderr.write(`max-actions:  ${maxActions}\n`);
  process.stderr.write(`expires-in:   ${expiresInMs} ms (at ${new Date(expiresAt).toISOString()})\n`);
  process.stderr.write(`requests (${items.length}), each authorised EXACTLY as written:\n`);
  for (let i = 0; i < items.length; i++) {
    process.stderr.write(renderRequest(items[i], i) + '\n');
  }
  process.stderr.write('--- end. read the above before entering your passphrase. ---\n');

  const passphrase = await promptPassphrase();
  // PBKDF2 params must match src/gate/sign.js
  const SALT = Buffer.from('agent-receipts-approval-salt-v1-2026-07-21', 'utf8');
  const seed = crypto.pbkdf2Sync(passphrase, SALT, 600_000, 32, 'sha256');
  const jwkPriv = { crv: 'Ed25519', d: base64url(seed), x: pub.b64, kty: 'OKP' };

  let privKeyObj;
  try {
    privKeyObj = crypto.createPrivateKey({ key: jwkPriv, format: 'jwk' });
  } catch {
    seed.fill(0);
    console.error('error: passphrase did not yield a valid key');
    process.exit(3);
  }
  const derivedPub = crypto.createPublicKey(privKeyObj).export({ format: 'jwk', type: 'public' });
  if (derivedPub.x !== pub.b64) {
    seed.fill(0);
    console.error('error: passphrase does not match the stored public key.');
    process.exit(3);
  }

  let grant;
  try {
    grant = buildGrant({
      sessionId,
      requests: items.map(i => i.request),
      maxActions,
      issuedAt,
      expiresAt
    }, privKeyObj);
  } catch (e) {
    seed.fill(0);
    console.error(`error: ${e.message}`);
    process.exit(2);
  }
  seed.fill(0);

  // Record BEFORE writing the usable grant, and fail closed if it cannot be
  // recorded. A grant file with no chain entry is precisely CL-005, so
  // issuing one when the record failed would reintroduce the defect being
  // fixed. The reverse ordering is harmless by comparison: a chain entry
  // whose file never landed describes an authorisation that was never
  // usable, which is a true statement about a grant nobody can spend.
  let entry;
  try {
    entry = recordGrantOnChain(home, grant);
  } catch (e) {
    console.error(`error: could not record the grant on the chain (${e.message}); refusing to issue it.`);
    console.error('nothing was written. an unrecorded grant is exactly the defect this check exists to prevent.');
    process.exit(4);
  }

  const outPath = args.out || path.join(home, 'grants', `${grant.grantId}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(grant, null, 2) + '\n', { mode: 0o600 });

  process.stderr.write(`\nsigned. ${items.length} request(s), ceiling ${maxActions}.\n`);
  process.stderr.write(`recorded on the chain at seq ${entry && entry.seq}\n`);
  process.stderr.write(`${outPath}\n`);
}

export {
  BuildGrantError,
  buildGrant,
  recordGrantOnChain,
  resolveRequests,
  loadStagedRequest,
  loadAllStaged,
  renderRequest
};

// Run main only if this file is the entrypoint (not when imported by tests).
//
// Normalise BOTH sides and resolve argv[1] first. The previous version
// compared fileURLToPath(import.meta.url), which returns backslashes on
// Windows, against argv[1] with backslashes rewritten to forward slashes.
// They could never be equal, so main() never ran: the command exited 0 and
// printed nothing while every test passed, because every test imports the
// exported functions and none invokes the entrypoint.
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url).replace(/\\/g, '/');
const __invoked = process.argv[1] ? path.resolve(process.argv[1]).replace(/\\/g, '/') : '';
if (__invoked === __filename) {
  main().catch((e) => {
    console.error('error:', e && e.message ? e.message : e);
    process.exit(1);
  });
}
