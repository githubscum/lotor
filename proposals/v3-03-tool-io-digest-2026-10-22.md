# STAGED 2026-10-22: tool I/O digest on the post-tool-use receipt (v3 V3-03, rung R2)

Drafted 2026-10-22 by the V3-03 lane builder. **Not applied.** The hook edit is
`bin/`, which is non-delegable core, so it lands only at the owner's signing
sitting. Everything that is not core is already on the branch and tested.
Spec: the brain's `projects/meter/LOTOR-V3-SPEC-2026-10-18.md`, the R2 row and
evals E2 and E5. Companion to KNOWN-LIMITS 78.

## What is unrecorded today

The post-tool-use hook's `egress-event` receipt carries `responseDigest`: a
16-hex prefix of SHA-256 over `JSON.stringify(tool_response)`. Three problems
with it as an R2 record.

- **Key order changes it.** `JSON.stringify` keeps insertion order, so the same
  response built in a different order digests differently.
- **Line endings change it.** The same file read from a CRLF checkout and an LF
  checkout digests differently, so it answers "which checkout" rather than
  "which content".
- **Absence is spelled as a digest.** A missing, null or empty response is
  recorded as the string `'empty'` in the digest slot, so "Lotor did not see a
  response" and "the tool returned an empty string" read the same.

## The change

The receipt gains one field, beside the legacy ones, never replacing them:

```json
"toolIo": {
  "schema": "toolio/1",
  "hash": "<16 hex>",
  "response": { "recorded": true, "digest": "<64 hex>", "bytes": 54, "error": false }
}
```

or, when there was nothing to see:

```json
"toolIo": { "schema": "toolio/1", "hash": "<16 hex>", "response": { "recorded": false, "reason": "absent" } }
```

`reason` is `absent` (no `tool_response` in the host payload), `null` (the host
sent `null`), or `unserializable` (anything without an exact JSON form: a cycle,
BigInt, a function, `undefined`, a Date, NaN, an array hole). There is no digest
key at all in that case, so no reader can mistake it for a digest. `hash` is the
code stamp: which code produced the record, beside `schema`, which names the
method.

All of the logic lives in `src/toolio/index.js` (not core, tested on the branch):
CRLF folded to LF in every string leaf, keys sorted recursively into
null-prototype objects (byte-identical to the `params/1` canonicalizer except
that an own `__proto__` key is kept; `src/parser/` is not touched), full
SHA-256, UTF-8 byte length, and the host's error flag copied tri-state (`null`
means no signal, never success). Where it disagrees with the legacy
`responseOk`, `toolIo` is authoritative (KNOWN-LIMITS 78). The module's header
comment is the full contract.

The hook change is one import and one property:

- `proposals/v3-03-tool-io-digest-2026-10-22.patch`, hunks 1 and 2:
  `bin/hook-post-tool-use.js`.
- Hunk 3 flips `WIRED` to `true` in `test/hook-post-tool-use-toolio.test.js`, so
  its six wiring tests stop being TODO and become ordinary tests.

## Applying it at the sitting

```
git apply proposals/v3-03-tool-io-digest-2026-10-22.patch
npm test
```

**The gate on landing, not an expectation:** after the apply, the six tests in
the first `describe` of `test/hook-post-tool-use-toolio.test.js` must report
6 pass, 0 todo. If any is still TODO the flip did not apply; if any fails, the
wiring is wrong. Either way, do not commit the apply.

What runs before the sitting. The three tests in that file's second `describe`
are not TODO: they take the receipt the real, unpatched hook writes, add the
staged field in the staged position, sign it onto a real chain, and scan the
chain file on disk for response content (review F4). They also pin where the
legacy `responseOk` and `toolIo.error` agree and the three inputs where they do
not (F2), and that the engine-error receipt never gains the field (F8). What
they cannot cover is the hook itself calling `describeToolResponse`, which is
the staged line.

Checked on the branch with `git apply --check` (exit 0), both in a
`core.autocrlf=true` checkout and with the patch in LF form. Before the review
fixes it failed in the CRLF checkout ("corrupt patch"): two blank context lines
were written as empty lines rather than a single space, and a CR-terminated
empty line is not a context line to `git apply`. They are now a single space.
Before the review,
the original five wiring tests were run against a scratch copy of the hook
with the `toolIo` line added and passed 5 of 5 (the builder's claim, not
re-run). After the review fixes, the six wiring tests have **not** been run
wired: the self-mod gate blocks an Edit to `bin/hook-post-tool-use.js` even in
a scratch worktree, and the fix lane did not route around it. Two of the six
changed (the absent-case literal now includes `hash`; the precedence test is
new). Their assertions are exercised on the composed receipt in the second
`describe`, which runs today, but the 6 of 6 above is the sitting's to confirm.
Against the unpatched hook all six fail and are reported as TODO. That is the
fail-first evidence for the wiring. For the module, fail-first on main is
an import failure (`src/toolio/` does not exist), which proves only that; the
review-fix tests (stamp, `__proto__`, unserializable values) were also run
against the pre-review module and fail there for their own reasons. The
`toolio` entry added to `test/core-classification.test.js` records a
classification decision; it is not fail-first evidence and is not counted as
such.

Limit 73 applies: this is one signature for one file. Do not split the two
hook hunks into separate staged edits, or the second is purged when the first
is spent. If applying by Edit rather than `git apply`, make it one Edit that
covers both hunks, or one whole-file Write.

## What this deliberately does not do

- **It does not add a receipt per tool call.** Coverage stays the egress-event
  receipt. A per-step receipt is V3-04's, and attaching `toolIo` to it is the
  same one-line spread. See KNOWN-LIMITS 78 for the cost reason.
- **It does not touch `responseDigest` or `responseOk`.** Old readers keep
  working. Retiring them is a later, separate change.
- **It does not key the digest.** See KNOWN-LIMITS 78.

## Measured cost (eval E5, this machine, Node 24)

`describeToolResponse` per call: about 0.03 ms for a 1 KB response, 1 ms for
100 KB, 9.5 ms for 1 MB, 155 ms for 10 MB. The field adds about 155 bytes to
the receipt regardless of response size. Re-measured after the review fixes
(strict walk, code stamp), same shape of input, Node in the fix lane: 0.006 ms
at 1 KB, 0.15 ms at 100 KB, 1.9 ms at 1 MB, 17 ms at 10 MB; about 184 bytes per
receipt with the stamp. The two runs are different sittings on one machine, so
read them as the same order of magnitude, not as a speed-up. No new chain I/O: it rides on a
receipt the hook already writes.
