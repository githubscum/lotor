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
action that is only now being attempted still verifies cleanly. Nonce-based
replay protection is real (a used token cannot be reused), but there is no
freshness window: staleness alone is not a rejection reason in v1.

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

## 21. The command rules match strings, not intent

Observed directly on 2026-07-23 and 2026-07-24 while working against the
gate. The examples below are `self-mod` unless noted, but the root cause is
shared by every rule that reads a command line, and `opaque-exec` is
confirmed to have it too:

- **It cannot tell reading from writing.** A `grep` or `cat` of a protected
  file is denied exactly like an edit, because both are commands containing
  the same path. Reading through a tool the rule does not cover is not denied,
  so the cost is inconsistent rather than uniformly high.
- **Prose counts.** A command that merely *names* a protected path, for
  example a commit message or a heredoc writing documentation about the gate,
  matches and is denied. Writing about the gate looks identical to modifying
  it.
- **Copying the repository is not matched, editing the copy is.** `git clone`
  of the whole tree, gate source included, is permitted because the command
  names no protected path. Editing a protected filename inside that copy is
  then denied, since matching is on the path rather than the location. The
  copy is therefore not a route around the rule, but the asymmetry is not
  something the rule was designed for.
- **`opaque-exec` has the same read/write blindness** (2026-07-24). Reading a
  PowerShell script with `sed` was denied under `opaque-exec`, the rule whose
  stated purpose is that handing control to a script the engine cannot read
  is an unverified action. Nothing is being handed control when the script is
  the argument to a pager. So the defect is not specific to `self-mod`: any
  rule matching on command text inherits it, and a second rule has now been
  confirmed to.

None of this is evadable-by-accident in the limit 11 sense, and the failures
lean toward denying too much rather than too little. It is recorded because
the cost of the gate is not evenly distributed, and because anyone extending
the rule set should know it reasons about text rather than about what a
command will do.

**Why this is harder to fix than it looks.** The obvious repair, exempting
commands that begin with a read verb, was tried on 2026-07-23 and opened a
hole within minutes: only the first token was checked, so a read verb
followed by a redirect could overwrite the very file the rule protects. The
test suite caught it and it was reverted whole. A correct fix has to classify
on whether a command can *mutate*, across an arbitrary shell string, on a
machine where the primary shell is PowerShell and the mutation can hide
inside a script the matcher cannot read. That is the same wall `opaque-exec`
exists to acknowledge, which is why the two rules share the defect.

The standing rule for this matcher, from the day the hole was opened: crying
wolf is the cheap failure and silence is the expensive one. Any change that
makes it quieter has to answer what it now misses.
