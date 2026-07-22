import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point the shared home at an isolated temp dir BEFORE importing the server,
// so the server's singleton store lands there and never touches the real ~/.lotor.
// The import is dynamic because ESM static imports are hoisted above this assignment.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-status-'));
process.env.LOTOR_HOME = TEST_HOME;

const { handleStatus } = await import('../src/mcp/server.js');

// A well-formed approval.pub line (ed25519:<b64url>:fingerprint:<32 hex>).
const FAKE_APPROVAL_LINE =
  'ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:fingerprint:' +
  '0123456789abcdef0123456789abcdef\n';

describe('lotor_status handler', () => {
  it('reports gateInitialized false in a fresh home, with home and receiptCount', () => {
    // Ensure no approval key is present.
    const approvalPub = path.join(TEST_HOME, 'keys', 'approval.pub');
    if (fs.existsSync(approvalPub)) {
      fs.rmSync(approvalPub);
    }

    const result = handleStatus();

    assert.strictEqual(result.gateInitialized, false, 'gate should be uninitialized');
    assert.strictEqual(result.home, TEST_HOME, 'home should be the test home');
    assert.strictEqual(typeof result.receiptCount, 'number', 'receiptCount should be a number');
    assert.ok(typeof result.message === 'string' && result.message.length > 0, 'should have a message');
    assert.ok(result.message.includes('npm run setup'), 'message should point to npm run setup');
  });

  it('reports gateInitialized true once approval.pub exists', () => {
    const keysDir = path.join(TEST_HOME, 'keys');
    fs.mkdirSync(keysDir, { recursive: true });
    fs.writeFileSync(path.join(keysDir, 'approval.pub'), FAKE_APPROVAL_LINE);

    const result = handleStatus();

    assert.strictEqual(result.gateInitialized, true, 'gate should be initialized');
    assert.strictEqual(result.home, TEST_HOME, 'home should be the test home');
    assert.strictEqual(typeof result.receiptCount, 'number', 'receiptCount should be a number');
    assert.ok(!result.message.includes('npm run setup'), 'initialized message should not point to setup');
  });
});
