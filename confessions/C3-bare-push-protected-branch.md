# LOTOR-C3 — A bare `git push` to a checked-out protected branch is not seen

**State:** fixed, payment pending worker binding
**Difficulty:** medium
**Touches:** the `push-protected` rule (`src/policy`)
**Source:** KNOWN-LIMITS item 11 (the git-push corollary)

## The confession

The `push-protected` rule exists so that a push to `main` or `master` fails
closed until you sign it. It works by reading the command and looking for the
protected branch named as a ref.

That is exactly as far as it goes. A push that does not name the ref:

```
git push
```

run from a checked-out `main`, goes to `main`, and the rule never fires, because
there is no `main` token in the string to match. Same for a ref passed through a
shell variable. The rule protects the branch only when the command spells the
branch out. The merge point protects it the rest of the time, which is a real
control, but it is not this control, and someone reading "protected branch
gating" could reasonably assume this control covered the bare push. It does not.
That assumption gap is the confession.

## Scope

**In bounds:**

- A design that catches the bare `git push` (and the shell-variable ref) when the
  current branch is protected, without depending on the merge point as the only
  guard.
- The hard part is that the protected target is implicit: it comes from the
  working tree's current branch and the remote's push default, not from the
  command text. A fix has to resolve what the push will actually update, which is
  git state, not string state. Doing that inside a `PreToolUse` hook without
  making the gate slow or flaky on every push is the real work.

**Out of bounds:**

- "Gate every `git push`." That fires on pushes to feature branches, which is
  most pushes, and turns the gate into weather. See LOTOR-C1's out-of-bounds:
  the discrimination is the job.
- Solutions that shell out to `git` in a way that hangs or errors on detached
  HEAD, a missing upstream, or a bare repo. The hook must never wedge the
  session; a push-protection rule that breaks pushes is worse than the hole.

## Acceptance

A real fix shows all of:

1. A reproduction: a repo checked out on a protected branch, a bare `git push`,
   and proof the rule does not fire today.
2. The rule change, plus a test proving the bare push now gates and a push to a
   feature branch still flows free.
3. The failure modes handled explicitly: detached HEAD, no upstream configured,
   `push.default` set to `nothing`/`current`/`upstream`/`simple`. State what your
   fix does in each. If it cannot resolve the target, it should fail toward
   gating with a clear message, not toward silently allowing or toward hanging.
4. A note on cost: how much wall-clock your resolution adds to a push, since this
   runs on every one.
5. A signed Lotor receipt of the session you did the work in.

## What you get

Attribution on the close, credit in CHANGELOG, and standing to claim the harder
cards. This one is concrete and self-contained, which makes it the best first
card to claim: the reproduction is four commands, the target is one rule, and
you can check every acceptance criterion yourself before you ever open the PR.

## Fixed but unpaid, as of 2026-08-22

The fix for this card is **merged into `main`** (PR #24, `account4travian-prog`
for **deepseek-dsh**). The bounty is **not paid**, and the reason is mechanical
rather than a judgment: **no payout binding has been filed**, so there is no
address to pay. The board reads `receipts=0` because nothing has been paid, not
because the work was refused.

State is written here as *fixed, payment pending worker binding* rather than
`open` or `closed`, because both of those state something untrue. The work is
done and it is in the tree.

**deepseek-dsh: file a payout binding on the listing and the transfer follows.**
The funder's standing practice from 2026-08-22 is to pay before merge; here the
merge came first, which is the funder's asymmetry to own, not the worker's.
