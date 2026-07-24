# The Lotor confession log

A confession is a defect disclosed by the party the disclosure costs. That is
what makes it worth reading. Anyone can publish a feature list. A board of your
own product's weaknesses, written against your own interest, is the one claim
in the whole repository that is expensive to fake.

This board is the live version of that idea. Every entry below is a real hole
in Lotor, stated plainly, with enough detail that you can reproduce it and
enough scope that you can close it. The point of the board is not to look
humble. It is to find the next hole. Discovery is the job. Closure is the
byproduct.

## How a confession works

Each card carries:

- **The confession.** What is wrong, in the plainest terms, with a file:line
  anchor so you are not taking my word for it.
- **Difficulty.** A rough read on how hard this is to close well. It is a
  signal, not a promise.
- **Scope.** What counts as in bounds, and what is explicitly out.
- **Acceptance.** What a real fix has to show. Written so you can check your own
  work before you submit, without me in the loop.
- **State.** Open until closed. A card nobody claims for months is an honest
  signal, published whether or not it flatters the project.

## How to claim one

To submit a fix you show your own **signed Lotor receipt** of the work. That is
not a hoop. It is the whole point: claiming a bounty means running the tool, and
the receipt is your evidence that you did the work you say you did. The campaign,
the install funnel, and the proof mechanism are one artifact.

1. Install Lotor and arm the gate (see the repo README). Do your work in a
   gated session.
2. Your session produces a signed receipt of what ran. That is your proof of
   work.
3. Open a PR with the fix, the regression test, and the receipt.

A claimed bounty is a proposal, not a merge. The fix still gets reviewed
adversarially, on the same brief every Lotor change gets: assume it is wrong and
find how. A fix that introduces a new hole is not a fix.

## What you get

Attribution and contributor status. Your name on the close, credit in the
changelog, and standing to claim the harder cards. No money in this round. The
first currency is being the person who found the thing, which for this crowd is
the currency that was ever real.

## The honest frame

These three are chosen because they are the string-matcher limits: the ones an
outside reader can see, reproduce, and reason about without a tour of the
internals. They are not the load-bearing crypto. The full list of what is wrong
with Lotor, including the parts that need no bounty because they need a signature
instead, lives in [KNOWN-LIMITS.md](https://github.com/githubscum/lotor/blob/main/KNOWN-LIMITS.md).
If you read that file and come back with a twenty-third entry, you have done
something better than close a bounty. You have proven the thesis.

## The board

Two tiers. **Achievements** reward running the tool at all, so an enthusiast who
just wants to participate can, with no security skill required. **Confessions**
reward finding a real hole. Both are claimed the same way: a signed Lotor receipt
of your work. The achievement is the on-ramp, and clearing it means the proof
mechanism for the harder bounties is already working on your machine.

### Achievements (start here)

| ID | Title | Difficulty | State |
|---|---|---|---|
| [A1](A1-armed-first-receipt.md) | Armed — install Lotor, arm the gate, earn your first signed receipt | trivial | **open** |

### Confessions (defect bounties)

| ID | Title | Difficulty | State |
|---|---|---|---|
| [LOTOR-C1](C1-egress-get-query-string.md) | Data leaves in a GET query string, ungated and uncaptured | medium | **open** |
| [LOTOR-C2](C2-command-rule-undergate.md) | A dangerous command that a gated rule does not catch | hard | **open** |
| [LOTOR-C3](C3-bare-push-protected-branch.md) | A bare `git push` to a checked-out protected branch is not seen | medium | **open** |
