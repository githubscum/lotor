#!/usr/bin/env node
/**
 * bin/hook-session-end.js
 *
 * Claude Code `SessionEnd` hook target. Appends a Lotor receipt for the
 * session that just ended.
 *
 * STDIN CONTRACT
 *   Reads one JSON object from stdin (the Claude Code hook payload) and takes
 *   the transcript location from `transcript_path`, falling back to
 *   `transcriptPath`. A path may also be passed as argv[2] for manual testing,
 *   which takes precedence and makes stdin optional.
 *
 * OUTPUT CONTRACT
 *   Nothing is ever written to stdout: the hook system may interpret stdout.
 *   All diagnostics go to stderr, one line each.
 *
 * EXIT-0-ALWAYS RULE
 *   This hook must never break the user's session. Every failure mode
 *   (no stdin, malformed JSON, missing or unreadable transcript, parse
 *   failure, store failure) is caught, reported on stderr, and exits 0.
 *   There is no non-zero exit path.
 *
 * IDEMPOTENCY (subsession-aware)
 *   Subsession logic lives in ingestSession: each SessionEnd appends a new
 *   receipt for the same session indexed 0, 1, 2, ... n. The no-change guard
 *   skips when the transcript has not grown since the last receipt.
 */

import fs from 'node:fs';
import { ingestSession } from '../src/ingest/index.js';
import { resolveHome } from '../src/home.js';

const STDIN_TIMEOUT_MS = 5000;

function note(message) {
  process.stderr.write(`lotor hook-session-end: ${message}\n`);
}

/**
 * Read all of stdin as text. Resolves to '' if stdin is a TTY, is closed,
 * or does not produce data within the timeout.
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    let done = false;
    const chunks = [];

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(chunks.join(''));
    };

    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/**
 * Pull the transcript path out of the hook payload text.
 * @param {string} raw
 * @returns {string|null}
 */
function transcriptPathFromPayload(raw) {
  if (!raw || raw.trim() === '') return null;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    note(`stdin was not valid JSON (${e.message}); nothing ingested`);
    return null;
  }
  if (!payload || typeof payload !== 'object') {
    note('stdin JSON was not an object; nothing ingested');
    return null;
  }
  const candidate = payload.transcript_path || payload.transcriptPath;
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    note('payload carried no transcript_path; nothing ingested');
    return null;
  }
  return candidate;
}

async function main() {
  const argPath = process.argv[2];
  const transcriptPath = (typeof argPath === 'string' && argPath.trim() !== '')
    ? argPath
    : transcriptPathFromPayload(await readStdin());

  if (!transcriptPath) {
    return;
  }

  let text;
  try {
    text = fs.readFileSync(transcriptPath, 'utf-8');
  } catch (e) {
    note(`could not read transcript (${e.code || e.message}); nothing ingested`);
    return;
  }

  // resolveHome is read here so the home lookup failure (if any) is reported
  // on stderr before the ingest path. ingestSession itself also calls
  // resolveHome, so the value is the same.
  resolveHome();

  try {
    const result = ingestSession(text);
    if (result.skipped) {
      note(`no new activity for session ${result.sessionId}; nothing appended`);
    } else {
      note(
        `appended receipt seq ${result.entry.seq} subsession ${result.subsession} ` +
        `for session ${result.sessionId}`
      );
    }
  } catch (e) {
    note(`could not ingest (${e.message}); nothing appended`);
  }
}

main()
  .catch(e => {
    try {
      note(`unexpected failure (${e && e.message ? e.message : e})`);
    } catch (_) {
      // stderr itself failed; there is nothing further to do
    }
  })
  .finally(() => {
    process.exit(0);
  });
