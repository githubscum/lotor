#!/usr/bin/env node
/**
 * bin/limits-pin.js
 *
 * KNOWN-LIMITS 29: pin the confession log to a commit, and let any reader
 * check whether they are reading a description of somewhere else.
 *
 * USAGE
 *   node bin/limits-pin.js --stamp    # write/replace the pin from git HEAD
 *   node bin/limits-pin.js --check    # reader-side verdict; exit 1 on divergence
 *
 * WHY A CLI AND NOT AUTOMATIC: stamping is a claim about verification, and a
 * hook that stamps silently would make the pin say "verified" without anyone
 * verifying. The person updating the log runs --stamp; every reader can run
 * --check.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writePin, readPin, checkPin } from '../src/limits/pin.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(REPO, 'KNOWN-LIMITS.md');

function resolveHead() {
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
  const head = resolveHead();
  if (!head) {
    console.error('error: could not resolve git HEAD. Run this inside the repository.');
    process.exit(2);
  }
  if (head.dirty) {
    console.error('note: working tree has uncommitted changes; the pin records HEAD only.');
  }
  writePin(LOG, {
    commit: head.hash,
    subject: head.subject,
    date: new Date().toISOString().slice(0, 10)
  });
  console.log(`pinned KNOWN-LIMITS.md to ${head.hash}`);
  process.exit(0);
}

if (args.includes('--check')) {
  if (!fs.existsSync(LOG)) {
    console.error(`error: ${LOG} not found.`);
    process.exit(2);
  }
  const text = fs.readFileSync(LOG, 'utf8');
  const head = resolveHead();
  const verdict = checkPin({
    pinText: text,
    head: head ? head.hash : null,
    dirty: head ? head.dirty : false
  });
  process.stdout.write(verdict.message + '\n');
  // current → 0. diverged/unpinned/unknown → 1 so scripts and CI can gate on it.
  process.exit(verdict.status === 'current' ? 0 : 1);
}

process.stdout.write([
  'Usage:',
  '  node bin/limits-pin.js --stamp   pin KNOWN-LIMITS.md to the current git HEAD',
  '  node bin/limits-pin.js --check   verify your checkout against the pin (exit 1 = diverged)',
  ''
].join('\n'));
process.exit(args.length > 0 ? 2 : 0);
