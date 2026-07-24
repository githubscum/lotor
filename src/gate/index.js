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

const DEFAULT_BASE_DIR = '.';

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
 * Execute a gated action with optional approval token.
 * FAILS CLOSED: absent a valid approval, returns denial and appends denial receipt.
 *
 * @param {Object} actionRequest - { action, params? }
 * @param {Object} approvalToken - Optional approval token
 * @param {Object} chain - Chain instance to append receipts to
 * @param {string} baseDir - Base directory (default: '.')
 * @returns {Object} { decision: 'approved'|'denied', reason?, approvalNonce?, receiptSeq? }
 */
function gatedAction(actionRequest, approvalToken, chain, baseDir = DEFAULT_BASE_DIR) {
  const action = actionRequest?.action || 'unknown';
  const timestamp = Date.now();

  // Fail closed: if no token, deny immediately
  if (!approvalToken) {
    const receipt = {
      type: 'gated-action',
      decision: 'denied',
      action,
      reason: 'no approval token provided',
      timestamp
    };
    const entry = chain.append(receipt);
    return { decision: 'denied', reason: 'no approval token provided', receiptSeq: entry.seq };
  }

  // Verify the token
  const verifyResult = verifyApproval(actionRequest, approvalToken, baseDir);

  if (!verifyResult.valid) {
    // Record nonce if it passed sig check but failed replay (already recorded)
    // The nonceUsed check inside verifyApproval already handles replay

    const receipt = {
      type: 'gated-action',
      decision: 'denied',
      action,
      reason: verifyResult.reason,
      timestamp
    };
    const entry = chain.append(receipt);
    return { decision: 'denied', reason: verifyResult.reason, receiptSeq: entry.seq };
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
  });

  if (replay) {
    const receipt = {
      type: 'gated-action',
      decision: 'denied',
      action,
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
    approvalNonce: nonce,
    timestamp
  };
  const entry = chain.append(receipt);

  return { decision: 'approved', approvalNonce: nonce, receiptSeq: entry.seq };
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
