import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * Regression guard for the 1.0.0 release defect: src/mcp/server.js hardcoded
 * `version: '0.0.0'`, so the running server reported 0.0.0 to every client
 * while npm and the MCP registry both said 1.0.0. Nothing tested what the
 * server calls itself, so nothing caught it until the published package was
 * smoke-tested from a clean directory.
 *
 * These tests assert one source of truth for identity.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const readJson = (p) => JSON.parse(readFileSync(path.join(root, p), 'utf8'));

describe('server identity', () => {
  test('server.js does not hardcode a version literal', () => {
    const src = readFileSync(path.join(root, 'src/mcp/server.js'), 'utf8');
    assert.ok(
      !/version:\s*['"]\d+\.\d+\.\d+['"]/.test(src),
      'src/mcp/server.js contains a hardcoded semver literal. Identity must be read from package.json so there is only one place to be wrong.'
    );
  });

  test('reported identity equals package.json exactly', async () => {
    const pkg = readJson('package.json');
    const { readIdentity } = await import(
      pathToFileURL(path.join(root, 'src/mcp/server.js')).href
    );
    const identity = readIdentity();
    assert.equal(
      identity.version,
      pkg.version,
      `server reports ${identity.version}, package.json says ${pkg.version}. This is the 1.0.0 defect: the server told every client 0.0.0.`
    );
    assert.equal(identity.name, pkg.name, 'server name drifted from the published package name');
  });

  test('manifest.json version matches package.json', () => {
    const pkg = readJson('package.json');
    const manifest = readJson('manifest.json');
    assert.equal(
      manifest.version,
      pkg.version,
      `manifest.json says ${manifest.version}, package.json says ${pkg.version}. These ship together and must agree.`
    );
  });

  test('server.json versions match package.json', () => {
    const pkg = readJson('package.json');
    const server = readJson('server.json');
    assert.equal(server.version, pkg.version, 'server.json version drifted from package.json');
    assert.equal(
      server.packages[0].version,
      pkg.version,
      'server.json packages[].version drifted from package.json'
    );
    assert.equal(
      server.packages[0].identifier,
      pkg.name,
      'server.json npm identifier must be the published package name'
    );
  });

  test('server.json name matches package.json mcpName', () => {
    const pkg = readJson('package.json');
    const server = readJson('server.json');
    assert.equal(
      server.name,
      pkg.mcpName,
      'the MCP registry rejects a publish when server.json name and package.json mcpName differ'
    );
  });

  test('manifest declares every tool the server serves', () => {
    const src = readFileSync(path.join(root, 'src/mcp/server.js'), 'utf8');
    const manifest = readJson('manifest.json');
    const declared = new Set(manifest.tools.map((t) => t.name));
    const known = ['query_receipts', 'verify_chain', 'lotor_status', 'gated_action'];
    for (const name of known) {
      if (src.includes(`'${name}'`) || src.includes(`"${name}"`)) {
        assert.ok(
          declared.has(name),
          `server.js serves ${name} but manifest.json does not declare it. The 1.0.0 manifest declared 3 of 4.`
        );
      }
    }
  });
});
