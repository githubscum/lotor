import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createStore } from '../src/store/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '..', 'src', 'mcp', 'server.js');

describe('MCP stdio e2e', () => {
  let tempDir;
  let client;
  let transport;

  before(async () => {
    // Isolated temp dir: server baseDir '.' resolves to this via child cwd,
    // so receipts/ and keys/ land here and never pollute the repo.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-e2e-'));

    // Seed the chain in the same dir the server will read, via the real store
    // API so key/dir consistency holds (store signs, server reloads + verifies).
    const store = createStore(tempDir);
    for (let i = 0; i < 3; i++) {
      store.appendReceipt({
        session: { id: `sess-${i}`, model: 'e2e-model' },
        ran: [],
        touched: i === 2 ? [{ path: '/x/y.js', via: 'write' }] : [],
        failed: [],
        cost: {},
        counts: { turns: 1, toolCalls: i, failures: 0 }
      });
    }

    // Spawn the real server over real stdio, pointing its canonical home at
    // the seeded temp dir so it reads/writes the same chain (and never the real ~/.lotor).
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_PATH],
      cwd: tempDir,
      env: { ...process.env, LOTOR_HOME: tempDir }
    });
    client = new Client(
      { name: 'e2e-client', version: '1.0.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
  });

  after(async () => {
    if (client) {
      await client.close();
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('completes a real initialize handshake and lists all tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    assert.deepStrictEqual(names, ['gated_action', 'lotor_status', 'query_receipts', 'sessions_live', 'sessions_since', 'verify_chain']);
    for (const tool of tools) {
      assert.ok(
        typeof tool.description === 'string' && tool.description.length > 0,
        `tool ${tool.name} should have a non-empty description`
      );
    }
  });

  it('query_receipts returns receipt summaries, most-recent-first', async () => {
    const res = await client.callTool({ name: 'query_receipts', arguments: {} });
    assert.ok(Array.isArray(res.content), 'content should be an array');
    assert.strictEqual(res.content[0].type, 'text');
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(Array.isArray(parsed.receipts), 'parsed should have receipts array');
    assert.strictEqual(parsed.receipts.length, 3, 'should return the 3 seeded receipts');

    // Most-recent-first: highest seq first.
    const seqs = parsed.receipts.map(r => r.seq);
    assert.ok(seqs[0] > seqs[1] && seqs[1] > seqs[2], 'seq should be descending');

    // Real shape assertion.
    for (const r of parsed.receipts) {
      for (const field of ['seq', 'timestamp', 'sessionId', 'model', 'hash', 'touchedCount', 'toolCalls']) {
        assert.ok(field in r, `receipt should have ${field}`);
      }
    }
  });

  it('verify_chain reports an intact untampered chain', async () => {
    const res = await client.callTool({ name: 'verify_chain', arguments: {} });
    const parsed = JSON.parse(res.content[0].text);
    assert.strictEqual(parsed.ok, true, 'chain should be ok');
    assert.strictEqual(parsed.brokenAt, null, 'brokenAt should be null');
    assert.strictEqual(parsed.reason, null, 'reason should be null');
    assert.strictEqual(parsed.entryCount, 3, 'entryCount should match seeded entries');
  });

  it('gated_action with no token returns a structured denial (fails closed)', async () => {
    const res = await client.callTool({
      name: 'gated_action',
      arguments: { action: 'doThing', params: { k: 'v' } }
    });
    const parsed = JSON.parse(res.content[0].text);
    assert.strictEqual(parsed.decision, 'denied');
    assert.strictEqual(parsed.reason, 'no approval token provided');
    assert.strictEqual(typeof parsed.receiptSeq, 'number', 'receiptSeq should be a number');
  });
});
