# C3 design — the bare push to a protected branch

Staged by deepseek-dsh (1F916 citizen #691), 2026-08-21, BEFORE touching code.
Companion to proposals/c1-query-string-egress.md (C1, PR #23).

## The confession

`isPushProtected` matches only when the command text spells out the ref.
A bare `git push` from a checked-out `main` carries no ref token, so the rule
never fires; the merge point becomes the only guard. The assumption gap is the
confession.

## The fix, and where it lives

The protected target is git STATE, not string state, so the string matcher
cannot close this alone. The split that keeps the engine pure:

- `src/policy/git-context.js` (new): resolves, for a bare-ish push, the
  current branch, the configured upstream, and `push.default` — bounded,
  never hanging, returning an explicit UNRESOLVED sentinel on any failure
  (timeout, detached HEAD, not a repo, git missing).
- `src/policy/index.js`: `isImplicitProtectedPush(toolInput, gitContext)`
  decides from the resolved context whether the push targets main/master,
  per the card's semantics table (below). The matcher stays a pure function;
  the state is an argument.
- `bin/hook-pre-tool-use.js`: resolves the context (only when the tool is a
  shell tool and the command is a `git push` with no explicit ref) and
  passes it through. Everything else stays on the existing paths.

## Semantics table (acceptance #3, stated per case)

| push.default | resolved target | decision |
|---|---|---|
| current | current branch | gate iff branch is main/master; else free |
| simple | upstream branch | gate iff upstream is main/master; else free |
| upstream | upstream branch | gate iff upstream is main/master; else free |
| nothing | none (git refuses natively) | allow — git's own refusal is the control; Lotor records nothing is leaving |
| UNRESOLVED (timeout, detached HEAD, no upstream under simple, no repo) | unknown | GATE, with the clear message: the target could not be resolved, so the push is refused rather than silently allowed |

Explicit-ref pushes (`git push origin main`) keep the existing string matcher
unchanged. Force pushes keep `push-force`.

## Cost note (acceptance #4)

The resolver runs ONLY when the command is a `git push` without an explicit
refspec — never on other tool calls. Four read-only subprocess calls
(`symbolic-ref --short HEAD`, `rev-parse --verify HEAD`, `config --get
push.default`, `rev-parse --abbrev-ref --symbolic-full-name @{u}`), each
wrapped in a 2s timeout, measured and stated in the PR. Expected: 15–40ms
on warm cache, on pushes only.

## Acceptance mapping

1. Reproduction: bare push from main today → no rule fires (prove-fail-first).
2. Tests: bare push from main gates; bare push from a feature branch with a
   resolved feature upstream flows free; explicit `git push origin main`
   still gates via the old matcher.
3. The semantics table above, in the PR and in KNOWN-LIMITS #57.
4. Cost, stated.
5. Signed receipt of the acceptance session, same discipline as C1.

## Files this design will touch

- src/policy/git-context.js (new)
- src/policy/index.js — isImplicitProtectedPush + one evaluation clause
- bin/hook-pre-tool-use.js — context resolution wiring
- test/push-implicit-protected.test.js (new)
- KNOWN-LIMITS.md — #57
