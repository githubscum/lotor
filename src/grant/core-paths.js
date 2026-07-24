/**
 * staging-grant/core-paths.js
 *
 * The non-delegable core.
 *
 * REWRITTEN BY THE ORCHESTRATOR 2026-07-23, by hand, after the dispatched
 * version passed 32/32 of its own tests while failing open on five cases.
 * The original anchored every path to process.cwd() and returned "not core"
 * for anything that resolved outside it. An absolute path to the LIVE repo's
 * gate engine was therefore reported grantable, which is the exact one-hop
 * escalation this file exists to prevent.
 *
 * THE RULE THAT REPLACES IT
 *   A path is core if editing it could change what the gate permits.
 *   A path that cannot be proven to sit INSIDE the repository root is not
 *   "outside and therefore fine" — it is REJECTED. Unprovable means refused.
 *
 * WHY THE DEFAULT MUST BE REFUSE
 *   This predicate answers "may a signed grant cover this file?". Every
 *   ambiguous answer it gets wrong in the permissive direction hands an
 *   agent the ability to edit the thing that stops it. A false refusal
 *   costs one signature. A false permit costs the architecture. In this
 *   file, crying wolf is the cheap failure.
 *
 * NOT POLICY-CONFIGURABLE, BY CONSTRUCTION
 *   The list below is code. There is no file to read it from, no env var
 *   to extend it, and no argument that adds to it. A config file naming
 *   the non-delegable set would just be a delegable file that decides the
 *   non-delegable set.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Directories whose entire subtree is core. Listed as DIRECTORIES on
 * purpose: a file added to one of these later is protected the day it is
 * created, without anyone remembering to update this list. Enumerating
 * individual files here would fail open on every future addition, which
 * is one of the five defects in the version this replaces.
 */
const CORE_DIRS = Object.freeze([
  'bin',          // every hook, the gate CLI, approve, setup, mode
  'src/gate',     // the enforcement engine and the signing path
  'src/policy',   // what the rules ARE
  'src/chain',    // the append-only log's integrity
  'src/store',    // where the log and the keys live on disk
  'src/grant'     // this machinery, at its final Part B location
]);

/** Individual core files that do not live under a core directory. */
const CORE_FILES = Object.freeze([
  'src/home.js',          // decides where the keys and the chain live
  'src/registration.js'   // decides which hooks are believed registered
]);

/**
 * DELIBERATELY EXCLUDED, with reasons. Recorded so the next person to widen
 * this list has to argue against a stated position rather than guess.
 *
 *   src/mcp/      A client of the gate, not the gate. It cannot grant itself
 *                 anything; its requests traverse the same enforcement path.
 *                 Including it would make it permanently signature-gated,
 *                 and it is the file ordinary feature work has to touch.
 *
 *   src/views/    Rendering. It can mislead a human reader, which is a real
 *                 risk, but it cannot change what is permitted. Reporting
 *                 integrity and enforcement integrity are different problems
 *                 and conflating them makes the core large enough to be
 *                 useless, which is its own failure mode.
 *
 *   src/parser/   Reads transcripts. No authority over enforcement.
 *
 * KNOWN RESIDUAL GAP, stated rather than hidden: a NEW top-level file added
 * directly under src/ is not covered by default, because src/ as a whole
 * holds feature code that must stay grantable. If a future file at src/*.js
 * gains authority over enforcement, it must be added to CORE_FILES by hand.
 * bin/ has no such gap; it is covered wholesale.
 *
 * bin/view.js is core only by over-inclusion. That is a deliberate trade:
 * covering bin/ as a directory protects every hook added in future, and that
 * property is worth more than the convenience of editing one renderer.
 */

/**
 * Tool parameters that can carry a target file, in preference order.
 *
 * These are the subset of the gate's own SIGNED_PARAMS that name a file.
 * `command` and `url` are deliberately absent: what a shell command or a
 * URL touches cannot be determined from its text, so neither can be
 * checked against the core list. That is a real limit of this module and
 * it is stated rather than papered over.
 */
const PATH_PARAMS = Object.freeze(['file_path', 'path']);

