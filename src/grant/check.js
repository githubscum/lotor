/**
 * src/grant/check.js
 *
 * Runtime resolution of delegation grants at the enforcement point.
 *
 * WHERE THIS SITS
 *   bin/hook-pre-tool-use.js already handles single-use approval tokens. A
 *   token covers one exact request and is consumed once, so a session that
 *   hits the gate forty times means forty signatures, which in practice
 *   means the gate gets switched off. This is the middle rung: one
 *   signature over N enumerated requests, bound to one session, with an
 *   expiry and a shared action ceiling.
 *
 * WHY EVERY TOOL IS GRANTABLE NOW
 *   The first version of this module refused Bash outright, because a
 *   path-scoped grant could not express a command and matching shell text
 *   would have inherited the KNOWN-LIMITS 11 weakness. Enumerating exact
 *   action requests removes that problem rather than working around it:
 *   the comparison is byte equality over the gate's own canonical form, so
 *   a granted Bash command is the identical check a single-use token makes,
 *   against a string a human read before signing. There is nothing left for
 *   a matcher to get wrong, so there is no reason to exclude a tool.
 *
 *   What a granted command DOES once it runs is still unknowable from its
 *   text. A grant changes only how many times an already-reviewed string
 *   may run. It does not make the string safer, and this module does not
 *   claim it does.
 *
 * THE SEAM IT MUST NOT CROSS
 *   The hook fails OPEN on engine error and CLOSED on token failure. That
 *   distinction is deliberate and documented in the hook's header. A grant
 *   check is a security check, not an engine check, so every failure path
 *   here returns a refusal. This module never throws to its caller: the
 *   caller is a deny path, and an exception escaping into the hook's outer
 *   handler would be read as an engine error and silently allow.
 *
 * ADDITIVE BY CONSTRUCTION
 *   Consulted only after no valid token was found, i.e. only on the path
 *   that was already going to deny. It can turn a DENY into an ALLOW when a
 *   signed grant covers the action. It can never turn an ALLOW into a DENY,
 *   so a bug here cannot lock the owner out of their own machine.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkGrant } from './verify.js';
import { loadApprovalPubkey } from '../gate/sign.js';

function grantsDir(home) {
  return path.join(home, 'grants');
}

/**
 * Load every grant file. Unreadable or malformed files are skipped rather
 * than fatal: one corrupt file must not disable an otherwise valid grant,
 * and it must not throw into the caller either.
 */
function loadGrants(home) {
  const dir = grantsDir(home);
  let names;
  try {
    if (!fs.existsSync(dir)) return [];
    names = fs.readdirSync(dir).filter(n => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (parsed && typeof parsed === 'object') out.push({ grant: parsed, file: path.join(dir, name) });
    } catch {
      // skip
    }
  }
  return out;
}

/**
 * Count prior uses of a grant FROM THE CHAIN, never from a counter file.
 *
 * The action ceiling has to be as tamper-evident as everything else. A
 * count kept in a sidecar could be reset by deleting it; a count derived
 * from append-only signed entries cannot be lowered without breaking the
 * chain, which is the entire reason there is a chain.
 *
 * An unreadable chain returns Infinity, not zero. Unknown must refuse.
 */
function countUses(chainEntries, grantId) {
  if (!Array.isArray(chainEntries)) return Number.POSITIVE_INFINITY;
  let n = 0;
  for (const e of chainEntries) {
    const p = e && e.payload;
    if (p && p.type === 'grant-use' && p.grantId === grantId) n++;
  }
  return n;
}

function publicKeyFor(home) {
  const pub = loadApprovalPubkey(home);
  return crypto.createPublicKey({ key: { crv: 'Ed25519', x: pub.b64, kty: 'OKP' }, format: 'jwk' });
}

/**
 * Decide whether any signed grant covers this action.
 *
 * @param {Object} opts
 * @param {Object} opts.actionRequest - { action, params } exactly as the hook built it
 * @param {string} opts.sessionId     - session_id from the PreToolUse payload
 * @param {string} opts.home          - LOTOR_HOME
 * @param {Array}  opts.chainEntries  - store.entries
 * @param {number} opts.now           - Date.now()
 * @returns {{allow: boolean, reason: string, grantId?: string, useIndex?: number}}
 *          Always returns. Never throws.
 */
function resolveGrant({ actionRequest, sessionId, home, chainEntries, now }) {
  try {
    if (!actionRequest || typeof actionRequest !== 'object') {
      return { allow: false, reason: 'no action request to check' };
    }
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      // Grants are session-bound. With no session id there is nothing to
      // bind to, so no grant applies. Refuse rather than read the absence
      // as a wildcard.
      return { allow: false, reason: 'no session id on the request; grants are session-bound' };
    }

    let publicKey;
    try {
      publicKey = publicKeyFor(home);
    } catch {
      return { allow: false, reason: 'approval public key unavailable' };
    }

    const candidates = loadGrants(home);
    if (candidates.length === 0) {
      return { allow: false, reason: 'no grants on file' };
    }

    let firstReason = null;
    for (const { grant } of candidates) {
      const usesSoFar = countUses(chainEntries, grant && grant.grantId);
      const r = checkGrant(grant, { sessionId, actionRequest, now, usesSoFar }, publicKey);
      if (r && r.allow) {
        return {
          allow: true,
          reason: 'covered by a signed grant',
          grantId: grant.grantId,
          useIndex: usesSoFar + 1
        };
      }
      if (!firstReason && r && r.reason) firstReason = r.reason;
    }
    return { allow: false, reason: firstReason || 'no grant covers this action' };
  } catch (e) {
    // Never let an exception reach the caller. The caller is a deny path;
    // an exception escaping into the hook's outer handler would be treated
    // as an engine error and silently ALLOW.
    return { allow: false, reason: `grant check failed: ${e && e.message ? e.message : String(e)}` };
  }
}

export { resolveGrant, countUses, loadGrants };
