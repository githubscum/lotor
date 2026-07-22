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

## 7. A receipt can be dropped under lock contention

Chain appends take an exclusive lock so concurrent writers cannot corrupt the chain. The lock waits a bounded time (about five seconds) and then gives up. The `SessionEnd` hook treats that give-up like every other failure: it reports one line to stderr and exits 0, because a receipt layer that can wedge your editor is worse than a missing receipt.

The consequence is that under heavy contention, or if a lock is held by a process that is stuck but not yet stale, a session can end without being receipted. The failure is announced on stderr rather than silent, but nothing retries it later. The chain stays valid and no partial entry is written. You lose that one receipt, not the log.

## 8. The chain signing key is stored unencrypted

There are two keys and they are protected very differently.

The approval key, which authorizes gated actions, is never written to disk. It is derived from your passphrase at signing time, so only the public half is stored.

The chain key, which signs log entries for tamper-evidence, is written to `keys/chain.key` in plaintext (mode 0600 where the filesystem honors it). Anyone who can read that file can forge chain entries that verify cleanly. Tamper-evidence therefore assumes an attacker who can alter the log file cannot also read the key file, which is a weak assumption on a fully compromised machine. Hardware-backed key custody (TPM or secure enclave) is the fix and is not in v1.

## 9. The chain key is per-machine, so receipts do not verify across machines

The chain key is generated on first use and lives on that machine. Receipts written on one machine will not verify on another unless you copy the chain public key across. The approval key behaves differently: because it is derived from your passphrase, the same passphrase reproduces the same approval key anywhere. Expect a single-machine chain in v1.

## 10. Approval key strength is entirely passphrase strength

The approval key is derived with PBKDF2 (600,000 iterations, SHA-256) from your passphrase and a salt that is a compile-time constant, not a per-install random value. Two people who choose the same passphrase get the same approval key, and precomputation against that fixed salt is shared across every installation. Iteration count raises the cost of guessing but does not change the fact that a weak passphrase yields a weak key. Choose accordingly. A per-install random salt is a later change and would be a breaking one, since it alters key derivation.
