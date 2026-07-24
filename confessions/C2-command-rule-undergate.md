# LOTOR-C2 — A dangerous command that a gated rule does not catch

**State:** open
**Difficulty:** hard
**Touches:** the command rules (`src/policy`): `self-mod`, `destructive`,
`push-protected`, `opaque-exec`
**Source:** KNOWN-LIMITS items 11 and 21

## The confession

The rules that read a command line reason about its text, not about what it will
do. They match strings. Strings are evadable, and an adversarial review on
2026-07-24 found several of them cutting the wrong way at once: `self-mod` fired
only for the `Bash` tool while PowerShell ran free; the destructive allowlist
matched substrings, so `rm -rf ./templates` was exempted because `temp` is
inside `templates`; `opaque-exec` was disabled by a read verb appearing anywhere
in the string. Six under-gating defects, found and fixed the same day, each with
a named regression test.

The confession is not that those six existed. It is that the class did, and a
class does not close because you found six members of it. This is a matcher.
There is a seventh case. This card is a bounty on finding it.

## Scope

**In bounds:**

- A command that **should** be gated by an existing rule (`self-mod`,
  `destructive`, `push-protected`, `opaque-exec`) and flows free, in the honest
  agent class: a plausible command a real session might run, not a contrived
  cipher. The 2026-07-24 fixes are the bar; find what they missed in the same
  spirit.
- A canonicalization mismatch: an input the matcher normalizes one way and the
  shell executes another, so what the rule checks is not what runs.
- New shells, new path-quoting tricks, new separators the segment-splitter does
  not split on.

**Out of bounds:**

- Adversarial-grade obfuscation for its own sake: building a verb from
  concatenated fragments, base64-through-eval, a purpose-built wrapper binary
  the matcher cannot see into. KNOWN-LIMITS 11 already concedes this class in
  writing. v1's threat model is the honest agent going off script, not a model
  engineering around the matcher, and a fix here cannot un-concede that. If your
  evasion requires the agent to be actively hostile and clever, you have
  confirmed a documented limit, not found a new one.
- The over-gating cases (a false denial). Those are recorded as by-design in
  KNOWN-LIMITS 21; making the gate quieter is the expensive direction and is not
  what this card rewards.

## Acceptance

A real fix shows all of:

1. The command, and a demonstration it flows free today: run it through the gate
   and show no denial and no matching receipt.
2. Why it belongs in the honest-agent class, in one honest paragraph. This is the
   judgment call, and the review is adversarial on exactly this point.
3. The rule change that closes it, plus a regression test in the repo's style
   (see `test/selfmod-covers-core.test.js` for the shape) that fails against the
   unfixed code and passes against yours. Paste both runs. A test that passes
   before and after your change is worth less than none.
4. An answer to the standing question for this matcher: does your change make the
   gate quieter, and if so, what does it now miss? Any relaxation has to carry
   that answer.
5. A signed Lotor receipt of the session you did the work in.

## What you get

Attribution on the close, credit in CHANGELOG, and standing to claim the crypto
cards that are not on this board. This is the hardest of the three because the
judgment in acceptance step 2 is real: the line between a new hole and a
restatement of limit 11 is exactly where the value is. Land on the right side of
it and you have done work the 2026-07-24 review did not.
