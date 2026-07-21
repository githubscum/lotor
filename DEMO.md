# DEMO — Gated Action with Fail-Closed Enforcement

This demo shows the complete flow: an agent proposes an action, the gate **fails closed** (denies without approval), the owner approves via cryptographic signature, and the action is then permitted with a tamper-evident receipt.

## Prerequisites

```bash
npm install
```

## Reset (to start fresh)

Remove the chain and keys to start with a clean slate:

```bash
rm -rf receipts/chain.jsonl keys/
```

## Step 1: Initialize the approval key

The owner sets a passphrase once. The private key is **never written to disk** — it's derived from the passphrase at signing time.

```bash
npm run approve:init
```

You'll be prompted for a passphrase (and confirmation). Only the public key is written to `keys/approval.pub`.

**Note:** This command requires a TTY and cannot be run in a non-interactive environment.

## Step 2: Ingest a synthetic session

Create a session receipt (this simulates an agent session being logged):

```bash
npm run ingest -- test-data/sample-session.jsonl
```

**Expected output:**
```
Ingested session. Chain entry seq=0, hash=<first-16-chars>...
```

## Step 3: Attempt a gated action WITHOUT approval

Without an approval token, the gate **denies by default**:

```bash
npm run gate -- '{"action":"delete_sensitive_files","params":{"pattern":"*.key"}}'
```

**Expected response:**
```json
{
  "decision": "denied",
  "reason": "no approval token provided",
  "receiptSeq": 1
}
```

A **denial receipt** is appended to the chain. This is the "fail closed" behavior — the gate defaults to DENY.

## Step 4: Owner creates an approval token

The owner approves a specific action by signing its canonical representation:

```bash
npm run approve -- '{"action":"delete_sensitive_files","params":{"pattern":"*.key"}}'
```

**Enter your passphrase** when prompted. The output is the approval token:

```json
{
  "request": "{\"action\":\"delete_sensitive_files\",\"params\":{\"pattern\":\"*.key\"}}",
  "nonce": "<base64url-nonce>",
  "timestamp": 1721563200000,
  "signature": "<hex-signature>"
}
```

Copy this JSON — it's the approval token.

**Note:** This command requires a TTY and cannot be run in a non-interactive environment.

## Step 5: Attempt the same action WITH approval

Now call `gate` with the approval token (paste the full token JSON as the second argument):

```bash
npm run gate -- '{"action":"delete_sensitive_files","params":{"pattern":"*.key"}}' '<paste-token-json-here>'
```

**Expected response:**
```json
{
  "decision": "approved",
  "approvalNonce": "<nonce-from-token>",
  "receiptSeq": 2
}
```

An **approval receipt** is appended to the chain. The action is now authorized.

## Step 6: View receipts

View both receipts (the session receipt + the gated action receipts) with the receipt view:

```bash
npm run receipts
```

**Expected:** A morning-after summary showing:
- Total chain entries: 3
- Session receipts: 1
- Gated actions: 1 approved, 1 denied
- Chain integrity: ✓ Chain intact

## What This Proves

1. **Fail-closed enforcement**: Without a valid approval token, the action is denied. No prose to argue with — just a structured denial.
2. **Cryptographic binding**: The approval token is bound to the specific action. Use the token for a different action → denied.
3. **Replay protection**: Using the same token twice → denied (second time is replay).
4. **Tamper-evident receipts**: Both denial and approval are recorded on the signed chain. The owner can audit every gate decision.

## Known Limits (CP-3 honest gaps)

See [KNOWN-LIMITS.md](KNOWN-LIMITS.md) for v1 limitations.

## Summary

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Agent proposes │────>│  Gate checks    │────>│  No token?      │
│  action         │     │  approval token │     │  DENIED + receipt│
└─────────────────┘     └─────────────────┘     └─────────────────┘
                              │
                              │ Owner signs
                              ▼
                       ┌─────────────────┐
                       │  Valid token?   │
                       │  APPROVED +     │
                       │  receipt        │
                       └─────────────────┘
```

The gate is the enforcement primitive. It makes "you own these agents, not them" a demonstrated fact.
