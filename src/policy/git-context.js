/**
 * src/policy/git-context.js
 *
 * C3: the push-protected rule matches the ref the COMMAND TEXT names. A bare
 * `git push` from a checked-out main names nothing, so the rule never fires.
 * The protected target is git STATE, not string state — this module resolves
 * that state for the PreToolUse hook, bounded so the gate can never wedge.
 *
 * RESOLUTION CONTRACT
 *   resolvePushContext(cwd) returns one of:
 *     { status: 'resolved', branch, upstreamBranch, pushDefault }
 *     { status: 'unresolved', reason }
 *   Every git invocation is wrapped in a hard 2s timeout and any error —
 *   timeout, missing git, not a repo, detached HEAD, no upstream under
 *   `simple` — resolves to 'unresolved' with the reason. The CALLER decides
 *   what unresolved means (the C3 rule gates on it: a target that cannot be
 *   resolved is refused rather than silently allowed).
 *
 * WEDGE PREVENTION (C3 acceptance #3): this module must never hang the
 * session. The timeout is the hard floor; there is no retry, no interactive
 * prompt, and nothing reads stdin. Two subprocess calls total, only for
 * push-shaped commands, ~15-40ms warm.
 */

import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 2000;

function gitRead(cwd, args) {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return out.trim();
  } catch {
    return null;
  }
}

/** The bare name of the upstream branch, e.g. `main` from `origin/main`. */
function upstreamBranchName(upstreamRef) {
  if (!upstreamRef) return null;
  const parts = upstreamRef.split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : parts[0];
}

/**
 * Resolve what a bare `git push` would actually update. Never throws.
 * @param {string} cwd
 * @returns {{status:'resolved', branch:string|null, upstreamBranch:string|null, pushDefault:string, unborn:boolean}|{status:'unresolved', reason:string}}
 */
export function resolvePushContext(cwd) {
  if (!cwd || typeof cwd !== 'string') return { status: 'unresolved', reason: 'no working directory' };

  // 1. Current branch. symbolic-ref works on unborn branches where rev-parse
  //    --abbrev-ref reports a fatal on HEAD; detached HEAD fails it, which is
  //    what we want (unresolved).
  const branch = gitRead(cwd, ['symbolic-ref', '--short', 'HEAD']);
  if (branch === null || branch === '') {
    return { status: 'unresolved', reason: 'detached HEAD or not a git repository' };
  }

  // 1b. An unborn branch (fresh init, no commits) has nothing to push: git
  //     itself refuses, so the push cannot ship anything. Resolve it as a
  //     fact rather than an error.
  const headVerified = gitRead(cwd, ['rev-parse', '--verify', 'HEAD']);
  const unborn = headVerified === null;

  // 2. push.default (empty config means `simple`, git's default).
  const configured = gitRead(cwd, ['config', '--get', 'push.default']);
  const pushDefault = configured || 'simple';

  // 3. Upstream ref, when push.default needs it.
  const upstreamRef = gitRead(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstreamRef === null && (pushDefault === 'simple' || pushDefault === 'upstream')) {
    return { status: 'unresolved', reason: `no upstream under push.default=${pushDefault}` };
  }

  return { status: 'resolved', branch, upstreamBranch: upstreamBranchName(upstreamRef), pushDefault, unborn };
}

/** Does this command carry an explicit branch refspec we can see as text? */
export function hasExplicitPushRef(cmd) {
  if (/\b(main|master)\b/.test(cmd)) return true; // the old matcher's class
  if (/:[^\s"'|&;]+/.test(cmd)) return true;      // refspec colon: local:remote
  const after = cmd.split(/\bgit\s+push\b/)[1] || '';
  const tokens = after.split(/\s+/).filter(Boolean);
  let positional = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (t === '-u' || t === '--set-upstream' || t === '--set-upstream-to') i++; // consumes the next token as the branch
      continue;
    }
    positional++;
  }
  return positional >= 2; // `git push <remote> <branch>` names the ref
}
