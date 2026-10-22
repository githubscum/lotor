/**
 * proposals/store-tail-append/run-against-candidate.mjs
 *
 * Test-only module hook. Lets the test suite run against the CANDIDATE store
 * module in this folder before it is landed, without writing to the core path.
 *
 * Every import that resolves to the live store module is answered with the
 * candidate file instead, and the candidate's own relative imports are
 * resolved as if it already sat at the live path. Nothing on disk under the
 * core path is read differently or changed; remove the hook and the suite runs
 * against whatever is landed.
 *
 * Usage (from the repo root; NODE_OPTIONS carries it into child processes the
 * tests spawn). Use an ABSOLUTE file URL: some tests spawn children in a temp
 * cwd (the MCP stdio e2e), where a relative --import path does not resolve
 * and those children die with ERR_MODULE_NOT_FOUND.
 *
 *   NODE_OPTIONS="--import=file:///<repo>/proposals/store-tail-append/run-against-candidate.mjs" npm test
 *
 * With the hook active, the tests that are `todo` on the branch (they need the
 * candidate) run as ordinary tests, so a failure fails the run. The same hook
 * gives the bench's "after" column:
 *
 *   NODE_OPTIONS="--import=file:///<repo>/proposals/store-tail-append/run-against-candidate.mjs" node bench/store-append.js
 *
 * Requires node >= 22.15 / 23.5 (module.registerHooks).
 */

import { registerHooks } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

const LIVE_PATH = path.join(repo, 'src', 'store', 'index.js');
const CANDIDATE_PATH = path.join(here, 'index.js');

// Fail loudly rather than silently run the suite against the live module.
for (const p of [LIVE_PATH, CANDIDATE_PATH]) {
  if (!fs.existsSync(p)) {
    throw new Error(`[candidate hook] expected file is missing: ${p}`);
  }
}

const LIVE = pathToFileURL(LIVE_PATH).href;
const CANDIDATE = pathToFileURL(CANDIDATE_PATH).href;

// Marker for test/store-tail-append.test.js: the landing tripwire there checks
// that, with this hook active, the store module it imported really is the
// candidate (it exports readChainTail). A redirect that silently no-ops fails
// that test instead of producing a second run against the live module.
globalThis[Symbol.for('lotor.storeCandidateHook')] = CANDIDATE;

const same = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (same(context.parentURL, CANDIDATE)) {
      return nextResolve(specifier, { ...context, parentURL: LIVE });
    }
    const resolved = nextResolve(specifier, context);
    if (same(resolved.url, LIVE)) {
      return { ...resolved, url: CANDIDATE, shortCircuit: true };
    }
    return resolved;
  }
});

if (process.env.LOTOR_CANDIDATE_HOOK_VERBOSE) {
  process.stderr.write(`[candidate hook] store module -> ${CANDIDATE}\n`);
}
