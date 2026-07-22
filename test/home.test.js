import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import { resolveHome } from '../src/home.js';

describe('resolveHome', () => {
  let savedHome;

  beforeEach(() => {
    savedHome = process.env.LOTOR_HOME;
  });

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env.LOTOR_HOME;
    } else {
      process.env.LOTOR_HOME = savedHome;
    }
  });

  it('honors LOTOR_HOME when set', () => {
    const custom = path.join(os.tmpdir(), 'lotor-home-test');
    process.env.LOTOR_HOME = custom;
    assert.strictEqual(resolveHome(), path.resolve(custom));
  });

  it('falls back to .lotor under the home dir when LOTOR_HOME is unset', () => {
    delete process.env.LOTOR_HOME;
    assert.strictEqual(resolveHome(), path.join(os.homedir(), '.lotor'));
  });
});
