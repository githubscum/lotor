#!/usr/bin/env node
/**
 * bin/approve.js
 *
 * CLI for the owner to approve gated actions.
 * Usage:
 *   node bin/approve.js init                    # generate approval keypair
 *   node bin/approve.js approve '<actionJSON>'  # create approval token
 */

import { init, createApprovalToken } from '../src/gate/sign.js';

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`approve.js — Owner approval signer for gated actions

usage:
  node bin/approve.js init                        generate approval keypair
  node bin/approve.js approve '<actionJSON>'      create approval token

Signer requires a TTY. Run from a terminal, not from a piped process.
The approval token is printed to stdout as JSON.
`);
    return;
  }

  if (cmd === 'init') {
    await init();
    return;
  }

  if (cmd === 'approve') {
    const actionJson = rest.join(' ');
    if (!actionJson) {
      console.error('error: no action JSON provided');
      process.exit(2);
    }

    let actionRequest;
    try {
      actionRequest = JSON.parse(actionJson);
    } catch (e) {
      console.error('error: invalid JSON:', e.message);
      process.exit(2);
    }

    const token = await createApprovalToken(actionRequest);
    console.log(JSON.stringify(token, null, 2));
    return;
  }

  console.error('error: unknown command:', cmd);
  process.exit(2);
}

main().catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
