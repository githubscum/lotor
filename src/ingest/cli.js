#!/usr/bin/env node

/**
 * src/ingest/cli.js
 *
 * CLI entry for ingesting a JSONL session file.
 * Usage: node src/ingest/cli.js <path-to-session.jsonl>
 */

import fs from 'node:fs';
import { ingestSession } from './index.js';

const filePath = process.argv[2];

if (!filePath) {
  console.error('Usage: node src/ingest/cli.js <path-to-session.jsonl>');
  process.exit(1);
}

try {
  const jsonlText = fs.readFileSync(filePath, 'utf-8');
  const result = ingestSession(jsonlText);

  if (result.skipped) {
    console.log(`No new activity for session ${result.sessionId}; nothing appended.`);
  } else {
    const { entry, subsession, sessionId } = result;
    console.log(
      `Ingested session ${sessionId} subsession=${subsession} ` +
      `seq=${entry.seq} hash=${entry.hash.slice(0, 16)}...`
    );
  }
  process.exit(0);
} catch (err) {
  console.error(`Error ingesting file: ${err.message}`);
  process.exit(1);
}
