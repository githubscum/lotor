import crypto from 'node:crypto';

/**
 * src/chain/merkle.js
 *
 * RFC 9162 (Certificate Transparency v2) section 2.1 Merkle tree hashing, the
 * same tree as RFC 6962 and the one C2SP tlog-checkpoint names for its root
 * hash. Node builtins only.
 *
 *   leaf hash  = SHA-256(0x00 || leaf data)
 *   node hash  = SHA-256(0x01 || left || right)
 *   MTH({})    = SHA-256() of the empty string
 *   MTH(D[n])  = node(MTH(D[0:k]), MTH(D[k:n])), k the largest power of two
 *                strictly less than n
 *
 * Every function here takes and returns 32-byte Buffers. Tree sizes and
 * indexes are plain non-negative safe integers; halving uses Math.floor, not
 * the 32-bit bit operators, so sizes above 2^31 stay correct.
 *
 * Why no dependency: the algorithms are ~150 lines of RFC text, the npm
 * candidates found on 2026-10-26 (ctjs, last published 2018, plus several
 * release-candidate packages from 2026) are unmaintained or unproven, and this
 * file lands in protected core, where a dependency is a supply-chain surface
 * the gate cannot see. The RFC 6962 reference roots are pinned in the tests.
 */

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

/** MTH of the empty tree. */
const EMPTY_ROOT = sha256(Buffer.alloc(0));

function leafHash(data) {
  return sha256(LEAF_PREFIX, data);
}

function nodeHash(left, right) {
  return sha256(NODE_PREFIX, left, right);
}

function isOdd(n) {
  return n % 2 === 1;
}

function half(n) {
  return Math.floor(n / 2);
}

