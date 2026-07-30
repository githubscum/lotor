/**
 * test/term-colour-tty.test.js
 *
 * Asserts the colour module honours NO_COLOR and non-TTY.
 *
 * Test-time note: the colour module's TTY / NO_COLOR check runs at module
 * LOAD. Toggling env vars after import does nothing to the cached decision.
 * Each test uses a fresh module instance via a query-string cache buster on
 * the import URL, per node:test convention for env-sensitive modules.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

async function freshColourModule() {
  return await import(`../src/term/colour.js?t=${Date.now()}${Math.random()}`);
}

test('NO_COLOR disables all colour', async () => {
  const prev = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const m = await freshColourModule();
    assert.equal(m.colour('gate', 'test'), 'test');
    assert.equal(m.fg('gate'), '');
    assert.equal(m.colourEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prev;
  }
});

test('non-TTY stdout disables all colour', async () => {
  const wasTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  try {
    const m = await freshColourModule();
    assert.equal(m.colour('warn', 'test'), 'test');
    assert.equal(m.colourEnabled(), false);
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: wasTTY, configurable: true });
  }
});

test('every known state exposes an RGB triple', async () => {
  const m = await freshColourModule();
  for (const state of ['gate', 'warn', 'ok', 'off']) {
    const rgb = m.RGB[state];
    assert.equal(Array.isArray(rgb), true, `RGB[${state}] should be an array`);
    assert.equal(rgb.length, 3, `RGB[${state}] should have 3 components`);
    for (const c of rgb) {
      assert.equal(typeof c, 'number', `RGB[${state}] should be numbers`);
      assert.ok(c >= 0 && c <= 255, `RGB[${state}] should be 0-255`);
    }
  }
});
