// Build web/reader/index.html: one self-contained file, no external loads, so
// it runs from a saved copy, offline, from file://. Deterministic: the same
// sources give the same bytes, and test/pap-reader.test.js fails if the
// committed index.html is not the build of the committed sources.
//
//   node web/reader/build.mjs           write index.html
//   node web/reader/build.mjs --check   exit 1 if index.html is stale

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const read = (...p) => fs.readFileSync(path.join(DIR, ...p), 'utf8').split(CRLF).join(LF);

// Pinned vendor files: version, where the bytes came from, sha256 of the LF
// bytes. The build refuses a vendor file that does not match.
export const VENDOR = {
  'jsQR.js': {
    version: 'jsqr 1.4.0', source: 'npm jsqr@1.4.0, dist/jsQR.js', license: 'Apache-2.0',
    sha256: 'bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859',
  },
  'brotli-decode.js': {
    version: 'google/brotli v1.1.0', source: 'github.com/google/brotli tag v1.1.0, js/decode.js', license: 'MIT',
    sha256: 'b7924dfa0f428a31ad655970218d1573b56c1830132e894c37934a5e5e7586eb',
  },
  'noble-ed25519.js': {
    version: '@noble/ed25519 2.3.0', source: 'npm @noble/ed25519@2.3.0, index.js', license: 'MIT',
    sha256: '70cebecaaa6a126ced702198706c49d03f2d6f70317342b75e50e8d2d4951fe5',
  },
};

function vendor(name) {
  const text = read('vendor', name);
  const got = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  if (got !== VENDOR[name].sha256) throw new Error(`vendor/${name} is ${got}, pinned ${VENDOR[name].sha256}`);
  return text;
}

function replaceOnce(text, label, from, to) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`${label}: expected one occurrence, found ${n}`);
  return text.split(from).join(to);
}

// ESM source to a plain script body: drop the export keywords and imports.
function stripModule(text, label) {
  return text
    .split(LF)
    .filter((line) => !line.startsWith('import '))
    .map((line) => line.replace(/^export (const|let|function|async function) /, '$1 '))
    .join(LF)
    .replace(/^export /m, () => { throw new Error(`${label}: unhandled export`); });
}

function scriptTag(body, type) {
  if (/<\/script/i.test(body)) throw new Error('a script body contains a closing script tag');
  return `<script${type ? ` type="${type}"` : ''}>${LF}${body}${LF}</script>`;
}

export function build() {
  const jsqr = vendor('jsQR.js');
  const brotli = replaceOnce(vendor('brotli-decode.js'), 'brotli export',
    'export let BrotliDecode = makeBrotliDecode();', 'let BrotliDecode = makeBrotliDecode();');
  const noble = replaceOnce(vendor('noble-ed25519.js'), 'noble export',
    'export { ed25519_CURVE as CURVE, etc, Point as ExtendedPoint, getPublicKey, getPublicKeyAsync, Point, sign, signAsync, utils, verify, verifyAsync, };',
    '');
  const vendorBlock = [
    `<!-- vendor: ${Object.values(VENDOR).map((v) => v.version).join(', ')}; pins in web/reader/build.mjs -->`,
    scriptTag(jsqr),
    scriptTag(`(() => {${LF}${brotli}${LF}self.BrotliDecode = BrotliDecode;${LF}})();`),
    scriptTag(`(() => {${LF}${noble}${LF}self.nobleEd25519 = { verifyAsync };${LF}})();`),
  ].join(LF);

  const app = [
    stripModule(read('pap-reader.js'), 'pap-reader.js'),
    'const reader = { verify, open, parse, toHex, fromHex };',
    stripModule(read('scan.js'), 'scan.js'),
    stripModule(read('view.js'), 'view.js'),
    'const deps = {',
    '  subtle: crypto.subtle,',
    '  brotliDecode: (u8) => { const out = self.BrotliDecode(new Int8Array(u8.buffer, u8.byteOffset, u8.length)); return new Uint8Array(out.buffer, out.byteOffset, out.length); },',
    '  ed25519Fallback: self.nobleEd25519,',
    '};',
    'mount(document, reader, deps, makeScanner(self.jsQR, document));',
  ].join(LF);

  let html = read('index.src.html');
  html = replaceOnce(html, 'vendor slot', '<!--VENDOR-->', vendorBlock);
  html = replaceOnce(html, 'app slot', '<!--APP-->', scriptTag(app, 'module'));
  return html;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.join(DIR, 'index.html');
  const html = build();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split(CRLF).join(LF) : '';
    if (cur !== html) { console.log('web/reader/index.html is stale: run node web/reader/build.mjs'); process.exit(1); }
    console.log('web/reader/index.html is current');
  } else {
    fs.writeFileSync(out, html);
    console.log(`wrote web/reader/index.html, ${Buffer.byteLength(html)} bytes, sha256 ${crypto.createHash('sha256').update(html).digest('hex')}`);
  }
}
