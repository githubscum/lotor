/**
 * The claims in the sealed-PAP docs, pinned. Reads docs only, so it runs on
 * main as well as on a patched tree. Added with the wringer review amendments
 * (2026-10-26): the authorship claim had been written as stronger than the
 * check can support, and the budget line items left out one operand.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n').replace(/\s+/g, ' ');

describe('sealed PAP docs state what verification can and cannot prove', () => {
  it('PAP-SEALED.md: verification is self-consistency; authorship needs a fingerprint you trust', () => {
    const doc = read('docs/PAP-SEALED.md');
    assert.match(doc, /unaltered and self-consistent with the key fingerprint it carries/);
    assert.match(doc, /compare the fingerprint to one you already trust/);
    assert.match(doc, /`self-consistent`/);
    assert.match(doc, /`verified-against-supplied-key`/);
    assert.match(doc, /PAP_SIGNER_MISMATCH/);
    assert.doesNotMatch(doc, /without a key of their own/);
    assert.doesNotMatch(doc, /was signed by the key whose fingerprint it carries/);
  });

  it('README: the PAP paragraph does not claim authorship from the signature alone', () => {
    const readme = read('README.md');
    assert.match(readme, /self-consistency/);
    assert.match(readme, /compare that fingerprint with one you already trust/);
    assert.doesNotMatch(readme, /was signed by the key whose fingerprint it carries/);
  });

  it('PAP-SEALED.md: the budget section names the swapped u16 operand', () => {
    const doc = read('docs/PAP-SEALED.md');
    assert.match(doc, /`ciphertextLen` takes the place of v1's `u16` spine-length tag/);
    assert.match(doc, /sum to 194/);
  });

  it('PAP-SEALED.md: the layout and reader order carry the outer domain string, the cap and the floor', () => {
    const doc = read('docs/PAP-SEALED.md');
    assert.match(doc, /"lotor\/pap\/v2\/outer" 0x00/);
    assert.match(doc, /output cap of 4 MiB/);
    assert.match(doc, /floor 100,000 at seal time/);
  });

  it('KNOWN-LIMITS 45 carries the passphrase-entropy and membership additions', () => {
    const kl = read('KNOWN-LIMITS.md');
    const start = kl.indexOf('## 45. ');
    const end = kl.indexOf('## 46. ');
    assert.ok(start >= 0 && end > start, 'entry 45 not found');
    const e45 = kl.slice(start, end);
    assert.match(e45, /Seal to keys when it matters\./, 'the existing words are still there');
    assert.match(e45, /not memory-hard/);
    assert.match(e45, /real entropy/);
    assert.match(e45, /recipient-membership oracle/);
    assert.match(e45, /fewer than 100,000 rounds/);
  });
});
