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
 * tests spawn):
 *
 *   NODE_OPTIONS="--import=./proposals/store-tail-append/run-against-candidate.mjs" npm test
 *
 * Requires node >= 22.15 / 23.5 (module.registerHooks).
 */

import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');

const LIVE = pathToFileURL(path.join(repo, 'src', 'store', 'index.js')).href;
const CANDIDATE = pathToFileURL(path.join(here, 'index.js')).href;

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