/** Largest power of two strictly less than n (n >= 2). */
function splitPoint(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function requireSize(n, name) {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative safe integer, got ${n}`);
  }
}

/**
 * MTH over leaf hashes[start:end].
 * @param {Buffer[]} hashes - leaf hashes (already leafHash()ed)
 */
function rootFromLeafHashes(hashes, start = 0, end = hashes.length) {
  const n = end - start;
  if (n === 0) return EMPTY_ROOT;
  if (n === 1) return hashes[start];
  const k = splitPoint(n);
  return nodeHash(rootFromLeafHashes(hashes, start, start + k), rootFromLeafHashes(hashes, start + k, end));
}

/**
 * RFC 9162 2.1.3.1 PATH(m, D[n]), leaf-to-root order.
 * @param {number} m - leaf index, 0 <= m < n
 * @param {Buffer[]} hashes - all n leaf hashes of the tree
 */
function inclusionPath(m, hashes, start = 0, end = hashes.length) {
  const n = end - start;
  if (!(m >= 0 && m < n)) {
    throw new Error(`leaf index ${m} out of range for tree size ${n}`);
  }
  if (n === 1) return [];
  const k = splitPoint(n);
  if (m < k) {
    return [...inclusionPath(m, hashes, start, start + k), rootFromLeafHashes(hashes, start + k, end)];
  }
  return [...inclusionPath(m - k, hashes, start + k, end), rootFromLeafHashes(hashes, start, start + k)];
}

/**
 * RFC 9162 2.1.3.2: verify an inclusion proof. Pure; returns a boolean and
 * never throws on hostile input.
 */
function verifyInclusion(leafIndex, treeSize, leaf, path, root) {
  if (!Number.isSafeInteger(leafIndex) || !Number.isSafeInteger(treeSize)) return false;
  if (leafIndex < 0 || leafIndex >= treeSize) return false;
  if (!Array.isArray(path) || !Buffer.isBuffer(leaf) || !Buffer.isBuffer(root)) return false;
  let fn = leafIndex;
  let sn = treeSize - 1;
  let r = leaf;
  for (const p of path) {
    if (!Buffer.isBuffer(p) || p.length !== 32) return false;
    if (sn === 0) return false;
    if (isOdd(fn) || fn === sn) {
      r = nodeHash(p, r);
      if (!isOdd(fn)) {
        while (!isOdd(fn) && fn !== 0) {
          fn = half(fn);
          sn = half(sn);
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 && r.equals(root);
}

/**
 * RFC 9162 2.1.4.1 SUBPROOF(m, D[n], b).
 */
function subproof(m, hashes, start, end, b) {
  const n = end - start;
  if (m === n) {
    return b ? [] : [rootFromLeafHashes(hashes, start, end)];
  }
  const k = splitPoint(n);
  if (m <= k) {
    return [...subproof(m, hashes, start, start + k, b), rootFromLeafHashes(hashes, start + k, end)];
  }
  return [...subproof(m - k, hashes, start + k, end, false), rootFromLeafHashes(hashes, start, start + k)];
}

/**
 * RFC 9162 2.1.4.1 PROOF(m, D[n]): consistency proof that the tree of the
 * first m leaves is a prefix of the tree of all n leaves. Empty when m is 0
 * or m equals n.
 */
function consistencyProof(m, hashes) {
  const n = hashes.length;
  requireSize(m, 'old tree size');
  if (m > n) throw new Error(`old tree size ${m} exceeds new tree size ${n}`);
  if (m === 0 || m === n) return [];
  return subproof(m, hashes, 0, n, true);
}

/**
 * RFC 9162 2.1.4.2: verify a consistency proof. Pure; returns a boolean.
 */
function verifyConsistency(first, second, firstHash, secondHash, proof) {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second)) return false;
  if (first < 0 || first > second) return false;
  if (!Array.isArray(proof) || !Buffer.isBuffer(firstHash) || !Buffer.isBuffer(secondHash)) return false;
  for (const p of proof) {
    if (!Buffer.isBuffer(p) || p.length !== 32) return false;
  }
  if (first === second) return proof.length === 0 && firstHash.equals(secondHash);
  if (first === 0) return proof.length === 0;
  if (proof.length === 0) return false;

  const path = isPowerOfTwo(first) ? [firstHash, ...proof] : proof.slice();
  let fn = first - 1;
  let sn = second - 1;
  while (isOdd(fn)) {
    fn = half(fn);
    sn = half(sn);
  }
  let fr = path[0];
  let sr = path[0];
  for (let i = 1; i < path.length; i++) {
    const c = path[i];
    if (sn === 0) return false;
    if (isOdd(fn) || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if (!isOdd(fn)) {
        while (!isOdd(fn) && fn !== 0) {
          fn = half(fn);
          sn = half(sn);
        }
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 && fr.equals(firstHash) && sr.equals(secondHash);
}

function isPowerOfTwo(n) {
  if (n < 1) return false;
  let x = n;
  while (x > 1) {
    if (isOdd(x)) return false;
    x = half(x);
  }
  return true;
}

/**
 * Compact range ("frontier") of a tree: the roots of the perfect subtrees
 * that make up its first `size` leaves, one per set bit of size, left to
 * right. It is enough to extend the tree leaf by leaf and to compute the
 * root, without the leaves themselves. Folding it right to left gives
 * exactly MTH for every size, because MTH's split point is always the
 * largest perfect subtree on the left.
 */
function frontierAppend(frontier, size, leaf) {
  const f = frontier.slice();
  let carry = leaf;
  let s = size;
  while (isOdd(s)) {
    carry = nodeHash(f.pop(), carry);
    s = half(s);
  }
  f.push(carry);
  return f;
}

function frontierRoot(frontier) {
  if (frontier.length === 0) return EMPTY_ROOT;
  let r = frontier[frontier.length - 1];
  for (let i = frontier.length - 2; i >= 0; i--) {
    r = nodeHash(frontier[i], r);
  }
  return r;
}

/** Number of set bits: the frontier length a tree of `size` must have. */
function popcount(size) {
  let c = 0;
  let s = size;
  while (s > 0) {
    if (isOdd(s)) c++;
    s = half(s);
  }
  return c;
}

export {
  EMPTY_ROOT,
  leafHash,
  nodeHash,
  rootFromLeafHashes,
  inclusionPath,
  verifyInclusion,
  consistencyProof,
  verifyConsistency,
  frontierAppend,
  frontierRoot,
  popcount
};
