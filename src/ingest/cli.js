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
  const entry = ingestSession(jsonlText);
  console.log(`Ingested session. Chain entry seq=${entry.seq}, hash=${entry.hash.slice(0, 16)}...`);
  process.exit(0);
} catch (err) {
  console.error(`Error ingesting file: ${err.message}`);
  process.exit(1);
}
