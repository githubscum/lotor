# Known Limits

This document lists the v1 limitations of the receipt layer. Honesty about limits is a feature.

## 1. Self-attested capture

Tamper-evidence begins at signing time. The log proves that *what was recorded* has not been altered since, but it does not prove that the recorded events were complete, accurate, or truthful at the moment of capture. The receipt is only as good as the data fed into it.

## 2. Outbound message capture

The `sent` / outbound field in receipts is not fully derivable from Claude Code JSONL session transcripts alone. Full capture requires MCP-boundary instrumentation to record what actually left the machine versus what was merely logged locally.

## 3. No external anchoring in v1

The chain is local-only. External anchoring (to a timestamp authority, blockchain, or other notary) is a planned later enhancement. In v1, tamper detection relies on local key custody and periodic manual export/offsite backup.

## 4. Cost is reported in tokens, not dollars

Where the session transcript records per-turn token counts, receipts carry them. Dollar cost is not computed in v1: it requires an external, model-specific price table that is not bundled. Treat the cost column as token usage, not a billing figure.
