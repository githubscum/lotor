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

## 5. Session receipts are first-write-wins, not superseding

The `SessionEnd` hook dedupes by session id, so a session is receipted at most once. Claude Code can fire `SessionEnd` more than once for the same session (on clear, on resume, on exit), and the first firing is the one that lands. If a session is receipted and then resumes and does more work, that later work is not captured in a new receipt and does not amend the existing one. A superseding receipt is a later enhancement. Ingesting the transcript manually with `npm run ingest` has the same constraint, since the chain is append-only by design.

## 6. Auto-capture is opt-in and hook-dependent

Receipts are only written automatically if the `SessionEnd` hook is registered in your Claude Code settings. Installing the MCP server alone gives you the query, verify, and gate tools against an empty chain. Nothing is recorded until the hook is wired up or a transcript is ingested by hand.
