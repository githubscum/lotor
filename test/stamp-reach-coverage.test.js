/**
 * test/stamp-reach-coverage.test.js
 *
 * KNOWN-LIMITS 64. Two version stamps exist in this repository and they cover
 * different things:
 *
 *   matcherHash   hashes named functions in src/policy/index.js. It is the
 *                 field every gated-action, policy-warn, grant and egress
 *                 receipt carries, so it is the ONLY code identity that
 *                 reaches the permanent record.
 *
 *   sourceDigest  hashes every .js file under src/ and bin/, which includes
 *                 src/gate, src/grant, src/chain, src/store and the hooks.
 *                 It is attached to MCP tool responses and nowhere else.
 *
 * The broad fingerprint exists, is tested, and is wired to the ephemeral
 * consumer. The narrow one is wired to the durable one. A change to the code
 * that actually decides whether an action is allowed moves nothing a future
 * reader of the chain can see.
 *
 * 2026-09-07: half of the repair landed (the hook can compute the digest);
 * the half that writes it onto session-open did not (limit 73). The third
 * block below asserts that exact state.
 *
 * These assertions are written so the absence claims cannot pass vacuously:
 * every "X does not reference the build digest" is paired with a control
 * asserting that something else does, and that X references the matcher hash.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeSourceDigest } from '../src/mcp/build-identity.js';
import { matcherVersionHash, MATCHER_SCHEMA } from '../src/policy/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/** Independently enumerate the .js files under the source dirs. */
function jsUnder(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) jsUnder(full, acc);
    else if (e.isFile() && e.name.endsWith('.js')) {
      acc.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  }
  return acc;
}

/**
 * The modules that decide whether an action is allowed. None of them is
 * src/policy/index.js, which is the point: the matcher hash covers that one
 * file and these are the rest of the decision.
 */
const DECIDERS = [
  'src/gate/index.js',
  'src/grant/check.js',
  'src/chain/index.js',
  'src/store/index.js',
  'bin/hook-pre-tool-use.js'
];

test('the build digest covers every decider, including the ones outside the policy module', () => {
  const covered = new Set([
    ...jsUnder(path.join(ROOT, 'src')),
    ...jsUnder(path.join(ROOT, 'bin'))
  ]);

  for (const rel of DECIDERS) {
    assert.ok(covered.has(rel), `${rel} should be inside the build digest's file set`);
  }
  // Control: the file set is the one computeSourceDigest actually hashed.
  const d = computeSourceDigest(ROOT);
  assert.equal(d.fileCount, covered.size, 'fileCount should equal the independently enumerated set');
  assert.equal(typeof d.digest, 'string');
});

test('the matcher hash is the only code identity that reaches a receipt', () => {
  // Every module that writes a receipt names matcherVersionHash...
  for (const rel of ['src/gate/index.js', 'bin/hook-pre-tool-use.js', 'bin/hook-post-tool-use.js']) {
    const src = read(rel);
    assert.match(src, /matcherVersionHash/, `${rel} should stamp receipts with the matcher hash (control)`);
    // ...and none of them names the whole-tree digest.
    assert.doesNotMatch(
      src,
      /computeSourceDigest|captureBuildIdentity|sourceDigest/,
      `${rel} does not carry the build digest onto the record — this is limit 64`
    );
  }
});

test('the whole-tree digest is referenced by the session-open writer and still not written by it (limit 64, half landed 2026-09-07)', () => {
  // Control: the consumer that does exist.
  assert.match(
    read('src/mcp/server.js'),
    /captureBuildIdentity|_lotorBuild/,
    'the MCP server should attach the build stamp (control)'
  );
  // The first half of the limit 64 repair landed under signature on
  // 2026-09-07: bin/hook-session-start.js imports computeSourceDigest and
  // defines buildIdentityAtOpen(). The second half (the observer block moving
  // to observer/2 with a `build` field) was denied on replay (limit 73), so
  // the function is defined and not called, and the digest still reaches no
  // receipt. Both facts are asserted here, so this block fails again the
  // moment the second half lands and must be inverted then, not deleted.
  const all = [...jsUnder(path.join(ROOT, 'src')), ...jsUnder(path.join(ROOT, 'bin'))];
  const consumers = all.filter((rel) =>
    /computeSourceDigest|captureBuildIdentity/.test(read(rel))
  );
  assert.deepEqual(
    consumers.sort(),
    ['bin/hook-session-start.js', 'src/mcp/build-identity.js', 'src/mcp/server.js'],
    'the session-open writer references the build digest (half of the limit 64 repair)'
  );
  const hook = read('bin/hook-session-start.js');
  assert.match(hook, /function buildIdentityAtOpen\(\)/, 'the helper is defined (first hunk landed)');
  assert.doesNotMatch(
    hook,
    /build: buildIdentityAtOpen\(\)/,
    'the helper is not yet called from the observer block — this is the unlanded second hunk'
  );
  assert.match(hook, /schema: 'observer\/1'/, 'session-open still writes observer/1 until the second hunk lands');
});

test('the two stamps are different values over different inputs', () => {
  const build = computeSourceDigest(ROOT).digest;
  const matcher = matcherVersionHash();
  assert.notEqual(build, matcher);
  assert.equal(MATCHER_SCHEMA, 'matcher/2');
  // Stable across calls, so a receipt comparison is meaningful at all.
  assert.equal(matcherVersionHash(), matcher);
});
