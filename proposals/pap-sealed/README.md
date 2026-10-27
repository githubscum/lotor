# Sealed PAP bundles: queued core patch (WO-CARTRIDGE-SEAL part A)

`src/publish` and every script in `bin/` are core (`src/grant/core-paths.js`
CORE_DIRS; `src/publish` was classified core at the 2026-08-09 sitting). So sealed
mode is a patch, not a commit, and lands one signature per target.

## Files

- `../make-pap-sealed-patch.mjs` generates `../pap-sealed.patch`. It reads the
  current core files read only, refuses if any moved from the base it was written
  against, and runs `git diff --no-index` over temp old/new trees. The patch is
  never typed by hand (KNOWN-LIMITS 80).
- `src.publish.seal.js`, `bin.pap-export.js`, `bin.pap-boot.js`, `bin.pap-keygen.js`:
  proposed whole files. Flat names, because a path containing a core directory is
  gated for any write, in any checkout.
- `manifest.v2-block.txt`, `pack.sealed-block.txt`: blocks the generator splices
  into `src/publish/manifest.js` and `src/publish/pack.js`. The rest of those files
  is untouched, and v1 bundles stay byte for byte.

## At the sitting (from the live install, after the PR merges)

1. `node proposals/make-pap-sealed-patch.mjs` (ordinary): regenerate; must report
   6 files and the same byte count as the committed patch. `git diff --exit-code
   proposals/pap-sealed.patch` must be clean.
2. One signed `git apply` per target, each named on the command line so the gate
   sees it (KNOWN-LIMITS 82):
   `git apply --include=src/publish/seal.js proposals/pap-sealed.patch`, then
   `manifest.js`, `pack.js`, `bin/pap-export.js`, `bin/pap-boot.js`,
   `bin/pap-keygen.js`. Six signatures.
3. `npm run limits-pin -- --stamp` (src/ moved), then `npm test`. Expected: the 29
   sealed tests run instead of skipping, the 3 rehearsal tests skip (LANDED), 0 fail.
   (The 5 docs tests in `test/pap-sealed-docs.test.js` run before and after.)

## Review amendments (wringer, 2026-10-26)

Two things the sitting should know changed after the first draft of this patch:

- The outer signature of a v2 bundle covers `"lotor/pap/v2/outer" 0x00 || manifest`.
  Vectors made before the amendment do not verify; the committed ones are the new ones.
- `seal.js` exports no function that encrypts under a caller-supplied key. Low-level
  sealing for tests and vector generation lives in
  `test-data/pap-vectors/seal-primitives.mjs` (test only, no safety limits, never
  imported from `src/` or `bin/`).
4. Optional live check: `node bin/pap-keygen.js --out <tmp>/me`, export a sealed
   bundle to `<tmp>/me.pub`, `pap-boot` it with no key (exit 5) and with the key
   (exit 0).
