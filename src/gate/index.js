/**
 * src/gate/index.js
 *
 * Gated action that FAILS CLOSED without signed approval.
 * Emits denial receipt on rejection, approval receipt on success.
 *
 * Security model:
 * - No token or invalid token → DENIED (fail closed)
 * - Valid token → APPROVED
 * - Both outcomes are recorded as receipts on the chain
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadApprovalPubkey,
  canonicalizeRequest,
  nonceUsed,
  recordNonce,
  getPaths
} from './sign.js';
import { withLock } from '../store/lock.js';
import { digestParamsCanonical } from '../parser/index.js';
import { matcherVersionHash } from '../policy/index.js';

const DEFAULT_BASE_DIR = '.';

// KNOWN-LIMITS 30: edit tokens are fungible per file.
//
// For Edit/Write/NotebookEdit the canonical signed request is the file_path
// alone (content deliberately unsigned, limit 27), so every token for a given
// file validates against every edit to that file. Tokens are single-use by
// nonce but interchangeable, and they ACCUMULATE: a second signature for a
// path banks in pending-approvals/ and silently authorizes the next edit to
// that file, whatever its content. N banked tokens for a core path assemble
// into exactly the standing grant requestRefusalReason() refuses to issue.
//
// THE FIX is the direction limit 30 itself calls "the smallest and probably
// the right one": spending one token for a canonical request PURGES every
// other stored token carrying that same request, inside the same lock that
// records the nonce. The operator approved an ACTION, not a credit balance.
// Deleting an authorization only ever reduces capability (same reasoning as
// limit 19 for grants), so this fails safe and needs no signature of its own.
//
// Residuals, declared rather than hidden:
//   - A token whose request DIFFERS from the spent one is untouched. That is
//     correct (batch-signing several different files in one sitting is a
//     legitimate flow) but it means accumulation across DISTINCT requests is
//     not addressed here; each distinct request still needs its own signature.
//   - The purge reads pending-approvals/*.json synchronously under the lock.
//     Token files are few and small; if that directory ever grew large this
//     would lengthen the critical section. Unmeasured at scale.

// Approval token freshness (limit 16).
//
// A token with no expiry is valid until its nonce is spent, so an approval
// signed a week ago still authorizes an action attempted today. This bounds it.
//
// 60 minutes is chosen for the away-signing case: the owner may sign from a
// phone over their own VPN, and the gap between signing and the agent's retry is
// realistically seconds to minutes, occasionally longer. A tighter window would
// produce false failures in the workflow this exists to serve, and every false
// failure teaches the operator to sign faster and read less (limit 26).
//
// NOT a security boundary on its own: it reads the system clock, so moving the
// clock backward widens it, exactly as limit 20 already notes for grant expiry.
// The clock-proof bound remains the single-use nonce. Two ceilings, one
// clock-dependent and one not, matching how grants already work.
const APPROVAL_MAX_AGE_MS = 60 * 60 * 1000;

// A token stamped in the future is a clock problem or a forged one. Allow a
// little skew, reject the rest.
const APPROVAL_FUTURE_SKEW_MS = 120 * 1000;

/**
 * Verify an approval token against the stored approval public key.
 *
 * @param {Object} actionRequest - The action request { action, params? }
 * @param {Object} approvalToken - The token { request, nonce, timestamp, signature }
 * @param {string} baseDir - Base directory (default: '.')
 * @returns {Object} { valid: boolean, reason?: string }
 */
