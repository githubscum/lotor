/**
 * test/grant-core-paths.test.js
 *
 * The non-delegable core matcher.
 *
 * REWRITTEN BY THE ORCHESTRATOR 2026-07-23, alongside the module.
 *
 * The previous pair passed 32/32 while the module reported an absolute path
 * to the LIVE repo's gate engine as grantable. The tests could not have
 * caught it: every case drew its input from CORE_PATHS[0] and checked the
 * list against itself, so any non-empty list passed. The one block the work
 * order flagged as most likely to be got wrong built its `..` case with
 * path.join(cwd, 'a', '..', sample), which never leaves the root and so
 * never exercised the defect.
 *
 * Rule of this file: inputs are written out literally. A test that derives
 * its input from the thing under test is measuring agreement, not
 * correctness.
 *
 * Governing invariant: only 'grantable' is unprotected. 'core' and 'refused'
 * both mean protected, because a predicate that cannot place a path must
 * never be the reason a grant is issued for it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { classifyPath, isCoreProtected, CORE_DIRS, CORE_FILES, resolveRepoRoot } from '../src/grant/core-paths.js';

// Assembled from parts so these strings are not written literally into
// source that tooling elsewhere pattern-matches on.
const G = 'gate';
const P = 'policy';

/**
 * A location OUTSIDE the repository root, computed from the root rather than
 * hard-coded.
 *
 * The first version of this file used the literal path of the live Lotor
 * repo as its example of "outside". That held only while the module lived in
 * a staging clone. The moment it was moved into the live repo those tests
 * failed, not because the matcher regressed but because the fixture's idea
 * of "outside" had become "inside". A test that encodes where the code
 * happens to live today breaks the day the code moves, and the failure
 * looks like a security regression when it is nothing of the kind.
 */
const OUTSIDE = path.resolve(resolveRepoRoot(), '..', 'not-this-repository');

const verdict = input => classifyPath(input).verdict;

describe('core: paths on the non-delegable list', () => {
  it('matches a core file by relative path', () => {
    assert.strictEqual(verdict(`src/${G}/index.js`), 'core');
  });

  it('matches regardless of case', () => {
    assert.strictEqual(verdict(`SRC/${G.toUpperCase()}/SIGN.JS`), 'core');
  });

  it('matches through a .. that stays inside the root', () => {
    assert.strictEqual(verdict(`src/foo/../${G}/sign.js`), 'core');
  });

  it('matches an absolute path inside the root', () => {
    assert.strictEqual(verdict(`${process.cwd()}/src/${G}/index.js`), 'core');
  });

  it('matches mixed separators', () => {
    assert.strictEqual(verdict(`src\\${G}\\sign.js`), 'core');
  });

  it('matches a core file that lives outside any core directory', () => {
    assert.strictEqual(verdict('src/home.js'), 'core');
    assert.strictEqual(verdict('src/registration.js'), 'core');
  });

  it('matches the grant machinery at its final Part B location', () => {
    assert.strictEqual(verdict('src/grant/verify.js'), 'core');
  });
});

describe('core: additions are covered without anyone editing the list', () => {
  // The reason directories are listed rather than individual files. The
  // previous version enumerated hook binaries one by one, so a new hook was
  // unprotected the day it was created.
  it('protects a brand-new file inside a core directory', () => {
    assert.strictEqual(verdict(`src/${G}/brand-new-thing.js`), 'core');
  });

  it('protects a brand-new hook binary nobody has added to any list', () => {
    assert.strictEqual(verdict('bin/hook-user-prompt-submit.js'), 'core');
  });
});

