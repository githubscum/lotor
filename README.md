# Lotor

A local-first, MCP-native receipt layer for AI agent sessions.

## What it is

This tool writes a signed, tamper-evident log of what an agent did during a session: actions performed, files touched, messages sent, costs incurred, failures encountered. The log lives on your machine, in a format you can inspect, verify, and archive. It does not attempt to prove the agent's actions were correct, only to record them faithfully and make any subsequent tampering detectable.

## The other half of reliability

The argument getting loud right now is that you cannot have agentic systems that are reliable unless they can predict the consequences of their actions. That is true, and it is only the front half. Prediction is the front of reliability. The record is the back. A world model guesses what an action will do. A receipt states what it did. You need both, and only one of them is something you can hold in your hand today.

Lotor is the back half. It does not give your agent a world model. It gives you the ground truth of what your agent actually did, signed, ordered, and tamper-evident, so that "reliable" stops being a claim and starts being a record you can check.

And it keeps that record where it belongs. The other warning in the same breath is about culture: if the world's information diet runs through a handful of proprietary engines, that is the end of local culture, and no system is ever truly unbiased. The same centralization is happening one layer down, quietly, to the record of what your agents do for you. Most accountability tools are cloud observability proxies. Your agent's activity flows through their servers, and your own history becomes inventory in someone else's books.

Lotor is routed local first. The receipt is written to your machine before anything else happens to it. Nothing leaves unless you sign a scoped disclosure and choose to send it. That is the whole distinction, not a deployment checkbox and not an enterprise tier. The record of what your machines did for you lives with you, survives whichever vendor you were renting this quarter, and answers to your key, not their retention policy.

That is what a receipt means when the models centralize and the agents multiply. Your books. Local first. The floor that does not move when the vendor does.

## Use cases

Lotor is one primitive, a signed local receipt, applied wherever "what did my agent actually do" is a question you need answered honestly.

- **Session accountability.** End every interactive session with a signed receipt: what ran, what it touched, what it sent, what it cost, what failed. Failures are surfaced, not buried.
- **Overnight and unattended runs.** Wake up to a morning-after record of what an agent did while you were not watching, instead of a pile of transcripts you will never read.
- **Gated high-stakes actions.** Make destructive or irreversible actions (delete, deploy, send, spend) fail closed until you sign an approval bound to that exact action and its exact parameters. The denial and the approval are both receipted.
- **Proof of your side.** When a client, vendor, or counterparty disputes what happened, you have your own signed record. Their books, and now yours.
- **Tamper-evidence.** The chain detects after-the-fact alteration of the log. It does not prove the events were complete or truthful at capture time (see Known limits), but it proves the record has not been changed since.
- **Feeding your own memory.** Receipts are durable, structured input to your own long-horizon agent memory, not telemetry for a vendor's dashboard.
- **Vendor-churn survival.** Switch models or providers whenever you want. The record stays on your machine and stays readable. Your history does not belong to whichever engine you were renting.
- **Scoped disclosure.** When you do need to share a record (an audit, a client hand-off, a bug report), you sign a scoped, redacted view and send only that. The default is that nothing leaves.

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