function verifyApproval(actionRequest, approvalToken, baseDir = DEFAULT_BASE_DIR) {
  try {
    // Check token structure
    if (!approvalToken || typeof approvalToken !== 'object') {
      return { valid: false, reason: 'approval token missing or malformed' };
    }

    const { request, nonce, timestamp, signature } = approvalToken;

    if (!request || !nonce || !timestamp || !signature) {
      return { valid: false, reason: 'approval token missing required fields' };
    }

    // Freshness (limit 16). Checked here because it is the cheapest rejection
    // available and needs no I/O. The reason string tells the operator to
    // re-sign, since a stale-token denial that read like a mismatch would send
    // them hunting the wrong problem.
    const age = Date.now() - Number(timestamp);
    if (!Number.isFinite(age)) {
      return { valid: false, reason: 'approval token timestamp is not a number' };
    }
    if (age > APPROVAL_MAX_AGE_MS) {
      const mins = Math.round(age / 60000);
      return {
        valid: false,
        reason: `approval token is stale (signed ${mins} min ago, limit ${APPROVAL_MAX_AGE_MS / 60000} min). Re-sign the request.`
      };
    }
    if (age < -APPROVAL_FUTURE_SKEW_MS) {
      return {
        valid: false,
        reason: 'approval token timestamp is in the future (check the system clock)'
      };
    }

    // Load approval public key
    let pub;
    try {
      pub = loadApprovalPubkey(baseDir);
    } catch (e) {
      return { valid: false, reason: 'approval public key not initialized' };
    }

    // Canonicalize the actual request
    const canonicalActual = canonicalizeRequest(actionRequest);

    // Verify the token's request matches the actual actionRequest
    if (request !== canonicalActual) {
      return { valid: false, reason: 'approval token request mismatch (token was for different action)' };
    }

    // Replay protection: check nonce hasn't been used
    if (nonceUsed(nonce, baseDir)) {
      return { valid: false, reason: 'approval token nonce already used (replay detected)' };
    }

    // Verify signature
    const signData = { request, nonce, timestamp };
    const signBuf = Buffer.from(JSON.stringify(signData, Object.keys(signData).sort()), 'utf8');

    const pubKeyJwk = { crv: 'Ed25519', x: pub.b64, kty: 'OKP' };
    const pubKeyObj = crypto.createPublicKey({ key: pubKeyJwk, format: 'jwk' });

    const sigBuf = Buffer.from(signature, 'hex');
    const sigOk = crypto.verify(null, signBuf, pubKeyObj, sigBuf);

    if (!sigOk) {
      return { valid: false, reason: 'signature verification failed' };
    }

    return { valid: true };
  } catch (e) {
    // ANY error during verification → fail closed
    return { valid: false, reason: `verification error: ${e.message}` };
  }
}

/**
 * KNOWN-LIMITS 30: after a token's nonce is recorded as spent, delete every
 * OTHER stored token in pending-approvals/ whose request equals the spent
 * token's request. Surplus signatures for the same action can no longer bank.
 *
 * MUST be called inside the same withLock() critical section that records the
 * nonce, so two hook processes cannot race between one spending and another
 * consuming the surplus. Deleting only ever reduces capability, so any failure
 * here is best-effort: an un-deleted surplus is the pre-fix behavior (limit
 * 30), never something worse.
 *
 * Malformed or unreadable files are skipped: the purge deletes what it can
 * CLASSIFY as surplus, never whatever it cannot parse.
 *
 * @param {string} spentRequest - canonical request string of the spent token
 * @param {string} spentNonce - nonce of the token just spent (never self-delete by match alone)
 * @param {string} baseDir - LOTOR home directory
 * @returns {number} count of surplus tokens deleted
 */
function purgeSurplusTokens(spentRequest, spentNonce, baseDir = DEFAULT_BASE_DIR) {
  let dir;
  try {
    const { KEYS_DIR } = getPaths(baseDir);
    // Tokens live in <home>/pending-approvals/, sibling of keys/.
    dir = path.join(path.dirname(KEYS_DIR), 'pending-approvals');
  } catch {
    return 0;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(dir, name);
    try {
      const token = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!token || typeof token !== 'object') continue;
      if (token.request === spentRequest && token.nonce !== spentNonce) {
        fs.unlinkSync(full);
        deleted++;
      }
    } catch {
      // Unreadable/malformed file: leave it. The purge classifies before it deletes.
    }
  }
  return deleted;
}

/**
 * Execute a gated action with optional approval token.
 * FAILS CLOSED: absent a valid approval, returns denial and appends denial receipt.
 *
 * @param {Object} actionRequest - { action, params? }
 * @param {Object} approvalToken - Optional approval token
 * @param {Object} chain - Chain instance to append receipts to
 * @param {string} baseDir - Base directory (default: '.')
 * @returns {Object} { decision: 'approved'|'denied', reason?, approvalNonce?, receiptSeq? }
 */
