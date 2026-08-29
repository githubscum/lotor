#!/usr/bin/env node
/**
 * bin/limits-pin.js
 *
 * KNOWN-LIMITS 29: pin the confession log to a commit, and let any reader
 * check whether they are reading a description of somewhere else.
 *
 * USAGE
 *   node bin/limits-pin.js --stamp    # write/replace the pin from the last src commit
 *   node bin/limits-pin.js --check    # reader-side verdict; exit 1 on divergence
 *
 * WHY A CLI AND NOT AUTOMATIC: stamping is a claim about verification, and a
 * hook that stamps silently would make the pin say "verified" without anyone
 * verifying. The person updating the log runs --stamp; every reader can run
 * --check.
 *
 * WHY THE PIN TARGETS THE LAST src COMMIT, NOT HEAD: the pin lives inside
 * KNOWN-LIMITS.md, and stamping is itself a commit that edits only that file.
 * If the pin named HEAD, every stamp would name its own parent, and after the
 * stamp commit landed on main every reader would see "diverged" forever — the
 * check would be permanently exit 1 and train its reader to ignore it. The pin
 * must name something that does NOT move when the pin changes. The last commit
 * that touched `src/` is stable across stamp commits (a stamp touches the log,
 * not src/), so `current` is reachable and divergence means something. --check
 * resolves the checkout the same way, so the two sides are comparable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writePin, readPin, checkPin } from '../src/limits/pin.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(REPO, 'KNOWN-LIMITS.md');

// Resolve the commit the pin should name: the last commit that changed src/.
// Falls back to HEAD only if `src/` has no history (empty repo edge case).
function resolvePinTarget() {
  try {
    const hash = execFileSync('git', ['log', '-1', '--format=%H', '--', 'src'], { cwd: REPO, encoding: 'utf8' }).trim();
    if (hash) {
      const subject = execFileSync('git', ['log', '-1', '--format=%s', '--', 'src'], { cwd: REPO, encoding: 'utf8' }).trim();
      return { hash, subject, dirty: false };
    }
  } catch {
    // no src/ history; fall through to HEAD
  }
  try {
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: REPO, encoding: 'utf8' }).trim();
    let dirty = false;
    try {
      execFileSync('git', ['diff-index', '--quiet', 'HEAD', '--'], { cwd: REPO, stdio: 'ignore' });
    } catch {
      dirty = true;
    }
    return { hash, subject, dirty };
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);

if (args.includes('--stamp')) {
  const target = resolvePinTarget();
  if (!target) {
    console.error('error: could not resolve a git commit. Run this inside the repository.');
    process.exit(2);
  }
  if (target.dirty) {
    console.error('note: working tree has uncommitted changes; the pin records the src commit only.');
  }
  writePin(LOG, {
    commit: target.hash,
    subject: target.subject,
    date: new Date().toISOString().slice(0, 10)
  });
  console.log(`pinned KNOWN-LIMITS.md to src commit ${target.hash}`);
  process.exit(0);
}

if (args.includes('--check')) {
  if (!fs.existsSync(LOG)) {
    console.error(`error: ${LOG} not found.`);
    process.exit(2);
  }
  const text = fs.readFileSync(LOG, 'utf8');
  const target = resolvePinTarget();
  const verdict = checkPin({
    pinText: text,
    head: target ? target.hash : null,
    dirty: target ? target.dirty : false
  });
  process.stdout.write(verdict.message + '\n');
  // current → 0. diverged/unpinned/unknown → 1 so scripts and CI can gate on it.
  process.exit(verdict.status === 'current' ? 0 : 1);
}

process.stdout.write([
  'Usage:',
  '  node bin/limits-pin.js --stamp   pin KNOWN-LIMITS.md to the last src/ commit',
  '  node bin/limits-pin.js --check   verify your checkout against the pin (exit 1 = diverged)',
  ''
].join('\n'));
process.exit(args.length > 0 ? 2 : 0);
