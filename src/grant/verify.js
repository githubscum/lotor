/**
 * src/grant/verify.js
 *
 * checkGrant(grant, ctx, publicKey) -> { allow: boolean, reason: string }
 *
 *   grant     - the signed grant object
 *   ctx       - { sessionId, actionRequest, now, usesSoFar }
 *   publicKey - the owner's Ed25519 public key (KeyObject)
 *
 * WHAT A GRANT IS, AFTER THE 2026-07-23 REWORK
 *   N single-use tokens with one signature, one expiry, and one ceiling.
 *
 *   The first version enumerated FILE PATHS. A baseline probe of the live
 *   gate killed that design: the filenames the self-mod rule actually gates
 *   are essentially the non-delegable core, and a grant may not cover core
 *   paths, so a path-scoped grant could only ever cover paths that were
 *   never gated. It changed no outcome. Meanwhile the friction that does
 *   exist is Bash — reads of gated files, script dispatch, egress — which a
 *   path list cannot express at all.
 *
 *   So a grant now enumerates ACTION REQUESTS, in exactly the {action,
 *   params} shape the single-use token layer already signs.
 *
 * WHY THIS INTRODUCES NO NEW MATCHING WEAKNESS
 *   Comparison is exact-string equality over canonicalizeRequest(), the
 *   same function and the same canonical form the token layer uses today.
 *   A grant is therefore no weaker than the primitive already trusted: it
 *   is the identical check, run against N pre-approved requests instead of
 *   one. Nothing here pattern-matches, so nothing here inherits the
 *   KNOWN-LIMITS 11 ceiling that the RULE matcher carries.
 *
 * ORDER OF CHECKS, AND IT MATTERS
 *   1. signature valid
 *   2. session matches
 *   3. not expired
 *   4. usesSoFar < maxActions
 *   5. the request is one the grant enumerates
 *   6. no enumerated request is core-protected (belt and braces; issue time
 *      already refused it, but a hand-crafted grant must still fail)
 *
 * Any thrown exception is a refusal. The verifier NEVER lets an exception
 * become an allow. That is the single most important property of this
 * module: the moment verification stops returning refusals on errors, the
 * whole design becomes negotiable.
 */

import { verifyGrantSignature } from './grant-schema.js';
import { classifyPath, PATH_PARAMS } from './core-paths.js';
import { canonicalizeRequest } from '../gate/sign.js';

/**
 * The canonical form of an action request, via the gate's OWN function.
 *
 * Deliberately not reimplemented. An earlier module in this directory
 * copied the chain's key-sorting rule locally to avoid coupling, and the
 * executor correctly flagged that a future divergence would be silent.
 * Here the coupling is the point: both sides of this comparison must agree
 * forever, and the only way to guarantee that is to call one function.
 */
function canon(actionRequest) {
  return canonicalizeRequest(actionRequest);
}

/** Pull the file-path parameter out of a request, if it has one. */
function pathParamOf(request) {
  const params = (request && request.params) || {};
  for (const k of PATH_PARAMS) {
    if (typeof params[k] === 'string' && params[k].length > 0) return params[k];
  }
  return null;
}

/**
 * May a grant carry this request at all?
 * Returns null if fine, or a reason string if it must be refused.
 *
 * File-bearing actions are checked against the non-delegable core.
 *
 * Command-bearing actions are NOT statically analysable: what a shell
 * command touches cannot be known from its text. This function does not
 * pretend otherwise, because pretending is the overclaim this project
 * keeps catching in itself. The control for a command is the same one that
 * makes a single-use token trustworthy — a human read the exact string
 * before signing it — and a grant changes only how many times that exact
 * string may run, never whether it was reviewed.
 */
function requestRefusalReason(request) {
  if (!request || typeof request !== 'object') return 'request is not an object';
  if (typeof request.action !== 'string' || request.action === '') return 'request has no action';
  const p = pathParamOf(request);
  if (p) {
    const c = classifyPath(p);
    if (c.verdict !== 'grantable') {
      return `request names '${p}' which is ${c.verdict} (${c.reason})`;
    }
  }
  return null;
}

