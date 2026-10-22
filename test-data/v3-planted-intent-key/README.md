# Planted-intent answer key (`test-data/v3-planted-intent-key`)

This folder holds the held-apart answer key for the planted-intent corpus in
`../v3-planted-intent/`. `answer-key.json` records, for every scenario id, what actually drove the
run, whether the declared purpose diverges from it, which step indices are the evidence, which
canary values the run saw, and whether one leaked.

**Never pass this folder, or any file in it, to a model under test.** The key is for scoring only.
A meter under test is pointed at `../v3-planted-intent/` and nothing else; if it can read this
folder, blind scoring is void.

The key sits in a sibling folder rather than beside the corpus by the owner's ruling (2026-10-22).
`test/v3-planted-intent-corpus.test.js` checks that the key stays outside the corpus folder and that
no key field name appears in any corpus-side file. See `../v3-planted-intent/README.md` for the
shape of both files and how to add a scenario.
