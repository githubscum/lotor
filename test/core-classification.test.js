/**
 * test/core-classification.test.js
 *
 * Every directory under src/ must be classified, or this fails.
 *
 * WHY THIS EXISTS, AND WHY THE EXISTING DRIFT GUARD COULD NOT DO IT
 *   `selfmod-covers-core.test.js` asserts the two core lists AGREE with each
 *   other: everything in core-paths' CORE_DIRS is also gated by the self-mod
 *   matcher. That is the right check for one failure mode and it is blind to
 *   the one that actually happened.
 *
 *   On 2026-07-25 `src/charter/` was written: an authorization module holding
 *   the enumeration hash, the coverage check and the sub-charter narrowing
 *   proof. It was created, tested and committed WITHOUT A SINGLE SIGNATURE,
 *   because a new directory under src/ is grantable by default. The drift
 *   guard stayed green throughout. **Both lists were wrong together, and a
 *   test that compares two lists cannot see that.**
 *
 *   core-paths.js documents the hole in its own header, under "KNOWN RESIDUAL
 *   GAP": a new top-level entry under src/ is not covered by default, because
 *   src/ as a whole holds feature code that must stay grantable. Documented is
 *   not the same as caught.
 *
 * THE POLARITY THIS FIXES
 *   Today a new module is protected only if someone REMEMBERS to protect it.
 *   Silence means grantable. This test inverts that: every directory under
 *   src/ must appear either in CORE_DIRS or in the explicit GRANTABLE list
 *   below, and a directory in neither fails the suite until a human puts it in
 *   one. **Silence now means refused**, which is core-paths.js's own stated
 *   philosophy applied to its own maintenance: "Unprovable means refused."
 *
 *   The failure message is the actual product here. It fires at the moment a
 *   module is created, names the two lists, and refuses to guess.
 *
 * WHAT THIS DOES NOT DO
 *   It cannot tell whether a directory BELONGS in core. A human still decides,
 *   and a human who classifies wrongly gets exactly what they asked for. It
 *   only guarantees that the decision is made consciously rather than by
 *   default. Nor does it cover single files added directly at src/*.js — that
 *   half of the residual gap is asserted separately below.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { CORE_DIRS, CORE_FILES, resolveRepoRoot } from '../src/grant/core-paths.js';

const root = resolveRepoRoot();
const srcDir = path.join(root, 'src');

/**
 * Directories under src/ that are DELIBERATELY grantable, each with the
 * reason stated. These mirror the "DELIBERATELY EXCLUDED" block in
 * core-paths.js; keeping the reasons here too means a maintainer who reaches
 * this test has the argument in front of them rather than having to go find
 * it.
 *
 * Adding a name here is a security decision. It should be as uncomfortable as
 * adding one to CORE_DIRS, and it is deliberately not a wildcard.
 */
const GRANTABLE = Object.freeze({
  mcp: 'a client of the gate, not the gate; its requests traverse the same enforcement path',
  views: 'rendering only; can mislead a reader, cannot change what is permitted',
  parser: 'reads transcripts; no authority over enforcement',
  ingest: 'reads transcripts into the store; no authority over enforcement',
  // Terminal-surface utilities: colour + TTY detection, and (later) the raccoon
  // loader animation. Reads env and stdout, writes nothing, spawns nothing,
  // never touches chain or gate. Same class as views: it can render badly, it
  // cannot widen authority. Added 2026-07-29 as part of the colour convention
  // rollout; the deliberate classification is the whole point of this file.
  term: 'colour and TTY detection for the terminal surface; reads env only, cannot widen authority',
  // Added 2026-08-15 (tool-pinning, item 2 of the 08-13 signing stack).
  toolpins: 'pure functions over tool definitions; no authority over enforcement'
});

