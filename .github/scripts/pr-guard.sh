#!/usr/bin/env bash
# PR intake guard. Usage: pr-guard.sh <base-sha> <head-sha> <is-fork: true|false>
# Fails (exit 1) on anything that needs the owner's eyes before review starts.
# It reads the diff only. It never runs code from the PR.
set -euo pipefail

base="$1"; head="$2"; fork="$3"
fail=0
files=$(git diff --name-only "$base"..."$head")

note() { echo "::error::$1"; fail=1; }

# 1. Core lands at a signing sitting, never through a PR. Propose it as
#    proposals/<name>.patch plus a rehearsal test instead.
core=$(printf '%s\n' "$files" | grep -E '^(src/(gate|policy|chain|store|grant)/|bin/hook-)' || true)
if [ -n "$core" ]; then
  note "PR edits non-delegable core directly. Submit a patch under proposals/ with a rehearsal test. Files:"
  printf '  %s\n' $core
fi

# 2. Outside PRs that change what runs on install, test or CI.
if [ "$fork" = "true" ]; then
  supply=$(printf '%s\n' "$files" | grep -E '^(package\.json|package-lock\.json|\.github/|\.gitattributes|\.npmrc)' || true)
  if [ -n "$supply" ]; then
    note "Outside PR changes install, test or CI behavior; owner review required before anything else. Files:"
    printf '  %s\n' $supply
  fi
fi

# 3. No em dashes added anywhere (existing ones are not this PR's problem).
emdash=$(printf '\xe2\x80\x94')
added=$(git diff --unified=0 "$base"..."$head" | grep '^+' | grep -v '^+++' | grep -c "$emdash" || true)
if [ "$added" -gt 0 ]; then
  note "PR adds $added line(s) containing an em dash. Use a period, comma, colon or parentheses."
  git diff --unified=0 "$base"..."$head" | grep -E "^(\+\+\+ |\+.*$emdash)" | grep -B1 "$emdash" | grep -v '^--$' | head -40
fi

# 4. A PR that touches src/ must re-stamp the KNOWN-LIMITS pin in the same PR.
if printf '%s\n' "$files" | grep -q '^src/' && ! printf '%s\n' "$files" | grep -qx 'KNOWN-LIMITS.md'; then
  note "PR changes src/ but not KNOWN-LIMITS.md. Run: npm run limits-pin -- --stamp, and commit the pin."
fi

if [ "$fail" -eq 0 ]; then echo "guard: clean"; fi
exit "$fail"