/** Device, UNC and other namespace prefixes that defeat lexical reasoning. */
const REFUSED_PREFIXES = Object.freeze(['\\\\', '//', '\\\\?\\', '//?/', '\\\\.\\', '//./']);

const WIN = process.platform === 'win32';

/** Case folding for CORE matching is unconditional: more matches is safer. */
const fold = s => s.toLowerCase();

/** Case folding for CONTAINMENT follows the filesystem, not our preference. */
const foldFs = s => (WIN ? s.toLowerCase() : s);

let cachedRoot = null;

/**
 * Locate the repository root by walking up from this module until a
 * package.json is found. Works unchanged whether this file sits in
 * staging-grant/ (Part A) or src/grant/ (Part B), which is why the root is
 * not derived from process.cwd(). cwd is an accident of how a process was
 * launched and must never determine a security boundary.
 */
function resolveRepoRoot() {
  if (cachedRoot) return cachedRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      cachedRoot = dir;
      return cachedRoot;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('core-paths: could not locate the repository root; refusing to guess');
}

/**
 * Classify a path.
 *
 * @returns {{verdict: 'core'|'grantable'|'refused', reason: string, relative: string|null}}
 *
 *   core      — on the non-delegable list. No grant may ever cover it.
 *   grantable — provably inside the repository root and not core.
 *   refused   — malformed, escapes the root, or cannot be placed. Not an
 *               invitation to try harder; a grant naming it is rejected.
 */
function classifyPath(inputPath, repoRoot = resolveRepoRoot()) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { verdict: 'refused', reason: 'not a non-empty string', relative: null };
  }
  if (inputPath.includes('\0')) {
    return { verdict: 'refused', reason: 'contains a NUL byte', relative: null };
  }
  for (const p of REFUSED_PREFIXES) {
    if (inputPath.startsWith(p)) {
      return {
        verdict: 'refused',
        reason: `device or UNC prefix "${p}" defeats lexical containment`,
        relative: null
      };
    }
  }

  const root = path.resolve(repoRoot);
  // path.resolve handles absolute inputs, relative inputs, "." and ".." in
  // one step and on the platform's own rules. We never hand-roll traversal.
  let resolved;
  try {
    resolved = path.resolve(root, inputPath);
  } catch (e) {
    return { verdict: 'refused', reason: `unresolvable: ${e.message}`, relative: null };
  }

  // Containment. Equality with the root itself is not a file and is refused.
  const rootCmp = foldFs(root);
  const resCmp = foldFs(resolved);
  if (resCmp === rootCmp) {
    return { verdict: 'refused', reason: 'resolves to the repository root itself', relative: null };
  }
  if (!resCmp.startsWith(rootCmp + path.sep)) {
    return {
      verdict: 'refused',
      reason: 'resolves outside the repository root',
      relative: null
    };
  }

  const relative = fold(path.relative(root, resolved).split(path.sep).join('/'));

  for (const f of CORE_FILES) {
    if (relative === fold(f)) {
      return { verdict: 'core', reason: `core file ${f}`, relative };
    }
  }
  // Segment-wise ancestry, never raw string prefix: "src/gateway" must not
  // match the "src/gate" entry.
  const segments = relative.split('/');
  for (const d of CORE_DIRS) {
    const dirSegs = fold(d).split('/');
    if (segments.length <= dirSegs.length) continue;
    let hit = true;
    for (let i = 0; i < dirSegs.length; i++) {
      if (segments[i] !== dirSegs[i]) { hit = false; break; }
    }
    if (hit) return { verdict: 'core', reason: `inside core directory ${d}`, relative };
  }

  return { verdict: 'grantable', reason: 'inside the root and not core', relative };
}

/**
 * Boolean form, for callers that only want "may a grant cover this?".
 *
 * Returns TRUE (protected) for both 'core' and 'refused'. A caller that
 * cannot be told the difference must still fail closed, so anything this
 * function is not certain is grantable is reported as protected.
 */
function isCoreProtected(inputPath, repoRoot) {
  return classifyPath(inputPath, repoRoot).verdict !== 'grantable';
}

export {
  CORE_DIRS,
  CORE_FILES,
  PATH_PARAMS,
  classifyPath,
  isCoreProtected,
  resolveRepoRoot
};
