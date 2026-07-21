# agent-receipts

A local-first, MCP-native receipt layer for AI agent sessions.

## What it is

This tool writes a signed, tamper-evident log of what an agent did during a session: actions performed, files touched, messages sent, costs incurred, failures encountered. The log lives on your machine, in a format you can inspect, verify, and archive. It does not attempt to prove the agent's actions were correct, only to record them faithfully and make any subsequent tampering detectable.

## Claim discipline

Provable priority, not enforced credit. This is bookkeeping: their books, and now yours.

Measurement, not indictment. A receipt records what the session self-reports; it does not judge intent or catch silent failures.

Self-attested capture. The log begins at signing time. What happened before that moment is not covered by the tamper-evidence chain.

## Quickstart

Prerequisites: Node.js >= 18. Install dependencies with `npm install`.

Run the test suite:

```bash
npm test
```

### Connect the MCP server to a Claude client

Point your client at `src/mcp/server.js` over stdio. See [MCP-SETUP.md](./MCP-SETUP.md) for the exact config block and the three tools it exposes (`query_receipts`, `verify_chain`, `gated_action`).

### The gated-action loop at a glance

```bash
npm run approve:init
```

The owner sets a passphrase once. The private key is derived from that passphrase at signing time and is never written to disk. Only the public key is stored.

Ingest a session, then run a gated action. Without an owner-signed approval token the gate DENIES by default (fail closed); with a valid token bound to that exact action it APPROVES. Both directions append a receipt to the signed chain.

```bash
npm run ingest -- test-data/sample-session.jsonl
npm run gate -- --action-file test-data/sample-action.json
npm run approve -- --action-file test-data/sample-action.json --out my-token.json
npm run gate -- --action-file test-data/sample-action.json --token-file my-token.json
```

### Verify the chain and view receipts

```bash
npm run receipts
```

`npm run receipts` prints a summary of every receipt and the chain-integrity result. The MCP `verify_chain` tool reports the same integrity check to a connected client.

See [DEMO.md](./DEMO.md) for the full runnable walkthrough and [KNOWN-LIMITS.md](./KNOWN-LIMITS.md) for scope.

## Known limits

See [KNOWN-LIMITS.md](./KNOWN-LIMITS.md).
