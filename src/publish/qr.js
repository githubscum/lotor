/**
 * PAP QR — bundle bytes ↔ QR image.
 *
 * The `qrcode` library on npm handles both PNG and SVG rendering. This
 * module is a thin wrapper that:
 *   - refuses to render if the bundle exceeds the QR v40 binary EC-L cap
 *     (we already refuse in pack(), but a caller could pass raw bundle
 *     bytes here without going through pack, so we double-check)
 *   - pins version = 40 and error correction = 'L' so the same 2953-byte
 *     budget the encoder assumes actually applies
 *   - encodes as byte-mode explicitly; QR's default character analysis
 *     would try alphanumeric mode on ASCII-looking bytes and produce a
 *     different capacity budget.
 *
 * Decoding a QR image back to bytes is deferred to the boot spec — it
 * needs a decoder library (or a phone camera). The boot spec
 * (BOOT-SPEC.md in the WO-PAP-01 prototype directory) describes the
 * byte-mode read a reader must do.
 *
 * Ported from projects/spinoff/pap-prototype/src/qr.js (WO-PAP-01,
 * built 2026-08-07, 13/13 tests green) with a CJS-to-ESM conversion only.
 */

import QRCode from 'qrcode';
import { QR_V40_BINARY_ECL_CAPACITY } from './manifest.js';

const QR_OPTIONS = {
  version: 40,
  errorCorrectionLevel: 'L',
  // Explicit byte mode: the qrcode library's segment auto-detection would
  // otherwise pick a mode that changes the capacity budget.
};

/**
 * Render bundle bytes to a QR PNG (returns a Buffer).
 */
async function bundleToPng(bundle) {
  guard(bundle);
  return QRCode.toBuffer(byteSegments(bundle), { ...QR_OPTIONS, type: 'png' });
}

/**
 * Render bundle bytes to a QR SVG (returns a string).
 */
async function bundleToSvg(bundle) {
  guard(bundle);
  return QRCode.toString(byteSegments(bundle), { ...QR_OPTIONS, type: 'svg' });
}

// ---------- internal ----------

function guard(bundle) {
  if (!Buffer.isBuffer(bundle)) throw new TypeError('bundle must be a Buffer');
  if (bundle.length > QR_V40_BINARY_ECL_CAPACITY) {
    const err = new Error(
      `bundle is ${bundle.length} bytes, exceeds QR v40 binary EC-L cap of ${QR_V40_BINARY_ECL_CAPACITY} bytes. ` +
      `Shrink the spine or split into multiple QRs.`,
    );
    err.code = 'PAP_QR_BUDGET_EXCEEDED';
    throw err;
  }
}

function byteSegments(bundle) {
  return [{ data: bundle, mode: 'byte' }];
}

export {
  bundleToPng,
  bundleToSvg,
  QR_OPTIONS,
};
