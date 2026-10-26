/*
 * test/reach-ollama-chat.test.js
 *
 * Synthetic fixtures and a fake fetchImpl only: no real network. Covers
 * the 9 cases in WO-V3-05-WIRE, cases 10 and 11 in WO-V3-05-WIRE-FIX1
 * and case 12 in WO-V3-05-WIRE-FIX2, and cases 13 to 17 in
 * WO-V3-05-SERVED-MODEL.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatWithReach } from '../src/reach/ollama-chat.js';

// Fake fetch that records what it was called with, and answers with a
// fixed response.
function recordingFetch(status, text) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { status, text: async () => text };
  };
  impl.calls = calls;
  return impl;
}

test('1. local-model shape with logprobs: observed includes R0 and R4, silentlyDropped []', async () => {
  const fetchImpl = recordingFetch(200, JSON.stringify({
    model: 'qwen3:8b',
    message: { content: 'The port is 8080.' },
    logprobs: [
      { token: 'The', logprob: -0.5 },
      { token: ' port', logprob: -1.0 }
    ]
  }));
  const request = { model: 'qwen3:8b', logprobs: true, messages: [{ role: 'user', content: 'hi' }] };
  const result = await chatWithReach(request, { fetchImpl });

  assert.deepEqual(result.reach.observed, ['R0', 'R4']);
  assert.ok(result.reach.observed.includes('R0'));
  assert.ok(result.reach.observed.includes('R4'));
  assert.deepEqual(result.reach.silentlyDropped, []);
  assert.equal(result.reach.logprobs.count, 2);
  assert.equal(result.record.kind, 'reach.ollama-chat');
});

test('2. cloud silent drop: logprobs requested, 200 with none -> silentlyDropped ["R4"]', async () => {
  const fetchImpl = recordingFetch(200, JSON.stringify({
    model: 'glm-5.3-flash',
    message: { content: 'answer text' }
  }));
  const request = { model: 'x', logprobs: true, messages: [] };
  const result = await chatWithReach(request, { fetchImpl });

  assert.deepEqual(result.reach.silentlyDropped, ['R4']);
  assert.deepEqual(result.record.silentlyDropped, ['R4']);
  assert.equal(result.reach.error, null);
});

test('3. adapter forces stream:false and posts to ${host}/api/chat', async () => {
  const fetchImpl = recordingFetch(200, JSON.stringify({ model: 'm', message: { content: 'ok' } }));
  const host = 'http://example.test:9999';
  const request = { model: 'm', messages: [], stream: true };
  await chatWithReach(request, { host, fetchImpl });

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'http://example.test:9999/api/chat');
  assert.equal(fetchImpl.calls[0].init.method, 'POST');
  assert.equal(fetchImpl.calls[0].init.headers['content-type'], 'application/json');
  const sentBody = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(sentBody.stream, false);
});

test('4. non-2xx with non-JSON text: error "http 500", silentlyDropped []', async () => {
  const fetchImpl = recordingFetch(500, 'server blew up');
  const request = { model: 'm', logprobs: true, messages: [] };
  const result = await chatWithReach(request, { fetchImpl });

  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: 'http 500' });
  assert.equal(result.reach.error, 'http 500');
  assert.deepEqual(result.reach.silentlyDropped, []);
});

test('5. non-2xx with JSON error body: error is the body\'s own error', async () => {
  const fetchImpl = recordingFetch(404, JSON.stringify({ error: 'model not found' }));
  const result = await chatWithReach(
    { model: 'nope', messages: [] },
    { fetchImpl }
  );

  assert.equal(result.status, 404);
  assert.deepEqual(result.body, { error: 'model not found' });
  assert.equal(result.reach.error, 'model not found');
});

test('6. fetchImpl throws: no throw, status null, error starts with "fetch: "', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const result = await chatWithReach({ model: 'm', messages: [] }, { fetchImpl });

  assert.equal(result.status, null);
  assert.deepEqual(result.body, { error: 'fetch: ECONNREFUSED' });
  assert.ok(result.reach.error.startsWith('fetch: '));
  assert.equal(result.record.status, null);
  assert.equal(result.record.error, 'fetch: ECONNREFUSED');
});

test('7. non-object request throws TypeError', async () => {
  await assert.rejects(
    () => chatWithReach('not an object', { fetchImpl: recordingFetch(200, '{}') }),
    TypeError
  );
  await assert.rejects(() => chatWithReach(null), TypeError);
  await assert.rejects(() => chatWithReach([1, 2]), TypeError);
  await assert.rejects(() => chatWithReach(42), TypeError);
});

test('8. record holds no text: SECRET-CONTENT/THINK/ARG/TOK appear nowhere in it', async () => {
  const body = {
    model: 'm',
    message: {
      content: 'SECRET-CONTENT',
      thinking: 'SECRET-THINK',
      tool_calls: [{ function: { name: 'f', arguments: '{"x":"SECRET-ARG"}' } }]
    },
    logprobs: [{ token: 'SECRET-TOK', logprob: -0.1, top_logprobs: [{ token: 'SECRET-TOK', logprob: -0.1 }] }]
  };
  const fetchImpl = recordingFetch(200, JSON.stringify(body));
  const result = await chatWithReach(
    { model: 'm', logprobs: true, messages: [{ role: 'user', content: 'SECRET-CONTENT' }] },
    { fetchImpl }
  );

  const str = JSON.stringify(result.record);
  for (const secret of ['SECRET-CONTENT', 'SECRET-THINK', 'SECRET-ARG', 'SECRET-TOK']) {
    assert.ok(!str.includes(secret), `record leaked ${secret}`);
  }
  // The reach digest is still present, proving logprobs was observed.
  assert.ok(result.record.logprobs && result.record.logprobs.digest.startsWith('sha256:'));
});

test('9. record.at comes from the injected now', async () => {
  const fetchImpl = recordingFetch(200, JSON.stringify({ model: 'm', message: { content: 'ok' } }));
  const result = await chatWithReach({ model: 'm', messages: [] }, {
    fetchImpl,
    now: () => '2026-10-18T00:00:00.000Z'
  });

  assert.equal(result.record.at, '2026-10-18T00:00:00.000Z');
});

test('10. host with userinfo: record.host redacted, fetch URL keeps credentials', async () => {
  const fetchImpl = recordingFetch(200, JSON.stringify({ model: 'm', message: { content: 'ok' } }));
  const host = 'http://u:pw@example.test:9999';
  const result = await chatWithReach({ model: 'm', messages: [] }, { host, fetchImpl });

  assert.equal(result.record.host, 'http://example.test:9999');
  assert.ok(!JSON.stringify(result.record).includes('pw'), 'record leaked the password');
  assert.equal(fetchImpl.calls[0].url, 'http://u:pw@example.test:9999/api/chat');
});

test('11. unparseable host: record.host is "unparseable-host"', async () => {
  const fetchImpl = recordingFetch(200, JSON.stringify({ model: 'm', message: { content: 'ok' } }));
  const result = await chatWithReach({ model: 'm', messages: [] }, {
    host: 'not a url',
    fetchImpl
  });

  assert.equal(result.record.host, 'unparseable-host');
  assert.equal(fetchImpl.calls[0].url, 'not a url/api/chat');
});

test('12. fetch error quoting a credentials URL: userinfo redacted out of the record', async () => {
  const fetchImpl = async () => {
    throw new Error('Request cannot be constructed from a URL that includes credentials: http://u:pw@example.test:9999/api/chat');
  };
  const host = 'http://u:pw@example.test:9999';
  const result = await chatWithReach({ model: 'm', messages: [] }, { host, fetchImpl });

  assert.equal(result.status, null);
  const str = JSON.stringify(result.record);
  assert.ok(!str.includes('pw@'), 'record leaked the password');
  assert.ok(!str.includes('u:pw'), 'record leaked the credentials');
  assert.ok(result.record.error.includes('http://example.test:9999/api/chat'));
  assert.ok(result.record.error.startsWith('fetch: '));
});

test('13. matching models: servedModel and model both hold the served name', async () => {
  const fetchImpl = recordingFetch(200, JSON.stringify({
    model: 'llama3.2:1b',
    message: { content: 'ok' }
  }));
  const result = await chatWithReach(
    { model: 'llama3.2:1b', messages: [] },
    { fetchImpl }
  );

  assert.equal(result.record.servedModel, 'llama3.2:1b');
  assert.equal(result.record.model, 'llama3.2:1b');
});

test('14. mismatch: model keeps the requested name, servedModel the served name, exact key list', async () => {
  const fetchImpl = recordingFetch(200, JSON.stringify({
    model: 'b:7b',
    message: { content: 'ok' }
  }));
  const result = await chatWithReach(
    { model: 'a:1b', messages: [] },
    { fetchImpl }
  );

  assert.equal(result.record.model, 'a:1b');
  assert.equal(result.record.servedModel, 'b:7b');
  assert.deepEqual(Object.keys(result.record), [
    'kind',
    'at',
    'host',
    'model',
    'servedModel',
    'status',
    'requested',
    'observed',
    'silentlyDropped',
    'deepest',
    'error',
    'r3Sources',
    'logprobs'
  ]);
});

test('15. HTTP 500 with non-JSON body: servedModel is null', async () => {
  const fetchImpl = recordingFetch(500, 'server blew up');
  const result = await chatWithReach(
    { model: 'a:1b', messages: [] },
    { fetchImpl }
  );

  assert.equal(result.status, 500);
  assert.equal(result.record.servedModel, null);
  assert.equal(result.record.model, 'a:1b');
});

test('16. fetch throws: servedModel is null', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const result = await chatWithReach(
    { model: 'a:1b', messages: [] },
    { fetchImpl }
  );

  assert.equal(result.status, null);
  assert.equal(result.record.servedModel, null);
  assert.equal(result.record.model, 'a:1b');
});

test('17. body model is a number or an object: servedModel is null', async () => {
  const fetchImpl = recordingFetch(200, JSON.stringify({
    model: 42,
    message: { content: 'ok' }
  }));
  const numberResult = await chatWithReach(
    { model: 'a:1b', messages: [] },
    { fetchImpl }
  );
  assert.equal(numberResult.record.servedModel, null);

  const objectFetch = recordingFetch(200, JSON.stringify({
    model: { name: 'a:1b' },
    message: { content: 'ok' }
  }));
  const objectResult = await chatWithReach(
    { model: 'a:1b', messages: [] },
    { fetchImpl: objectFetch }
  );
  assert.equal(objectResult.record.servedModel, null);
});

test('18. 200 with an empty body: error "empty body", nothing silentlyDropped', async () => {
  const fetchImpl = recordingFetch(200, '');
  const result = await chatWithReach(
    { model: 'm', logprobs: true, messages: [] },
    { fetchImpl }
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { error: 'empty body' });
  assert.equal(result.record.error, 'empty body');
  assert.deepEqual(result.record.silentlyDropped, []);
  assert.deepEqual(result.reach.silentlyDropped, []);
  assert.equal(result.record.servedModel, null);
});

test('19. 200 with a non-JSON body: error "malformed body", nothing silentlyDropped', async () => {
  const fetchImpl = recordingFetch(200, '<html>bad gateway page</html>');
  const result = await chatWithReach(
    { model: 'm', logprobs: true, messages: [] },
    { fetchImpl }
  );

  assert.equal(result.status, 200);
  assert.equal(result.record.error, 'malformed body');
  assert.notEqual(result.record.error, null);
  assert.deepEqual(result.record.silentlyDropped, []);
  assert.deepEqual(result.reach.silentlyDropped, []);
});

test('20. 200 with JSON that is not an object: error set, nothing silentlyDropped', async () => {
  for (const text of ['[]', '"x"', '42', 'null']) {
    const fetchImpl = recordingFetch(200, text);
    const result = await chatWithReach(
      { model: 'm', logprobs: true, messages: [] },
      { fetchImpl }
    );

    assert.equal(result.status, 200, text);
    assert.equal(result.record.error, 'malformed body', text);
    assert.deepEqual(result.record.silentlyDropped, [], text);
    assert.deepEqual(result.reach.silentlyDropped, [], text);
  }
});