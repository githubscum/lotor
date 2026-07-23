# Known Limits

This document lists the v1 limitations of the receipt layer. Honesty about limits is a feature.

## 1. Self-attested capture

Tamper-evidence begins at signing time. The log proves that *what was recorded* has not been altered since, but it does not prove that the recorded events were complete, accurate, or truthful at the moment of capture. The receipt is only as good as the data fed into it.

## 2. Outbound message capture

Outbound activity is now captured live by a `PostToolUse` hook for egress-shaped tool calls (network requests, remote git operations, publish commands), using the same matchers the policy engine uses to decide what is gate-worthy. This is captured by the host at the moment the tool call completes, not reconstructed later from a transcript, which is a real improvement in attestation strength. It is still not wire-level capture: there is no network proxy, no TLS interception, and no independent verification that the tool's own implementation reported its outcome honestly. A tool that lies about its own `tool_response`, or an egress path this repo's matchers do not recognize, is not captured. True wire-level capture would require a network-boundary proxy, which is a larger architectural change and not in v1.

## 3. No external anchoring in v1

The chain is local-only. External anchoring (to a timestamp authority, blockchain, or other notary) is a planned later enhancement. In v1, tamper detection relies on local key custody and periodic manual export/offsite backup.

## 4. Cost is reported in tokens, not dollars

Where the session transcript records per-turn token counts, receipts carry them. Dollar cost is not computed in v1: it requires an external, model-specific price table that is not bundled. Treat the cost column as token usage, not a billing figure.

## 5. Session receipts are cumulative subsessions, not a single record

Claude Code fires `SessionEnd` more than once for the same session (on clear, on resume, on exit). Each firing that carries new activity appends a new receipt for that session, indexed `subsession` 0, 1, and so on. Nothing is ever amended or superseded, because the chain is append-only by design.

Two consequences worth knowing:

Each subsession receipt carries the whole session up to that moment, not just the new part. Subsession 2 is a superset of subsession 1. No single receipt is "the" record of a session; the highest subsession is the most complete one. Counting receipts is not the same as counting sessions, which is why the morning-after view reports both totals separately.

A firing that adds no new activity appends nothing, so repeated `SessionEnd` events cannot inflate the chain. Work done after the final firing is still never captured, since nothing runs after the last one.

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

## 11. The gate matches patterns, and patterns are evadable

The `PreToolUse` hook enforces Lotor's policy by pattern-matching the tool name and `tool_input`. v1's threat model is the honest agent making a consequential move without sign-off: accident, overreach, a naively followed injected instruction. The gate is not designed to withstand an adversarial model that is engineering around the matcher; command-string matching can be evaded by obfuscation (e.g. building the verb from fragments, using a wrapper binary, or running the dangerous action through a non-`Bash` tool name). If you need adversarial-grade containment, this is not the layer to rely on.

A few honest corollaries that follow from the same shape:

Engine errors fail open by design. A Lotor bug (policy unreadable, evaluator crash, store I/O failure) must not brick every tool call, so the hook reports on stderr, appends a best-effort receipt when it can, and exits 0. A gate that never lets a tool run is worse than a gate that occasionally lets one through with a note.

A bare `git push` to a checked-out protected branch is not detected. The `push-protected` rule fires only when the command explicitly names `main` or `master` as a ref. A `git push` with no ref, or with the ref given through a shell variable, flows free; the merge point, not the push, is what protects the branch.

Hook registration lives in the user's settings file, whose edits are themselves rule 1. A hostile edit landing between sessions is therefore only caught at the next session's snapshot, not in real time. Treat the registration surface as part of your threat model.

## 12. Pre-fix receipts are permanently ~2x inflated (cost/2 corrects this going forward)

Before 2026-07-22, the parser summed `message.usage` once per JSONL line. Claude Code
writes one assistant message across several lines (a text block, then one line per
`tool_use` block), and every one of those lines carries a byte-identical copy of the same
usage object. The parser counted it 2 to 6 times, so every token figure in every receipt
signed before this fix is inflated, empirically by a factor close to 2x (measured 2.083
and 2.035 on two independent real transcripts; verified exact, not heuristic, since zero
usage conflicts were found among lines sharing a `message.id`).

The fix (this commit) dedups usage by `message.id`, with a fallback to `requestId`, then
`uuid`, then a per-line key for entries that carry none. Receipts written from this point
forward carry `cost.schema: 'cost/2'`; its absence marks a receipt as pre-fix and roughly
double reality. Because the chain is append-only, no existing signed receipt can be
corrected or replaced. Old figures stand as signed and wrong. Do not trust a token count
on a receipt without a `cost.schema` field.

## 13. Cost is not attributed per model or per harness

`cost` is one flat total per session, summed across every assistant message regardless of
which model produced it. `session.model` records only the last model seen in the
transcript, overwritten on every assistant turn. It is not a breakdown: a session that
touches more than one model (for example, the orchestrating session on Claude plus work
dispatched mid-session to an Ollama-hosted model) reports a single blended total under a
single trailing model name.

This matters because different providers report token usage on fundamentally different
bases. One real comparison found a service reporting 702,944,347 input tokens with zero
cache activity, against another reporting 8,487 input tokens and 163,480,857 cache-read
tokens for comparable work. Summing across services, or reading `session.model` as "the
model this session's cost was incurred on," produces a number with no coherent meaning.
Per-model, per-harness cost attribution is not built. Treat any total from a mixed-model
session as directional at best, never as a cross-service comparison.

## 14. A session is only recorded if it ends cleanly

Capture is driven by `SessionEnd`. If a session is force-killed, crashes, hits
an OOM, or the machine loses power, that hook never fires and **no receipt is
written at all**. Not a partial one. None.

The failure mode is the wrong way round. The sessions most worth having a
record of are the ones that ended badly, and those are exactly the ones this
design drops. An operator reading the chain sees an unbroken sequence of
well-behaved sessions and has no way to tell that others existed.

The fix is to open the record at `SessionStart` rather than write it at the
end: anchor the session id, the policy in force, and the current chain head the
moment the session begins. An abnormal exit then leaves an opened-but-never-
closed entry, which is itself evidence rather than silence. Until that ships,
read the absence of a receipt as "unknown", never as "nothing happened".

Related: the gate only protects tool calls that occur after its `PreToolUse`
hook is registered and loading. Anything the harness runs before the gate is
live is ungated by construction, which is a second argument for the receipt
layer being the first thing spun up in a session rather than the last.
