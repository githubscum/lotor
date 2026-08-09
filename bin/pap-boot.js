#!/usr/bin/env node
/**
 * pap-boot — decode a signed bundle back into a spine.
 *
 * Usage:
 *   node bin/pap-boot.js --bundle <path.bin> [--verify-key <path.pem>]
 *
 * Reads bundle bytes from --bundle (or stdin if the path is `-`),
 * verifies the signature (against --verify-key if supplied, otherwise
 * against the pubkey embedded in the manifest), decompresses the spine,
 * and writes it to stdout.
 *
 * Exit codes:
 *   0 on success
 *   1 on I/O error or unexpected failure
 *   2 on bad arguments
 *   4 on signature verification failure (limit of the record itself)
 *
 * A separate decoder-from-image tool is out of scope for v1 (see
 * src/publish/qr.js). The boot spec (BOOT-SPEC.md in the WO-PAP-01
 * prototype directory) describes the byte-mode read a reader must do to
 * get from a QR image to the bundle bytes this command consumes.
 *
 * Verification note (KNOWN-LIMITS 46): a verified signature proves the
 * decoded bytes are the bytes the key signed. It says nothing about
 * whether the spine boots a functional agent or whether the identity
 * described matches who the operator meant to publish.
 *
 * Ported from projects/spinoff/pap-prototype/cli/pap-boot.js
 * (WO-PAP-01) with a CJS-to-ESM conversion only.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { unpack } from '../src/publish/pack.js';

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.bundle) die('missing --bundle <path> (or --bundle - for stdin)');

  const bundle = args.bundle === '-'
    ? fs.readFileSync(0)
    : fs.readFileSync(args.bundle);

  const verifyKey = args.verifyKey
    ? crypto.createPublicKey({
        key: fs.readFileSync(args.verifyKey),
        format: 'pem',
      })
    : undefined;

  try {
    const { manifest, spine, spineRawLen, spineCompressedLen } = unpack({ bundle, verifyKey });
    process.stdout.write(spine);
    process.stderr.write(
      `pap-boot ok\n` +
      `  version ${manifest.version}\n` +
      `  seq ${manifest.seq}\n` +
      `  timestamp ${manifest.timestamp} (${new Date(manifest.timestamp).toISOString()})\n` +
      `  chain head ${manifest.chainHeadHash.toString('hex')}\n` +
      `  chain pubkey fp ${manifest.chainPubkeyFp.toString('hex')}\n` +
      (manifest.memoirUrl ? `  memoir ${manifest.memoirUrl}\n` : '') +
      `  raw ${spineRawLen} B, compressed ${spineCompressedLen} B\n`,
    );
    process.exit(0);
  } catch (err) {
    if (err.code === 'PAP_SIGNATURE_INVALID') {
      process.stderr.write('pap-boot: ' + err.message + '\n');
      process.exit(4);
    }
    process.stderr.write('pap-boot: ' + (err && err.stack || err) + '\n');
    process.exit(1);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--bundle': out.bundle = argv[++i]; break;
      case '--verify-key': out.verifyKey = argv[++i]; break;
      case '-h': case '--help': out.help = true; break;
      default:
        if (!a.startsWith('-')) break;
        die(`unknown flag: ${a}`);
    }
  }
  return out;
}

function die(msg) {
  process.stderr.write('pap-boot: ' + msg + '\n');
  process.exit(2);
}

main();