/** Top-level directory names under src/, as they appear on disk. */
function srcSubdirs() {
  return fs.readdirSync(srcDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(n => !n.startsWith('.') && n !== 'node_modules')
    .sort();
}

/** Top-level .js files sitting directly under src/. */
function srcTopLevelFiles() {
  return fs.readdirSync(srcDir, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.js'))
    .map(d => d.name)
    .sort();
}

const coreDirNames = new Set(
  CORE_DIRS.filter(d => d.startsWith('src/')).map(d => d.slice('src/'.length))
);

describe('every directory under src/ is consciously classified', () => {
  for (const name of srcSubdirs()) {
    it(`src/${name} is either core or explicitly grantable`, () => {
      const isCore = coreDirNames.has(name);
      const isGrantable = Object.prototype.hasOwnProperty.call(GRANTABLE, name);

      assert.ok(
        isCore || isGrantable,
        `src/${name} is in neither list.\n\n` +
        `  A new directory under src/ is GRANTABLE BY DEFAULT, which means a\n` +
        `  signed grant can cover it and no signature is needed to create it.\n` +
        `  That is how src/charter shipped unprotected on 2026-07-25.\n\n` +
        `  Decide, then record the decision:\n` +
        `    - if it can change what the gate permits, add 'src/${name}' to\n` +
        `      CORE_DIRS in src/grant/core-paths.js AND 'src/${name}/' to\n` +
        `      selfModFragmentsForBase() in src/policy/index.js (both, or the\n` +
        `      drift guard fails)\n` +
        `    - if it genuinely cannot, add it to GRANTABLE in this file with\n` +
        `      the reason, the way mcp/views/parser are recorded\n\n` +
        `  This test will not guess for you. Unprovable means refused.`
      );

      assert.ok(
        !(isCore && isGrantable),
        `src/${name} is in BOTH lists. One of them is a lie; resolve it.`
      );
    });
  }

  it('classifies at least one directory each way, so the test is not vacuous', () => {
    const names = srcSubdirs();
    assert.ok(names.some(n => coreDirNames.has(n)), 'no core dirs found under src/');
    assert.ok(
      names.some(n => Object.prototype.hasOwnProperty.call(GRANTABLE, n)),
      'no grantable dirs found under src/'
    );
  });

  it('does not carry stale entries for directories that no longer exist', () => {
    // A GRANTABLE entry for a deleted directory is harmless today and becomes
    // a silent pre-approval the day someone recreates that name for something
    // else. Same reasoning as clearing surplus approval tokens (limit 30).
    const onDisk = new Set(srcSubdirs());
    for (const name of Object.keys(GRANTABLE)) {
      assert.ok(onDisk.has(name),
        `GRANTABLE lists src/${name}, which does not exist. Remove it: a stale ` +
        `entry pre-classifies whatever gets created under that name next.`);
    }
  });
});

describe('the other half of the residual gap: files directly under src/', () => {
  const coreFileNames = new Set(
    CORE_FILES.filter(f => f.startsWith('src/')).map(f => f.slice('src/'.length))
  );

  /**
   * Files at src/*.js that are deliberately NOT core. Same rule as GRANTABLE
   * above: name it and say why, or the suite fails.
   */
  const GRANTABLE_FILES = Object.freeze({
    // Decides an attribution LABEL (which harness wrote an entry), never what
    // the gate permits. Editing it can mislead a reader, which is real, but it
    // cannot widen authority. Same line core-paths.js already draws for
    // src/views: folding reporting integrity into enforcement integrity makes
    // the core large enough to be useless.
    //
    // Recorded 2026-07-26, and this classification is itself the first thing
    // this test caught in anger. src/harness.js was created hours after the
    // test shipped, the suite went red on the next run, and the decision was
    // made deliberately instead of defaulting to grantable by silence. That is
    // the whole point of the file.
    'harness.js': 'attribution label only; can mislead a reader, cannot widen authority'
  });

  for (const name of srcTopLevelFiles()) {
    it(`src/${name} is either core or explicitly grantable`, () => {
      const isCore = coreFileNames.has(name);
      const isGrantable = Object.prototype.hasOwnProperty.call(GRANTABLE_FILES, name);
      assert.ok(
        isCore || isGrantable,
        `src/${name} sits directly under src/ and is in neither list.\n\n` +
        `  core-paths.js names this exact gap in its header: a new file at\n` +
        `  src/*.js is not covered by default and must be added to CORE_FILES\n` +
        `  by hand if it gains authority over enforcement.\n\n` +
        `  Add it to CORE_FILES in src/grant/core-paths.js and to\n` +
        `  selfModFragmentsForBase() in src/policy/index.js, or record it in\n` +
        `  GRANTABLE_FILES here with the reason.`
      );
    });
  }
});
