# Contributing to Lotor

Outside work is welcome here, and it lands with your name on it. Lotor is a gate that people trust to stop things, so the bar for what reaches `main` is high and stated up front. If a pull request clears it, it merges. If it comes close, we will help it the rest of the way rather than close it.

## What a pull request needs

1. **One change.** One limit closed, one bug fixed, one feature. Split anything else.
2. **Current base.** Rebased on `main` when you open it and again if `main` moves under you. A stale base hides conflicts that only appear after merge.
3. **Fail-first evidence.** Say in the description which new test fails on `main` and passes on your branch, and how you checked. A test that passes either way proves nothing.
4. **Green CI on both platforms.** Tests run on Linux and on Windows, where files check out with CRLF line endings. Line endings have broken this codebase twice (see `KNOWN-LIMITS.md` 77 and 81).
5. **The log kept honest.** If your change opens, narrows or closes a limit, update `KNOWN-LIMITS.md`. Numbers run without gaps; if an open pull request already claims the next number, take the one after and say so. Any change under `src/` re-stamps the pin in the same pull request: `npm run limits-pin -- --stamp`.
6. **No em dashes.** Use a period, comma, colon or parentheses. CI checks the lines you add.

## Core changes

These paths are the gate itself: `src/gate/`, `src/policy/`, `src/chain/`, `src/store/`, `src/grant/`, and `bin/hook-*`. Changes to them never merge through a pull request. They land in the live install at a signing session, one owner signature per change.

To propose one, add the patch under `proposals/<name>.patch`, generated with `git diff`, never typed by hand, and add a rehearsal test that fails without the patch and passes with it. CI rejects a pull request that edits those paths directly.

## Install, test and CI files

From outside contributors, changes to `package.json`, `package-lock.json`, `.github/`, `.gitattributes` or `.npmrc` stop for owner review before anything else happens. Explain why the change is needed. New dependencies need a strong reason.

## How review works

Every pull request gets an adversarial review. The question is not whether your tests pass. It is what the change could break that your tests do not cover. Expect probes against the existing controls: relative and absolute paths, quoting, case, brace expansion, line endings. A change that closes one gap and quietly opens another does not merge.

Code from outside contributors is read, never run on a maintainer's machine. CI is where it executes.

The verdict is one of three:

- **Merge.**
- **Not yet**, with the specific defect and what would fix it.
- **Sitting**, meaning a core change is queued for the next signing session.

"Not yet" holds until the defect is fixed.

## When it is close

If your pull request is nearly there and the remaining fix is small, a maintainer may carry it: your commits go onto a branch in this repository with your authorship intact, the fix goes on top, and merging that branch closes yours as merged. You keep the credit for what you wrote.

## Licence

By contributing you agree that your contribution is licensed under the Apache License 2.0, the licence of this repository.
