# DEMO — Gated Action with Fail-Closed Enforcement

This demo shows the complete flow: an agent proposes an action, the gate **fails closed** (denies without approval), the owner approves via cryptographic signature, and the action is then permitted with a tamper-evident receipt.

## Prerequisites

```bash
npm install
```

## Step 1: Initialize the approval key

The owner sets a passphrase once. The private key is **never written to disk** — it's derived from the passphrase at signing time.

```bash
npm run approve:init
```

You'll be prompted for a passphrase (and confirmation). Only the public key is written to `keys/approval.pub`.

## Step 2: Ingest a synthetic session

Create a session receipt (this simulates an agent session being logged):

```bash
npm run ingest -- test-data/sample-session.json
```

## Step 3: Attempt a gated action WITHOUT approval

The MCP server exposes `gated_action`. Without an approval token, it **denies by default**:

```bash
# Using the MCP tool directly
echo '{"action":"delete_sensitive_files","params":{"pattern":"*.key"}}' | \
  npx @modelcontextprotocol/sdk client call gated_action --server ./src/mcp/server.js
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
  "nonce": "a1b2c3d4e5f6",
  "timestamp": 1721563200000,
  "signature": "d4e5f6..."
}
```

Copy this JSON — it's the approval token.

## Step 5: Attempt the same action WITH approval

Now call `gated_action` with the approval token:

```bash
echo '{
  "action": "delete_sensitive_files",
  "params": {"pattern": "*.key"},
  "approvalToken": {
    "request": "{\"action\":\"delete_sensitive_files\",\"params\":{\"pattern\":\"*.key\"}}",
    "nonce": "a1b2c3d4e5f6",
    "timestamp": 1721563200000,
    "signature": "d4e5f6..."
  }
}' | npx @modelcontextprotocol/sdk client call gated_action --server ./src/mcp/server.js
```

**Expected response:**
```json
{
  "decision": "approved",
  "approvalNonce": "a1b2c3d4e5f6",
  "receiptSeq": 2
}
```

An **approval receipt** is appended to the chain. The action is now authorized.

## Step 6: Verify the chain

Both receipts (denial + approval) are in the chain:

```bash
npm run start -- verify_chain
```

Or via MCP:
```bash
echo '{}' | npx @modelcontextprotocol/sdk client call verify_chain --server ./src/mcp/server.js
```

**Expected:** `ok: true`, with `entryCount` showing both the session receipt and the two gated-action receipts.

## What This Proves

1. **Fail-closed enforcement**: Without a valid approval token, the action is denied. No prose to argue with — just a structured denial.
2. **Cryptographic binding**: The approval token is bound to the specific action. Use the token for a different action → denied.
3. **Replay protection**: Using the same token twice → denied (second time is replay).
4. **Tamper-evident receipts**: Both denial and approval are recorded on the signed chain. The owner can audit every gate decision.

## Known Limits (CP-3 honest gaps)

- **Self-attested capture**: The receipts are signed by the agent's chain key, not the owner's approval key. The owner verifies the token; the chain records the outcome. Full separation of concerns requires additional verification infrastructure.
- **Owner key storage**: The owner's public key is stored locally. Compromise of the agent-receipts directory could allow deletion of the approval key, but NOT forgery of owner signatures (private key never on disk).
- **Passphrase security**: The owner must keep their passphrase secret. No rate-limiting on passphrase attempts in v1.

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
                       │  Valid token? │
                       │  APPROVED +     │
                       │  receipt        │
                       └─────────────────┘
```

The gate is the enforcement primitive. It makes "you own these agents, not them" a demonstrated fact.
