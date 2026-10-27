#!/usr/bin/env bash
# PR intake guard. Usage: pr-guard.sh <base-sha> <head-sha> <is-fork: true|false>
# Fails (exit 1) on anything that needs the owner's eyes before review starts.
# It reads the diff only. It never runs code from the PR.
# The one piece of code it does run is the BASE commit's core-paths.js, which
# is already trusted (it is what the gate itself loads), never the PR's copy.
set -euo pipefail

base="$1"; head="$2"; fork="$3"
fail=0
files=$(git diff --name-only "$base"..."$head")

note() { echo "::error::$1"; fail=1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Node on Windows (local dry-runs under Git Bash) needs a native path.
npath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

# 1. Core lands at a signing sitting, never through a PR. Propose it as
#    proposals/<name>.patch plus a rehearsal test instead.
#
#    The core list is CORE_DIRS / CORE_FILES from src/grant/core-paths.js as it
#    exists on the BASE commit. The PR's own copy is never read: a PR could
#    edit that file to exempt itself. The module imports only node builtins,
#    so it can be loaded as-is, which keeps the guard exact instead of a
#    second hand-copied list that drifts. Anything that goes wrong here fails
#    closed. There is no fallback list and no empty list.
if ! git show "$base:src/grant/core-paths.js" > "$work/core-paths.mjs" 2>"$work/show.err"; then
  echo "::error::guard cannot read src/grant/core-paths.js at base $base; refusing to guess the core list. $(cat "$work/show.err")"
  exit 1
fi

cat > "$work/classify.mjs" <<'EOF'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const die = m => { console.error(`core-list: ${m}`); process.exit(2); };

let mod;
try {
  mod = await import(pathToFileURL(path.resolve(process.argv[2])).href);
} catch (e) {
  die(`could not load base core-paths.js: ${e.message}`);
}

const okList = a =>
  Array.isArray(a) && a.length > 0 &&
  a.every(s => typeof s === 'string' && s.length > 0);
if (!okList(mod.CORE_DIRS)) die('CORE_DIRS missing, empty or malformed');
if (!okList(mod.CORE_FILES)) die('CORE_FILES missing, empty or malformed');

// Same matching as classifyPath(): unconditional lowercase, exact match for
// files, whole-segment ancestry for directories (src/gateway is not src/gate).
// Backslashes are treated as separators too: more matches is the safe side.
const fold = s => s.toLowerCase();
const files = mod.CORE_FILES.map(fold);
const dirs = mod.CORE_DIRS.map(d => fold(d).split('/'));

const input = fs.readFileSync(0, 'utf8').split('\0').filter(Boolean);
const hits = [];
for (const raw of input) {
  const rel = fold(raw.replace(/\\/g, '/'));
  const segs = rel.split('/');
  let core = files.includes(rel);
  if (!core) {
    for (const d of dirs) {
      if (segs.length > d.length && d.every((s, i) => segs[i] === s)) { core = true; break; }
    }
  }
  if (core) hits.push(raw);
}
process.stdout.write(hits.join('\n') + (hits.length ? '\n' : ''));
EOF

# --no-renames so a file moved OUT of a core directory still shows its old path.
if ! git diff --name-only -z --no-renames "$base"..."$head" \
    | node "$(npath "$work/classify.mjs")" "$(npath "$work/core-paths.mjs")" > "$work/core.out" 2>"$work/core.err"; then
  echo "::error::guard could not derive the core list from base core-paths.js; refusing to guess. $(cat "$work/core.err")"
  exit 1
fi
core=$(cat "$work/core.out")
if [ -n "$core" ]; then
  note "PR edits non-delegable core directly. Submit a patch under proposals/ with a rehearsal test. Files:"
  printf '%s\n' "$core" | sed 's/^/  /'
fi

# 2. Outside PRs that change what runs on install, test or CI.
if [ "$fork" = "true" ]; then
  supply=$(printf '%s\n' "$files" | grep -E '^(package\.json|package-lock\.json|\.github/|\.gitattributes|\.npmrc)' || true)
  if [ -n "$supply" ]; then
    note "Outside PR changes install, test or CI behavior; owner review required before anything else. Files:"
    printf '  %s\n' $supply
  fi
fi

# 3. A PR that touches src/ must re-stamp the KNOWN-LIMITS pin in the same PR.
if printf '%s\n' "$files" | grep -q '^src/' && ! printf '%s\n' "$files" | grep -qx 'KNOWN-LIMITS.md'; then
  note "PR changes src/ but not KNOWN-LIMITS.md. Run: npm run limits-pin -- --stamp, and commit the pin."
fi

if [ "$fail" -eq 0 ]; then echo "guard: clean"; fi
exit "$fail"
