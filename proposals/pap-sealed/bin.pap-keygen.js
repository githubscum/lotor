#!/usr/bin/env node
/**
 * pap-keygen: make an X25519 recipient keypair for sealed PAP bundles.
 *
 * Usage:
 *   node bin/pap-keygen.js --out <basepath>
 *
 * Writes <basepath>.key (PKCS8 PEM, the secret; keep it) and <basepath>.pub
 * (64 hex chars; hand it to whoever seals bundles for you). Refuses to
 * overwrite either file.
 *
 * A recipient key is not the chain key and signs nothing. It only opens
 * bundles sealed to it. Anyone who later obtains the .key file opens every
 * bundle ever sealed to it, and those bundles are QR codes that may have
 * been photographed anywhere (KNOWN-LIMITS, sealed-mode entry). Treat it
 * like the chain key: it is stored unencrypted, here too.
 */

import fs from 'node:fs';
import { generateRecipientKeypair } from '../src/publish/pack.js';

function main() {
  const argv = process.argv.slice(2);
  let out;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') {
      process.stdout.write('usage: node bin/pap-keygen.js --out <basepath>\n');
      process.exit(0);
    } else die(`unknown argument: ${argv[i]}`);
  }
  if (!out) die('missing --out <basepath>');
  for (const p of [out + '.key', out + '.pub']) {
    if (fs.existsSync(p)) die(`${p} exists; refusing to overwrite a key`);
  }
  const kp = generateRecipientKeypair();
  fs.writeFileSync(out + '.key', kp.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  fs.writeFileSync(out + '.pub', kp.publicKeyRaw.toString('hex') + '\n');
  process.stdout.write(`pap-keygen ok\n  secret ${out}.key\n  public ${out}.pub ${kp.publicKeyRaw.toString('hex')}\n`);
}

function die(msg) {
  process.stderr.write('pap-keygen: ' + msg + '\n');
  process.exit(2);
}

main();