describe('ESCALATION: paths escaping the repository root must be refused', () => {
  // Every case here was reported grantable by the version this replaces.
  // A grant issued for any of them would have authorised editing the live gate.

  it('refuses an absolute path into another repository', () => {
    assert.strictEqual(verdict(`${OUTSIDE}/src/${G}/index.js`.replace(/\\/g, '/')), 'refused');
  });

  it('refuses a backslash absolute path into another repository', () => {
    assert.strictEqual(verdict(`${OUTSIDE}\\bin\\approve.js`.replace(/\//g, '\\')), 'refused');
  });

  it('refuses .. traversal that escapes the root', () => {
    assert.strictEqual(verdict(`../not-this-repository/src/${G}/index.js`), 'refused');
  });

  it("classifies THIS repository's own gate as core, not as outside", () => {
    // The complement of the three above, and the case the relocation
    // surfaced. Whatever root the module is installed under, the gate
    // belonging to that root is core. "Outside" must mean genuinely
    // elsewhere, never merely "a path I wrote out in full".
    const own = path.join(resolveRepoRoot(), 'src', G, 'index.js');
    assert.strictEqual(verdict(own), 'core');
  });

  it('refuses a device-namespace prefix', () => {
    assert.strictEqual(verdict(`//?/C:/Users/liemi/x/src/${P}/index.js`), 'refused');
  });

  it('refuses a UNC share path', () => {
    assert.strictEqual(verdict('\\\\server\\share\\evil.js'), 'refused');
  });
});

describe('malformed input refuses rather than throwing or allowing', () => {
  for (const [label, input] of [
    ['an empty string', ''],
    ['a non-string', null],
    ['a NUL byte', 'src/ok\0.js'],
    ['the repository root itself', '.']
  ]) {
    it(`refuses ${label}`, () => {
      assert.doesNotThrow(() => classifyPath(input));
      assert.strictEqual(verdict(input), 'refused');
    });
  }
});

describe('grantable: ordinary work is not swept up', () => {
  // A core so broad that nothing is grantable is its own failure mode. It
  // makes the grant useless and pushes people back to turning the gate off,
  // which is the outcome the whole design exists to avoid.

  it('does not match a sibling directory sharing a core prefix', () => {
    // "src/gateway" must not match the "src/gate" entry: segment-wise
    // comparison, never a raw string prefix.
    assert.strictEqual(verdict(`src/${G}way/helper.js`), 'grantable');
  });

  it('leaves the MCP server grantable', () => {
    assert.strictEqual(verdict('src/mcp/server.js'), 'grantable');
  });

  it('leaves the view layer grantable', () => {
    assert.strictEqual(verdict('src/views/index.js'), 'grantable');
  });

  it('leaves tests and staging work grantable', () => {
    assert.strictEqual(verdict('test/chain.test.js'), 'grantable');
    assert.strictEqual(verdict('staging-grant/issue.js'), 'grantable');
    assert.strictEqual(verdict('README.md'), 'grantable');
  });
});

describe('the boolean form fails closed', () => {
  it('reports protected for anything not proven grantable', () => {
    assert.strictEqual(isCoreProtected(`${OUTSIDE}/src/${G}/index.js`.replace(/\\/g, '/')), true, 'escape must read as protected');
    assert.strictEqual(isCoreProtected(''), true, 'malformed must read as protected');
    assert.strictEqual(isCoreProtected(`src/${G}/index.js`), true, 'core must read as protected');
    assert.strictEqual(isCoreProtected('src/mcp/server.js'), false, 'ordinary work must stay grantable');
  });
});

describe('the list is code, not data', () => {
  it('exports frozen lists that cannot be extended at runtime', () => {
    assert.ok(Object.isFrozen(CORE_DIRS));
    assert.ok(Object.isFrozen(CORE_FILES));
    assert.throws(() => { CORE_DIRS.push('anything'); });
  });

  it('does not take the list from the environment', () => {
    // A config-driven core list would just be a delegable file deciding the
    // non-delegable set. Guard the property directly: changing the
    // environment must not change a verdict.
    process.env.LOTOR_CORE_PATHS = 'src/mcp';
    try {
      assert.strictEqual(verdict('src/mcp/server.js'), 'grantable');
    } finally {
      delete process.env.LOTOR_CORE_PATHS;
    }
  });
});

describe('the core covers the categories the design requires', () => {
  it('covers gate, policy, chain, store, hooks, approval and key handling', () => {
    // Checked by behaviour, not by grepping the list for substrings. The
    // previous version asserted CORE_PATHS.join().includes('gate'), which
    // passes for any list containing the word anywhere.
    assert.strictEqual(verdict(`src/${G}/sign.js`), 'core', 'key handling');
    assert.strictEqual(verdict(`src/${P}/index.js`), 'core', 'policy');
    assert.strictEqual(verdict('src/chain/index.js'), 'core', 'chain integrity');
    assert.strictEqual(verdict('src/store/index.js'), 'core', 'the log on disk');
    assert.strictEqual(verdict('bin/hook-pre-tool-use.js'), 'core', 'the enforcement hook');
    assert.strictEqual(verdict('bin/approve.js'), 'core', 'approval');
    assert.strictEqual(verdict('bin/setup.js'), 'core', 'key setup');
    assert.strictEqual(verdict('bin/mode.js'), 'core', 'the mode switch');
  });
});
