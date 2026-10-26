/**
 * test/keyed-digest.test.js
 *
 * Proves the WO-KEYED-DIGEST-01 helper by running it, not by reading it:
 * a plain SHA-256 of a short text is recoverable by dictionary search,
 * and the same search against a keyed (HMAC-SHA256) digest finds nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  DIGEST_KEY_MIN_BYTES,
  keyedDigest,
  plainDigest,
  verifyKeyedDigest,
  isShortText
} from '../src/digest/keyed.js';

const newKey = () => crypto.randomBytes(DIGEST_KEY_MIN_BYTES);

function flipOneHexChar(hex) {
  const i = hex.length - 1;
  const digit = parseInt(hex[i], 16) ^ 1;
  return hex.slice(0, i) + digit.toString(16) + hex.slice(i + 1);
}

test('DIGEST_KEY_MIN_BYTES is 32', () => {
  assert.equal(DIGEST_KEY_MIN_BYTES, 32);
});

test('dictionary attack: plain sha256 of a 4-digit secret is recovered by hashing "0000".."9999"; the keyed digest under a random key is not', () => {
  const dictionary = Array.from({ length: 10000 }, (_, n) => String(n).padStart(4, '0'));
  const secret = '4821';

  // Plain: hash every candidate, compare; the secret falls out.
  const plainRecord = plainDigest(secret);
  const recovered = dictionary.find((candidate) => plainDigest(candidate).digest === plainRecord.digest);
  assert.equal(recovered, '4821');

  // Keyed: the same plain-sha256 dictionary search finds nothing.
  const key = newKey();
  const keyedRecord = keyedDigest(secret, key);
  const keyedHit = dictionary.find((candidate) => plainDigest(candidate).digest === keyedRecord.digest);
  assert.equal(keyedHit, undefined);

  // The keyed search only succeeds when the attacker also holds the key.
  const keyedDictionary = new Map(dictionary.map((candidate) => [keyedDigest(candidate, key).digest, candidate]));
  assert.equal(keyedDictionary.get(keyedRecord.digest), '4821');
});

test('determinism: same text + same key gives the same digest and keyId; a different key gives both different', () => {
  const keyA = newKey();
  const keyB = newKey();

  const first = keyedDigest('same text', keyA);
  const second = keyedDigest('same text', keyA);
  assert.equal(first.digest, second.digest);
  assert.equal(first.keyId, second.keyId);

  const underB = keyedDigest('same text', keyB);
  assert.notEqual(first.digest, underB.digest);
  assert.notEqual(first.keyId, underB.keyId);
});

test('verifyKeyedDigest: true for the right record, false for wrong text, wrong key, wrong alg, tampered digest, wrong-length digest, null record, and a non-object record', () => {
  const key = newKey();
  const otherKey = newKey();
  const record = keyedDigest('open sesame', key);

  assert.equal(verifyKeyedDigest(record, 'open sesame', key), true);

  assert.equal(verifyKeyedDigest(record, 'open sasame', key), false);
  assert.equal(verifyKeyedDigest(record, 'open sesame', otherKey), false);
  assert.equal(verifyKeyedDigest({ ...record, alg: 'sha256' }, 'open sesame', key), false);
  assert.equal(
    verifyKeyedDigest({ ...record, digest: flipOneHexChar(record.digest) }, 'open sesame', key),
    false
  );
  assert.equal(
    verifyKeyedDigest({ ...record, digest: record.digest + 'ab' }, 'open sesame', key),
    false
  );
  assert.equal(verifyKeyedDigest(null, 'open sesame', key), false);
  assert.equal(verifyKeyedDigest('not a record', 'open sesame', key), false);
  assert.equal(verifyKeyedDigest(7, 'open sesame', key), false);
});

test('key validation: 31-byte Buffer throws TypeError mentioning the minimum; a string key throws TypeError without echoing the key', () => {
  assert.throws(() => keyedDigest('x', crypto.randomBytes(31)), TypeError);

  try {
    keyedDigest('x', 'hunter2-secret-key');
    assert.fail('string key must throw');
  } catch (err) {
    assert.ok(err instanceof TypeError);
    assert.ok(!err.message.includes('hunter2-secret-key'));
  }

  try {
    keyedDigest('x', crypto.randomBytes(31));
    assert.fail('31-byte key must throw');
  } catch (err) {
    assert.ok(err instanceof TypeError);
    assert.ok(err.message.includes(String(DIGEST_KEY_MIN_BYTES)));
  }
});

test('non-string text throws TypeError for both keyedDigest and plainDigest', () => {
  const key = newKey();
  for (const bad of [undefined, null, 42, Buffer.from('ok'), { text: 'ok' }, ['ok']]) {
    assert.throws(() => keyedDigest(bad, key), TypeError);
    assert.throws(() => plainDigest(bad), TypeError);
  }
});

test('returned records are frozen', () => {
  const record = keyedDigest('persist', newKey());
  const plain = plainDigest('persist');
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(plain), true);
});

test('isShortText measures utf8 bytes, not characters', () => {
  assert.equal(isShortText('ok'), true);
  assert.equal(isShortText('a'.repeat(64)), true);
  assert.equal(isShortText('a'.repeat(65)), false);
  assert.equal(isShortText('é'.repeat(40)), false);

  // 40 'é' are 40 characters but 80 utf8 bytes. Over the default 64.
  assert.equal(Buffer.byteLength('é'.repeat(40), 'utf8'), 80);
  assert.equal(isShortText('é'.repeat(20), 64), true);
});

test('keyId is domain-separated: it is neither the first 16 hex of HMAC(key, \'\') nor of sha256(key)', () => {
  const key = newKey();
  const record = keyedDigest('anything', key);

  const hmacEmpty = crypto.createHmac('sha256', key).update('', 'utf8').digest('hex').slice(0, 16);
  const hashKey = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);

  assert.notEqual(record.keyId, hmacEmpty);
  assert.notEqual(record.keyId, hashKey);
});

test('verifyKeyedDigest rejects non-canonical hex spellings', () => {
  const key = newKey();
  const record = keyedDigest('open sesame', key);

  // The unmodified record still verifies...
  assert.equal(verifyKeyedDigest(record, 'open sesame', key), true);

  const spellings = [
    { label: 'digest + zz', digest: record.digest + 'zz' },
    { label: 'digest + a (odd nibble)', digest: record.digest + 'a' },
    { label: 'digest uppercase', digest: record.digest.toUpperCase() },
    { label: 'digest with leading space', digest: ' ' + record.digest },
    { label: 'digest as a Buffer', digest: Buffer.from(record.digest, 'utf8') },
    { label: 'keyId + zz', keyId: record.keyId + 'zz', digest: record.digest },
    { label: 'keyId uppercase', keyId: record.keyId.toUpperCase(), digest: record.digest }
  ];

  for (const { label, ...spelling } of spellings) {
    assert.equal(verifyKeyedDigest({ ...record, ...spelling }, 'open sesame', key), false, label);
  }
});