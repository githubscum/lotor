/**
 * QR render tests.
 *
 * We test the render side: bundle bytes go in, valid PNG/SVG comes out.
 * Round-trip through an image decoder is deferred to the boot spec —
 * that path needs a camera or a decoder library and belongs in the
 * end-user boot tool, not in the encoder.
 *
 * Ported from projects/spinoff/pap-prototype/test/qr.test.js (WO-PAP-01)
 * with a CJS-to-ESM conversion and the src/publish/ import paths.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pack, generateKeypair } from '../src/publish/pack.js';
import { bundleToPng, bundleToSvg } from '../src/publish/qr.js';
import { QR_V40_BINARY_ECL_CAPACITY } from '../src/publish/manifest.js';

function testInputs() {
  const { privateKey, publicKeyRaw } = generateKeypair();
  return {
    spine: 'You are ike. Direct, dark-humored. The record is what recurs.',
    chainHeadHash: crypto.randomBytes(32),
    chainPubkeyFp: publicKeyRaw,
    seq: 1479,
    timestamp: 1786121234567,
    signingKey: privateKey,
  };
}

test('renders bundle to a valid PNG buffer', async () => {
  const { bundle } = pack(testInputs());
  const png = await bundleToPng(bundle);
  assert.ok(Buffer.isBuffer(png), 'PNG output is a Buffer');
  // PNG magic number: 89 50 4E 47 0D 0A 1A 0A
  assert.deepEqual(
    png.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    'PNG has correct magic bytes',
  );
});

test('renders bundle to valid SVG', async () => {
  const { bundle } = pack(testInputs());
  const svg = await bundleToSvg(bundle);
  assert.equal(typeof svg, 'string');
  assert.match(svg, /^<\?xml|^<svg/, 'SVG starts with XML declaration or svg tag');
  assert.match(svg, /<\/svg>\s*$/, 'SVG closes with </svg>');
});

test('refuses to render an oversized bundle with a labelled error', async () => {
  // Fabricate a Buffer bigger than the cap. Bypass pack()'s own budget
  // check to test the QR-side belt-and-braces guard.
  const oversized = Buffer.alloc(QR_V40_BINARY_ECL_CAPACITY + 100);
  await assert.rejects(
    () => bundleToPng(oversized),
    (err) => err.code === 'PAP_QR_BUDGET_EXCEEDED',
    'oversized bundle must be rejected at the QR layer too',
  );
});