function gatedAction(actionRequest, approvalToken, chain, baseDir = DEFAULT_BASE_DIR, meta = {}) {
  // meta is informational only. It never enters canonicalizeRequest and never
  // appears in verifyApproval. Fields read from meta today: ruleId, heldMs.
  // Anything the receipt needs that is NOT part of the signed action lives here.
  const action = actionRequest?.action || 'unknown';
  const timestamp = Date.now();

  // Fail closed: if no token, deny immediately
  if (!approvalToken) {
    const receipt = {
      type: 'gated-action',
      decision: 'denied',
      action,
      ruleId: meta.ruleId || null,
      paramsDigestCanonical: digestParamsCanonical(actionRequest?.params),
      heldMs: Number.isFinite(meta.heldMs) ? meta.heldMs : null,
      matcherHash: matcherVersionHash(),
      reason: 'no approval token provided',
      timestamp
    };
    const entry = chain.append(receipt);
    return {
      decision: 'denied',
      reason: 'no approval token provided',
      receiptSeq: entry.seq
    };
  }

  // Verify the token
  const verifyResult = verifyApproval(actionRequest, approvalToken, baseDir);

  if (!verifyResult.valid) {
    // Classify the reason into the 4-way enum. Today `verifyApproval` returns
    // reasons that fall into two families: a wrong-action token
    // ("approval token request mismatch (token was for different action)")
    // and a stale-token token ("approval token is stale (signed N min ago ...)").
    // The mismatch case stays plain `denied`. The stale case becomes
    // `stale_signature` because the token was once valid for this action, the
    // operator signed it on time, and the gap is a clock thing (or a
    // staging/retry delay exceeding the 60-min ceiling). `unreachable` is
    // reserved for engine-side faults and is produced by the hook, not here.
    const reason = verifyResult.reason || 'verification failed';
    const isStale = /stale|future/i.test(reason);
    const decision = isStale ? 'stale_signature' : 'denied';

    const receipt = {
      type: 'gated-action',
      decision,
      action,
      ruleId: meta.ruleId || null,
      paramsDigestCanonical: digestParamsCanonical(actionRequest?.params),
      heldMs: Number.isFinite(meta.heldMs) ? meta.heldMs : null,
      matcherHash: matcherVersionHash(),
      reason,
      timestamp
    };
    const entry = chain.append(receipt);
    return { decision, reason, receiptSeq: entry.seq };
  }

  // Valid token. The nonce check-and-record must be atomic across PROCESSES:
  // Claude Code spawns one PreToolUse process per tool call, so N concurrent
  // uses of the SAME single-use token would each pass verifyApproval's nonce
  // check and each record, double-spending one signature. This is KNOWN-LIMITS
  // 20's race on the token path the grant fix missed. Re-check and record inside
  // the chain lock so a second process sees the recorded nonce and is denied.
  const nonce = approvalToken.nonce;
  let replay = false;
  withLock(baseDir, () => {
    if (nonceUsed(nonce, baseDir)) { replay = true; return; }
    recordNonce(nonce, baseDir);
    // KNOWN-LIMITS 30: the nonce is now ours, so this token is SPENT on this
    // action. Purge every other stored token with the same request inside the
    // same critical section — an operator approved an action, not a credit
    // balance, and a surplus sibling must not survive to authorize the next
    // edit to the same file. Best-effort by design (deleting only reduces
    // capability); the action is already approved and stays approved.
    try {
      purgeSurplusTokens(approvalToken.request, nonce, baseDir);
    } catch {
      // never let the purge break the spend path
    }
  });

  if (replay) {
    const receipt = {
      type: 'gated-action',
      decision: 'denied',
      action,
      ruleId: meta.ruleId || null,
      paramsDigestCanonical: digestParamsCanonical(actionRequest?.params),
      heldMs: Number.isFinite(meta.heldMs) ? meta.heldMs : null,
      matcherHash: matcherVersionHash(),
      reason: 'approval token nonce already used (replay detected)',
      timestamp
    };
    const entry = chain.append(receipt);
    return {
      decision: 'denied',
      reason: 'approval token nonce already used (replay detected)',
      receiptSeq: entry.seq
    };
  }

  // Nonce is ours. Append the approval receipt. chain.append locks internally;
  // it runs AFTER the nonce lock above is released, so the two never nest.
  const receipt = {
    type: 'gated-action',
    decision: 'approved',
    action,
    ruleId: meta.ruleId || null,
    paramsDigestCanonical: digestParamsCanonical(actionRequest?.params),
    heldMs: Number.isFinite(meta.heldMs) ? meta.heldMs : null,
    matcherHash: matcherVersionHash(),
    approvalNonce: nonce,
    timestamp
  };
  const entry = chain.append(receipt);

  return {
    decision: 'approved',
    approvalNonce: nonce,
    receiptSeq: entry.seq,
    ruleId: meta.ruleId || null,
    paramsDigestCanonical: digestParamsCanonical(actionRequest?.params),
    heldMs: Number.isFinite(meta.heldMs) ? meta.heldMs : null
  };
}

/**
 * Check if the approval key has been initialized.
 * @param {string} baseDir - Base directory (default: '.')
 * @returns {boolean}
 */
function isApprovalKeyInitialized(baseDir = DEFAULT_BASE_DIR) {
  const { APPROVAL_PUB_KEY } = getPaths(baseDir);
  return fs.existsSync(APPROVAL_PUB_KEY);
}

export {
  gatedAction,
  verifyApproval,
  isApprovalKeyInitialized
};
