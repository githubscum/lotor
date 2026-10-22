/**
 * test/toolio-digest.test.js
 *
 * Rung R2 (tool I/O), work order V3-03. Tests for src/toolio/index.js, the
 * module the post-tool-use hook calls to put a digest of the tool's response
 * on its receipt.
 *
 * FAIL-FIRST. On main this file fails at import: src/toolio/ does not exist,
 * so there is no R2 field to put on any receipt. Every assertion below is the
 * contract the new field is held to.
 *
 * THE PIN. Derived out of band, not by running the code under test:
 *
 *   input     : { stdout: 'line1\r\nline2\n', is_error: false, b: [2, 1] }
 *   CRLF->LF  : stdout becomes 'line1\nline2\n'
 *   sort keys : {"b":[2,1],"is_error":false,"stdout":"line1\nline2\n"}
 *   printf '%s' '<that>' | sha256sum
 *             : 78d33f997af62d9361f71646b86d7e296a87d1ac17c65aa23f070efdc14e5874
 *   wc -c     : 54
 *
 * If the pin test fails, every toolio/1 digest already on a chain is orphaned.
 * Bump TOOLIO_SCHEMA and re-pin on purpose, never to make a test pass.
 *
 * LINE ENDINGS IN THIS FILE. Every CR in a fixture is written as the escape
 * '\r', never as a literal line break inside a template literal, so the
 * fixtures are the same bytes whether this file was checked out CRLF or LF.
 * A test about line-ending independence must not itself depend on them.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  describeToolResponse,
  canonicalResponseText,
  reportedError,
  TOOLIO_SCHEMA
} from '../src/toolio/index.js';
import { createStore, loadChain } from '../src/store/index.js';

const __filename = fileURLToPath(import.meta.url);

const PINNED_INPUT = { stdout: 'line1\r\nline2\n', is_error: false, b: [2, 1] };
const PINNED_DIGEST = '78d33f997af62d9361f71646b86d7e296a87d1ac17c65aa23f070efdc14e5874';
const PINNED_BYTES = 54;

function digestOf(response) {
  const io = describeToolResponse(response);
  assert.strictEqual(io.response.recorded, true, 'fixture must be recordable');
  return io.response.digest;
}

describe('toolio/1: the recorded shape', () => {
  it('produces the pinned digest and byte length for the canonical fixture', () => {
    const io = describeToolResponse(PINNED_INPUT);
    assert.strictEqual(io.schema, 'toolio/1');
    assert.strictEqual(TOOLIO_SCHEMA, 'toolio/1');
    assert.deepStrictEqual(io.response, {
      recorded: true,
      digest: PINNED_DIGEST,
      bytes: PINNED_BYTES,
      error: false
    });
  });

  it('digest is full 64-char lowercase hex, bytes is the UTF-8 length of the canonical text', () => {
    const resp = { text: 'naïve café ✓' };
    const io = describeToolResponse(resp);
    assert.match(io.response.digest, /^[0-9a-f]{64}$/);
    const text = canonicalResponseText(resp);
    assert.strictEqual(io.response.bytes, Buffer.byteLength(text, 'utf8'));
    assert.ok(io.response.bytes > text.length, 'multi-byte characters count as bytes, not chars');
  });

  it('is pure: same input, same object; the caller\'s value is not mutated', () => {
    const resp = { stdout: 'a\r\nb', nested: { z: 1, a: 2 } };
    const snapshot = JSON.stringify(resp);
    assert.deepStrictEqual(describeToolResponse(resp), describeToolResponse(resp));
    assert.strictEqual(JSON.stringify(resp), snapshot,'CRLF normalization must not write back');
  });
});

describe('toolio/1: digest stability', () => {
  it('key order does not change the digest, at the top or nested', () => {
    assert.strictEqual(
      digestOf({ stdout: 'x', stderr: '', interrupted: false }),
      digestOf({ interrupted: false, stderr: '', stdout: 'x' })
    );
    assert.strictEqual(
      digestOf({ content: [{ type: 'text', text: 'hi' }], meta: { b: 1, a: { d: 4, c: 3 } } }),
      digestOf({ meta: { a: { c: 3, d: 4 }, b: 1 }, content: [{ text: 'hi', type: 'text' }] })
    );
  });

  it('CRLF and LF versions of the same response give the same digest and the same bytes', () => {
    const lf = { file: { content: 'one\ntwo\nthree\n' }, lines: ['a\n', 'b\n'] };
    const crlf = { file: { content: 'one\r\ntwo\r\nthree\r\n' }, lines: ['a\r\n', 'b\r\n'] };
    assert.deepStrictEqual(describeToolResponse(crlf), describeToolResponse(lf));
    // A bare string response, which is what many MCP tools return.
    assert.strictEqual(digestOf('x\r\ny\r\n'), digestOf('x\ny\n'));
  });

  it('a real file read from a CRLF checkout digests the same as from an LF checkout', () => {
    // This test file itself is the sample. Whatever line endings the checkout
    // gave it, build both spellings explicitly and compare.
    const raw = fs.readFileSync(__filename, 'utf8');
    const asLf = raw.replace(/\r\n/g, '\n');
    const asCrlf = asLf.replace(/\n/g, '\r\n');
    assert.notStrictEqual(asLf, asCrlf, 'precondition: the two spellings differ in bytes');
    const readResponse = text => ({ type: 'text', file: { filePath: 'x.js', content: text } });
    assert.strictEqual(digestOf(readResponse(asCrlf)), digestOf(readResponse(asLf)));
    assert.strictEqual(digestOf(readResponse(raw)), digestOf(readResponse(asLf)),
      'the checkout this suite runs in must not change the digest');
  });

  it('a lone CR is content, not a line ending, and still changes the digest', () => {
    assert.notStrictEqual(digestOf('10%\r20%'), digestOf('10%\n20%'));
    assert.notStrictEqual(digestOf('10%\r20%'), digestOf('10%20%'));
  });

  it('array order and content changes DO change the digest', () => {
    assert.notStrictEqual(digestOf({ rows: [1, 2] }), digestOf({ rows: [2, 1] }));
    assert.notStrictEqual(digestOf({ stdout: 'ok' }), digestOf({ stdout: 'Ok' }));
    assert.notStrictEqual(digestOf('1'), digestOf(1), 'a string and a number are different answers');
  });
});

describe('toolio/1: the error flag', () => {
  it('copies is_error / isError when the host reports them', () => {
    assert.strictEqual(describeToolResponse({ is_error: true, content: 'boom' }).response.error, true);
    assert.strictEqual(describeToolResponse({ is_error: false }).response.error, false);
    assert.strictEqual(describeToolResponse({ isError: true, content: [] }).response.error, true);
    assert.strictEqual(describeToolResponse({ isError: false, content: [] }).response.error, false);
  });

  it('reads a boolean, string or object `error` field, and an HTTP-shaped status', () => {
    assert.strictEqual(reportedError({ error: true }), true);
    assert.strictEqual(reportedError({ error: false }), false);
    assert.strictEqual(reportedError({ error: 'ENOENT' }), true);
    assert.strictEqual(reportedError({ error: { code: 1 } }), true);
    assert.strictEqual(reportedError({ error: '' }), null);
    assert.strictEqual(reportedError({ status: 404 }), true);
    assert.strictEqual(reportedError({ statusCode: 201 }), false);
    assert.strictEqual(reportedError({ status: 'done' }), null);
  });

  it('is null, meaning "no signal", when nothing recognizable is there; never inferred from content', () => {
    // Claude Code's Bash response shape carries no error flag at all.
    const bash = { stdout: '', stderr: 'error: something failed', interrupted: false, isImage: false };
    assert.strictEqual(describeToolResponse(bash).response.error, null,
      'the word "error" in stderr is content; judging it is the meter\'s job');
    assert.strictEqual(describeToolResponse('Error: not found').response.error, null);
    assert.strictEqual(describeToolResponse([{ is_error: true }]).response.error, null);
  });

  it('the flag is outside the digest input only in the sense that it is ALSO in it', () => {
    // The flag is copied from the response, so flipping it changes the digest
    // too: a receipt cannot carry error:false over a digest of an error.
    assert.notStrictEqual(digestOf({ is_error: true, x: 1 }), digestOf({ is_error: false, x: 1 }));
  });
});

describe('toolio/1: absent and unreadable responses are unrecorded, never an empty digest', () => {
  it('missing tool_response is recorded:false, reason absent, with no digest or bytes field', () => {
    const io = describeToolResponse(undefined);
    assert.deepStrictEqual(io, { schema: 'toolio/1', response: { recorded: false, reason: 'absent' } });
    assert.ok(!('digest' in io.response), 'no digest key at all');
    assert.ok(!('bytes' in io.response), 'no bytes key at all');
    assert.ok(!('error' in io.response), 'no error claim about a response nobody saw');
  });

  it('tool_response: null is recorded:false, reason null', () => {
    assert.deepStrictEqual(describeToolResponse(null).response, { recorded: false, reason: 'null' });
  });

  it('an uncanonicalizable value is recorded:false, reason unserializable, and does not throw', () => {
    const circular = { a: 1 };
    circular.self = circular;
    assert.deepStrictEqual(describeToolResponse(circular).response,
      { recorded: false, reason: 'unserializable' });
    assert.deepStrictEqual(describeToolResponse({ n: 10n }).response,
      { recorded: false, reason: 'unserializable' });
    assert.deepStrictEqual(describeToolResponse(() => 1).response,
      { recorded: false, reason: 'unserializable' });
  });

  it('an empty answer IS an answer: "" and {} are recorded with a real digest', () => {
    const s = describeToolResponse('').response;
    const o = describeToolResponse({}).response;
    assert.strictEqual(s.recorded, true);
    assert.strictEqual(o.recorded, true);
    assert.match(s.digest, /^[0-9a-f]{64}$/);
    assert.strictEqual(s.bytes, 2, '"" is two bytes of canonical text');
    assert.strictEqual(o.bytes, 2, '{} is two bytes of canonical text');
    assert.notStrictEqual(s.digest, o.digest);
    assert.notStrictEqual(s.digest, 'empty', 'never the legacy sentinel');
  });
});

describe('toolio/1: no response content leaks into the receipt', () => {
  it('values, keys and excerpts of the response appear nowhere in the toolIo object', () => {
    const CANARY = 'ghp_CANARYtoken0123456789abcdefABCDEF';
    const KEY_CANARY = 'aws_secret_access_key_CANARY';
    const response = {
      stdout: `export GITHUB_TOKEN=${CANARY}\r\n`,
      stderr: '',
      [KEY_CANARY]: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYCANARY',
      nested: { list: [CANARY, { deeper: CANARY.slice(4) }] }
    };
    const io = describeToolResponse(response);
    const serialized = JSON.stringify(io);
    for (const needle of [CANARY, CANARY.slice(4, 20), KEY_CANARY, 'GITHUB_TOKEN', 'wJalrXUtnFEMI', 'stdout', 'nested']) {
      assert.ok(!serialized.includes(needle), `toolIo must not contain ${needle}`);
    }
    // The shape is closed: only these keys, so a later edit cannot quietly add
    // an excerpt field without failing here.
    assert.deepStrictEqual(Object.keys(io).sort(), ['response', 'schema']);
    assert.deepStrictEqual(Object.keys(io.response).sort(), ['bytes', 'digest', 'error', 'recorded']);
  });
});

describe('toolio/1 on the chain (eval E2: chain fidelity)', () => {
  let tempDir;
  before(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotor-toolio-chain-')); });
  after(() => { if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true }); });

  // The receipt shape the post-tool-use hook writes, with the new field.
  function receiptWith(toolResponse) {
    return {
      type: 'egress-event',
      ruleId: 'egress-other',
      tool: 'Bash',
      paramsDigest: '0123456789abcdef',
      toolIo: describeToolResponse(toolResponse),
      timestamp: 1761100000000
    };
  }

  function chainFile(home) {
    return path.join(home, 'receipts', 'chain.jsonl');
  }

  function rewriteEntry(home, index, mutate) {
    const lines = fs.readFileSync(chainFile(home), 'utf8').split('\n').filter(l => l.trim());
    const entry = JSON.parse(lines[index]);
    mutate(entry);
    lines[index] = JSON.stringify(entry);
    fs.writeFileSync(chainFile(home), lines.join('\n') + '\n');
  }

  function verifyFresh(home) {
    return createStore(home).verify();
  }

  function seed(name) {
    const home = path.join(tempDir, name);
    fs.mkdirSync(home, { recursive: true });
    const store = createStore(home);
    store.appendReceipt(receiptWith({ stdout: 'first\r\n', is_error: false }));
    store.appendReceipt(receiptWith(undefined));
    store.appendReceipt(receiptWith({ stdout: 'third', is_error: true }));
    return home;
  }

  it('receipts carrying toolIo (recorded and unrecorded) verify on the chain', () => {
    const home = seed('verifies');
    assert.deepStrictEqual(verifyFresh(home), { ok: true });
    const entries = loadChain(home);
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[0].payload.toolIo.response.recorded, true);
    assert.strictEqual(entries[1].payload.toolIo.response.recorded, false);
    assert.strictEqual(entries[1].payload.toolIo.response.reason, 'absent');
    assert.strictEqual(entries[2].payload.toolIo.response.error, true);
    // What landed on disk round-trips to exactly what the module produced.
    assert.deepStrictEqual(entries[0].payload.toolIo,
      describeToolResponse({ stdout: 'first\n', is_error: false }),
      'a CRLF response on the chain matches its LF recomputation');
  });

  it('tampering with the response digest breaks verification at that entry', () => {
    const home = seed('tamper-digest');
    rewriteEntry(home, 0, e => {
      e.payload.toolIo.response.digest = describeToolResponse({ stdout: 'forged' }).response.digest;
    });
    const v = verifyFresh(home);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.brokenAt, 0);
  });

  it('tampering with the error flag or the byte count breaks verification', () => {
    const flag = seed('tamper-flag');
    rewriteEntry(flag, 2, e => { e.payload.toolIo.response.error = false; });
    assert.strictEqual(verifyFresh(flag).ok, false);
    assert.strictEqual(verifyFresh(flag).brokenAt, 2);

    const size = seed('tamper-bytes');
    rewriteEntry(size, 0, e => { e.payload.toolIo.response.bytes += 1; });
    assert.strictEqual(verifyFresh(size).brokenAt, 0);
  });

  it('upgrading an unrecorded response to a recorded one after the fact breaks verification', () => {
    const home = seed('tamper-absent');
    rewriteEntry(home, 1, e => {
      e.payload.toolIo.response = describeToolResponse({ stdout: 'planted' }).response;
    });
    const v = verifyFresh(home);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.brokenAt, 1);
  });

  it('stripping the toolIo field off a receipt breaks verification', () => {
    const home = seed('tamper-strip');
    rewriteEntry(home, 2, e => { delete e.payload.toolIo; });
    assert.strictEqual(verifyFresh(home).brokenAt, 2);
  });
});
