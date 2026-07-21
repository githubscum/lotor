# agent-receipts

A local-first, MCP-native receipt layer for AI agent sessions.

## What it is

This tool writes a signed, tamper-evident log of what an agent did during a session: actions performed, files touched, messages sent, costs incurred, failures encountered. The log lives on your machine, in a format you can inspect, verify, and archive. It does not attempt to prove the agent's actions were correct, only to record them faithfully and make any subsequent tampering detectable.

## Claim discipline

Provable priority, not enforced credit. This is bookkeeping: their books, and now yours.

Measurement, not indictment. A receipt records what the session self-reports; it does not judge intent or catch silent failures.

Self-attested capture. The log begins at signing time. What happened before that moment is not covered by the tamper-evidence chain.

## Quickstart

TODO(WO-B2-B5): Scaffold complete. Implementation follows.

## Known limits

See [KNOWN-LIMITS.md](./KNOWN-LIMITS.md).
