# Proposal: store tail-only append (PR #72), core, staged for the signing sitting

Files in this folder:

- `index.js`: the exact replacement for `src/store/index.js`.
- `store-tail-append.patch`: the same change as a diff against `src/store/index.js` at `main` (blob `4ae6197`).
- `run-against-candidate.mjs`: a test-only module hook that runs the suite (or the bench) against `index.js` before it lands.

## Landing (one commit)

1. Review `store-tail-append.patch`.
2. Under signature, replace `src/store/index.js` with `proposals/store-tail-append/index.js`.
3. **In the same commit**, set `PENDING_LANDING = {}` in `test/store-tail-append.test.js`. Not in a follow-up. Until this flip, the tests that need the candidate run as `todo`, and a `todo` failure does not fail `npm test`.
4. Run `npm test`. Expect 0 todo and 0 fail.

The flip cannot be silently forgotten: the "landing tripwire" test in `test/store-tail-append.test.js` fails `npm test` when the store module in place exports `readChainTail` (the candidate landed) while `PENDING_LANDING` still marks tests `todo`, and also in the reverse case (flipped, but not landed). Under the hook it instead checks that the redirect really fired.

Before wiring V3-04, have `src/reasoning` pass `{ withChain: false }` (separate PR).

## The one documented divergence from the old path

The bytes written are identical to the old full-read path in every case except one class of file: one whose number of parseable lines is not `tail.seq + 1`, because an entry line before the last was lost or added (overwritten with garbage, deleted, or duplicated, by hand or by disk damage). The old path took `seq = parseable count`, which reuses or skips a seq already on disk. The tail path takes `tail.seq + 1`. `prevHash` is the same on both. Such a chain already fails `verifyChain` at the gap (prevHash link) before and after the append. A chain written only by the store never falls in this class, including after a torn-tail glue.

The fast path does not fall back here because detecting the class needs the parseable-line count, which is the full read the fast path exists to avoid. Nothing in the tail carries that count in O(1). The test "the one documented divergence" pins the behaviour for all three variants (replaced, deleted, duplicated).

Check at the sitting, before landing: on the live chain, the last entry's `seq + 1` must equal the number of parseable entries. If it does not, the live chain is in the divergent class and the first append after landing will choose a different seq than the old code would have.

## Separate core item for the owner's sitting: `verifyChain` does not check `seq` continuity

Not part of this PR, and `src/chain` is not touched here. Found by the second-family review of #72 (Finding 2), pre-existing on `main`.

`verifyChain` (`src/chain/index.js`) checks hash recomputation, signature, the genesis `prevHash`, and `prevHash` linkage. It never looks at `seq`. A writer that signs an entry with a wrong `seq` (a duplicate, a skip) produces a chain that verifies `{ ok: true }` while its numbering is wrong, and anything that reports or reads `entry.seq` as the receipt's position (for example `receiptSeq`, which `src/gate` returns for every decision) is then wrong by an unknown amount. The hash covers `seq`, so it cannot be changed after signing; the hole is only at write time.

Suggested check: inside the existing loop in `verifyChain`, after the signature check, require `Number.isSafeInteger(entry.seq) && entry.seq === i` and otherwise return `{ ok: false, brokenAt: i, reason: 'seq discontinuity at entry i: expected i, got <seq>' }`. `verifyChain` already assumes a full chain from genesis (entry 0 must carry the genesis `prevHash`), so `seq === i` is the matching invariant, and every store-written chain as `loadChain` sees it satisfies it (the 8-process and two-process concurrency tests assert `seq` runs `0..n-1`, and a torn-tail glue reuses the lost seq, so the loaded view stays contiguous). Before landing, scan the live chain for `seq !== index`; any hit means the check would turn a currently-verifying chain red, and that is a finding to resolve first, not a reason to drop the check. Add a chain test that signs a valid entry with a skipped `seq` and expects `brokenAt` at it.
