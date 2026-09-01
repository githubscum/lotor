import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate the home before importing the server, so its singleton store never
// touches the real ~/.lotor. Same pattern as status.test.js.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-stamp-'));
process.env.LOTOR_HOME = TEST_HOME;

const { buildStamp, withBuild, handleVerifyChain } = await import('../src/mcp/server.js');

/**
 * KNOWN-LIMITS 41. The mitigation the entry named was "every MCP response
 * carries the server's own build id, so a reader can see that the answer came
 * from a version older than the fix they are checking." These tests cover the
 * carrying, not just the computing: a build id that never reaches the reader
 * is the same limit with more code behind it.
 */

describe('the build stamp', () => {
  it('names the version, a readable build id, and when the process started', () => {
    const s = buildStamp();

    assert.strictEqual(typeof s.version, 'string', 'version comes from package.json');
    assert.match(s.build, /^[0-9a-f]{12}$/, 'the short build id should be readable at a glance');
    assert.match(s.buildFull, /^[0-9a-f]{64}$/, 'the full digest must also be present');
    assert.ok(s.buildFull.startsWith(s.build), 'the short id is a prefix of the full one, not a second value');
    assert.strictEqual(s.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(s.startedAt)));
  });

  it('is quiet when the process matches the source on disk', () => {
    const s = buildStamp();

    assert.strictEqual(s.sourceChangedSinceStart, false, 'the test run has not edited its own source');
    assert.strictEqual(
      s.warning,
      undefined,
      'a warning that fires with nothing to report is limit 39, and this stamp does not add another'
    );
  });

  it('rides on a real tool result without displacing its fields', () => {
    const bare = handleVerifyChain();
    const stamped = withBuild(bare);

    for (const k of Object.keys(bare)) {
      assert.deepStrictEqual(stamped[k], bare[k], `withBuild must not disturb ${k}`);
    }
    assert.ok(stamped._lotorBuild, 'the stamp should be present under a namespaced key');
    assert.strictEqual(stamped._lotorBuild.pid, process.pid);
  });

  it('wraps rather than mangles a non-object result', () => {
    assert.strictEqual(withBuild(null).result, null);
    assert.strictEqual(withBuild('text').result, 'text');
    assert.ok(Array.isArray(withBuild([1, 2]).result), 'an array is a value, not a field bag');
    assert.ok(withBuild(null)._lotorBuild, 'even a null answer says which build produced it');
  });
});
