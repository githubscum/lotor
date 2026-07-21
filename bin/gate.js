#!/usr/bin/env node
/**
 * bin/gate.js
 *
 * CLI to drive the gated action.
 * Usage:
 *   node bin/gate.js '<actionJSON>' [approvalTokenJSON]
 *   echo '<actionJSON>' | node bin/gate.js [approvalTokenJSON]
 *
 * Without approval token: shows denial.
 * With valid approval token: shows approval.
 */

import { createStore } from '../src/store/index.js';
import { gatedAction } from '../src/gate/index.js';

function main() {
  let actionJson;
  let tokenJson;

  // Parse arguments
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node bin/gate.js \'<actionJSON>\' [approvalTokenJSON]');
    console.error('   or: echo \'{"action":"test"}\' | node bin/gate.js [approvalTokenJSON]');
    process.exit(1);
  }

  // First arg is the action JSON
  actionJson = args[0];

  // Second arg (optional) is the approval token JSON
  if (args.length >= 2) {
    tokenJson = args[1];
  }

  // Parse action request
  let actionRequest;
  try {
    actionRequest = JSON.parse(actionJson);
  } catch (e) {
    console.error('Error: invalid action JSON:', e.message);
    process.exit(1);
  }

  // Parse approval token if provided
  let approvalToken = null;
  if (tokenJson) {
    try {
      approvalToken = JSON.parse(tokenJson);
    } catch (e) {
      console.error('Error: invalid approval token JSON:', e.message);
      process.exit(1);
    }
  }

  // Create store and get chain
  const store = createStore();
  const chain = {
    entries: store.entries,
    append: store.appendReceipt.bind(store)
  };

  // Execute gated action
  const result = gatedAction(actionRequest, approvalToken, chain);

  // Output structured result
  console.log(JSON.stringify(result, null, 2));
}

main();
