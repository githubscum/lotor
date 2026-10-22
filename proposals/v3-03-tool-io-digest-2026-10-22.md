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
  "response": { "recorded": true, "digest": "<64 hex>", "bytes": 54, "error": false }
}
```

or, when there was nothing to see:

```json
"toolIo": { "schema": "toolio/1", "response": { "recorded": false, "reason": "absent" } }
```

`reason` is `absent` (no `tool_response` in the host payload), `null` (the host
sent `null`), or `unserializable` (circular, BigInt, a bare function). There is
no digest key at all in that case, so no reader can mistake it for a digest.

All of the logic lives in `src/toolio/index.js` (not core, tested on the branch):
CRLF folded to LF in every string leaf, keys sorted recursively with the
`params/1` canonicalizer (now exported from `src/parser/index.js` rather than
copied), full SHA-256, UTF-8 byte length, and the host's error flag copied
tri-state (`null` means no signal, never success). The module's header comment
is the full contract.

The hook change is one import and one property:

- `proposals/v3-03-tool-io-digest-2026-10-22.patch`, hunks 1 and 2:
  `bin/hook-post-tool-use.js`.
- Hunk 3 flips `WIRED` to `true` in `test/hook-post-tool-use-toolio.test.js`, so
  its five wiring tests stop being TODO and become ordinary tests.

## Applying it at the sitting

```
git apply proposals/v3-03-tool-io-digest-2026-10-22.patch
npm test
```

Checked on the branch with `git apply --check --cached` (exit 0, no offset).
Before staging, the five wiring tests were run against a scratch copy of the
hook with this exact `toolIo` line added: 5 of 5 pass. Against the unpatched
hook they fail and are reported as TODO. That is the fail-first evidence.

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
the receipt regardless of response size. No new chain I/O: it rides on a
receipt the hook already writes.
