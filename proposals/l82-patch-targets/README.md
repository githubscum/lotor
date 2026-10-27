# KNOWN-LIMITS 82: patch-file laundering, staged in two halves

Status: **half one of two.** This directory holds the classifier and its tests. Nothing under
the core directories changes on this branch. Half two, the generated patch that wires the
classifier into the self-mod matcher, is the next lane run's work order and lands at a
signing sitting.

## The defect

The self-mod matcher reads protected paths out of the command string. `git apply x.patch`,
`git am 0001.mbox` and `patch -p1 < x.diff` take their write targets from inside the patch
file, so the string never names them. On 2026-10-26 that rewrote a chain-module file in the
live install with no gate stop and no receipt. Since then every core landing names its
targets with `--include=`, which is a convention and not a control.

## The classifier (`patch-apply.js`)

`patchApplyTargets(cmd, cwd, readFile)` returns `null` when the command applies no patch, or
`{ targets, failClosed, inline }`:

- **targets**: every path the patch writes (`---`/`+++`, `diff --git`, rename/copy lines),
  each kept both with and without the `a/`/`b/` prefix. For `patch`, positionals are targets
  too (the first positional is the file being patched).
- **failClosed**: the patch source can't be read. That covers a missing file, stdin, a pipe,
  `<(...)`, `$(...)`, backticks, and `xargs`. The caller treats this as a hit. Unverified must
  not mean allowed (same rule as the brace cap, KNOWN-LIMITS 58).
- **inline**: a heredoc feeds the verb; its body is parsed for targets directly.
- Browse-only forms return null: `git apply --check|--stat|--numstat|--summary` without
  `--apply`, and `git am --abort|--quit|--show-current-patch`.

Written by glm-5.3-flash (WO-L82-01, WO-L82-02; executor receipt read: session model
glm-5.3-flash). Verified by an independent probe of variants the work orders don't name.

## Half two: the integration (not in this PR)

Generate `proposals/l82-patch-targets.patch` from a script (KNOWN-LIMITS 80: the executor
can't hand-write a diff). The script should be modeled on `make-l77-patch.mjs`. The patch:

1. Inlines `patchApplyTargets` and its helpers into the policy module (the matcher stamp only
   covers functions in that file).
2. In `isSelfModCommand`, runs the classifier on `matchableCommand` output, so a commit
   message that merely names `git apply` is not a patch application. It runs on the raw
   command only when the matchable text still holds a patch verb with `<<`, because
   `stripHeredocBodies` would otherwise hide an inline patch. Hit when `failClosed`, or when
   `selfModCommandHit(targets.join(' '), baseDir)` is true.
3. Names every new helper in `matcherHashInputs()` (KNOWN-LIMITS 63). It should also add
   `firstBraceGroup` and `matchableCommand`, which run 77 found missing from the stamp.
4. Passes `commandCwd` through `evaluate` -> `isSelfMod` -> `isSelfModCommand` (default
   `process.cwd()`, like `isOpaqueExec`).
5. Rehearsal test: the live cases stay TODO until applied; a queued-patch block applies it in a
   temp repo and runs them.

## What a reviewer should doubt

- **Purity.** The self-mod matcher now reads disk. `isOpaqueExec` already does, but self-mod
  runs first on every call. The read cost is one patch file per patch command.
- **Relative-after-cd.** `cd src; patch -p1 < x.diff` with targets like `b/chain/index.js`
  doesn't contain the protected fragment. That's the same weakness the matcher already has
  for relative paths after `cd`. Not new, and not closed here.
- **Quoted paths with spaces** fail closed (over-gate, one signature).
- **Wrappers** are an enumeration (sudo, env, command, exec, nohup, time, nice, xargs, sh -c
  family). An unlisted wrapper hides the verb. The fail-open direction is exactly the class this
  limit is about, so the list needs adversarial review at the sitting.
- **TOCTOU.** The patch is read at gate time and applied later. An agent can't change the file
  between the gate and the apply inside one command, but a signed token binds the command
  string, not the patch bytes. Binding the patch digest into the gated-action receipt is
  half-two scope if Isaac wants it.