/**
 * @param {Object} grant
 * @param {Object} ctx - { sessionId, actionRequest, now, usesSoFar }
 * @param {Object} [publicKey] - node:crypto KeyObject for the owner's Ed25519 pubkey
 * @returns {{ allow: boolean, reason: string, matchIndex?: number }}
 */
function checkGrant(grant, ctx, publicKey) {
  try {
    if (!grant || typeof grant !== 'object') {
      return { allow: false, reason: 'grant is not an object' };
    }
    if (!ctx || typeof ctx !== 'object') {
      return { allow: false, reason: 'verifier context is missing' };
    }

    // 1. signature
    if (typeof grant.signature !== 'string' || grant.signature.length === 0) {
      return { allow: false, reason: 'grant is not signed' };
    }
    if (!publicKey) {
      return { allow: false, reason: 'verifier has no publicKey' };
    }
    if (!verifyGrantSignature(grant, publicKey)) {
      return { allow: false, reason: 'signature verification failed' };
    }

    // 2. session
    if (ctx.sessionId !== grant.sessionId) {
      return { allow: false, reason: 'session mismatch: grant is bound to a different session' };
    }

    // 3. expiry
    const now = Number(ctx.now);
    const expiresAt = Number(grant.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      return { allow: false, reason: 'grant has no expiresAt' };
    }
    if (!Number.isFinite(now)) {
      return { allow: false, reason: 'verifier now is not a number' };
    }
    if (now > expiresAt) {
      return { allow: false, reason: `grant expired (now=${now} > expiresAt=${expiresAt})` };
    }

    // 4. action ceiling
    const maxActions = Number(grant.maxActions);
    if (!Number.isFinite(maxActions) || maxActions <= 0) {
      return { allow: false, reason: 'grant has no valid maxActions' };
    }
    const usesSoFar = Number(ctx.usesSoFar);
    if (!Number.isFinite(usesSoFar) || usesSoFar < 0) {
      return { allow: false, reason: 'verifier usesSoFar is not a non-negative number' };
    }
    if (usesSoFar >= maxActions) {
      return { allow: false, reason: `action ceiling reached (usesSoFar=${usesSoFar}, maxActions=${maxActions})` };
    }

    // 5 and 6. enumerated requests
    if (!Array.isArray(grant.requests) || grant.requests.length === 0) {
      return { allow: false, reason: 'grant enumerates no requests' };
    }
    if (!ctx.actionRequest || typeof ctx.actionRequest !== 'object') {
      return { allow: false, reason: 'no action request to check' };
    }

    let wanted;
    try {
      wanted = canon(ctx.actionRequest);
    } catch (e) {
      return { allow: false, reason: `could not canonicalize the request: ${e.message}` };
    }

    let matchIndex = -1;
    for (let i = 0; i < grant.requests.length; i++) {
      // A grant carrying ANY request it should never have been issued for
      // is refused entirely, rather than skipping the bad entry while a
      // good one matches. A tainted grant is evidence of a problem with the
      // grant, not with the one request being asked about.
      const bad = requestRefusalReason(grant.requests[i]);
      if (bad) {
        return { allow: false, reason: `grant carries a request it may not: ${bad}; refusing the grant` };
      }
      let c;
      try {
        c = canon(grant.requests[i]);
      } catch {
        return { allow: false, reason: `grant carries an uncanonicalizable request at index ${i}` };
      }
      if (c === wanted && matchIndex === -1) matchIndex = i;
    }

    if (matchIndex === -1) {
      return { allow: false, reason: 'this action is not one of the requests the grant enumerates' };
    }

    return { allow: true, reason: 'ok', matchIndex };
  } catch (err) {
    // Fail closed. NEVER let an exception become an allow.
    return { allow: false, reason: `verifier threw: ${err && err.message ? err.message : String(err)}` };
  }
}

export { checkGrant, requestRefusalReason, pathParamOf };
