import fs from 'node:fs';
import path from 'node:path';

/**
 * src/store/lock.js
 *
 * Cross-process advisory lock for the receipt chain.
 *
 * Why this exists: the chain is an append-only hash chain. Each new entry's
 * prevHash must point at the CURRENT tail on disk. Two processes appending at
 * the same time (which happens for real now that bin/hook-session-end.js writes
 * on every session end) would each read the same tail, compute the same seq and
 * the same prevHash, and both append. verifyChain then fails on the prevHash
 * linkage check.
 *
 * Locking only the file write is NOT enough: the chain state has to be re-read
 * from disk INSIDE the lock. That is what withLock() is for.
 *
 * Mechanism: exclusive-create of a lock file (fs.openSync with 'wx'), which is
 * atomic on both POSIX and Windows. No dependencies, node builtins only.
 */

const LOCK_FILENAME = '.chain.lock';

/** A lock file older than this is assumed to belong to a crashed process. */
const STALE_MS = 30000;

/** Total time we are willing to wait for the lock before giving up. */
const TOTAL_WAIT_MS = 5000;

/** Sleep between acquisition attempts. */
const RETRY_SLEEP_MS = 25;

/**
 * Synchronous sleep. Atomics.wait on a never-notified SharedArrayBuffer is the
 * only way to block the main thread without spinning the CPU.
 * @param {number} ms
 */
function sleepSync(ms) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Absolute path of the chain lock file for a given base dir.
 * @param {string} baseDir
 * @returns {string}
 */
function lockPathFor(baseDir) {
  return path.join(baseDir, 'receipts', LOCK_FILENAME);
}

/**
 * Error codes that mean "someone else has it right now", not "broken".
 * Windows reports EPERM/EACCES/EBUSY instead of EEXIST when the target file is
 * open elsewhere or is in a pending-delete state (the release/acquire race).
 */
const CONTENDED = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

/**
 * Try once to create the lock file exclusively.
 * @param {string} lockPath
 * @returns {boolean} true if the lock was acquired
 */
function tryAcquire(lockPath) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (CONTENDED.has(err.code)) {
      return false;
    }
    throw err;
  }

  try {
    // Diagnostics only: who holds it and since when.
    fs.writeSync(fd, `${process.pid} ${Date.now()}`);
  } finally {
    fs.closeSync(fd);
  }

  return true;
}

/**
 * Remove the lock file if it is stale (or already gone).
 * A crashed process must not deadlock every future session.
 * @param {string} lockPath
 * @returns {boolean} true if it is worth retrying acquisition immediately
 */
function stealIfStale(lockPath) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return true; // holder released it; retry now
    }
    // Windows can report EPERM for a file in pending-delete state. Not stale,
    // not fatal: just contended. Back off and try again.
    return false;
  }

  if (Date.now() - stat.mtimeMs > STALE_MS) {
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        return false; // someone else got there first, or we cannot remove it
      }
    }
    return true;
  }

  return false;
}

/**
 * Release the lock. Must never throw: a release failure should not mask the
 * result (or the error) of the work that ran under the lock.
 * @param {string} lockPath
 */
function release(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already gone, or not ours to remove. Nothing useful to do here.
  }
}

/**
 * Run fn() while holding an exclusive advisory lock on the chain.
 * Synchronous by design: the chain append path is synchronous end to end.
 *
 * @param {string} baseDir - Lotor home (the dir that contains receipts/)
 * @param {Function} fn - Synchronous critical section
 * @returns {*} fn's return value
 * @throws {Error} if the lock cannot be acquired within TOTAL_WAIT_MS
 */
function withLock(baseDir, fn) {
  ensureDir(path.join(baseDir, 'receipts'));
  const lockPath = lockPathFor(baseDir);

  const deadline = Date.now() + TOTAL_WAIT_MS;
  let acquired = false;

  for (;;) {
    if (tryAcquire(lockPath)) {
      acquired = true;
      break;
    }

    // Held by someone. If that someone is long dead, take it.
    if (stealIfStale(lockPath) && tryAcquire(lockPath)) {
      acquired = true;
      break;
    }

    if (Date.now() >= deadline) {
      break;
    }

    sleepSync(RETRY_SLEEP_MS);
  }

  if (!acquired) {
    throw new Error(
      `lotor: could not acquire chain lock at ${lockPath} within ${TOTAL_WAIT_MS}ms. ` +
      `Another process may be appending. If no other Lotor process is running, ` +
      `delete the lock file and retry.`
    );
  }

  try {
    return fn();
  } finally {
    release(lockPath);
  }
}

export {
  withLock,
  lockPathFor,
  LOCK_FILENAME,
  STALE_MS,
  TOTAL_WAIT_MS
};
