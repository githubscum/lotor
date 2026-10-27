# Sealed PAP bundles (manifest v2)

Status: **queued for a signing sitting.** The code is `proposals/pap-sealed.patch`
(src/publish and bin/ are core). Until it lands, this file is the spec the patch and
the offline reader implement, and `test/pap-sealed-patch.test.js` proves the patch
on a temp copy inside every `npm test`.

## What it claims

Share a workflow sealed and signed in one QR. Anyone can verify it without a key:
that proves the bundle is **unaltered and self-consistent with the key fingerprint
it carries**. The fingerprint is inside the bundle, so verification alone cannot say
who holds that key. It proves authorship only when you **compare the fingerprint to
one you already trust** (the author's published fingerprint, a key you were handed in
person), or pass that key in yourself. Only the recipients the author chose can read
the spine.

The tools say which of these just happened. `inspect()` and `unpack()` report a
`trust` field, and `pap-boot` prints it:

| `trust` | The verify key came from | What a pass means |
|---|---|---|
| `self-consistent` | the bundle's own embedded fingerprint | unaltered, and consistent with the fingerprint it carries. Anyone can make a bundle that passes this under a fingerprint of their own. |
| `verified-against-supplied-key` | the caller (`verifyKey`, `--verify-key`) | the same, and that fingerprint is the key you supplied |

A supplied key must equal the embedded fingerprint (raw 32-byte equality). If it does
not, the call fails with `PAP_SIGNER_MISMATCH` before any signature is checked
(`pap-boot` exits 4). This applies to v1 and v2.

What it does not claim: that the spine is correct (KNOWN-LIMITS 46), that the
signer's chain key was safe when it signed (KNOWN-LIMITS 8, 48), or that a QR is
private. The ciphertext, the recipient count, the signer, the chain head, the seq
and the timestamp are public (KNOWN-LIMITS 45).

## Construction

Encrypt, then sign. Published primitives only, all in both `node:crypto` and WebCrypto:

| Piece | Primitive |
|---|---|
| Content key (CEK) | 32 random bytes, fresh per bundle |
| Key commitment | `SHA-256("lotor/pap/v2/key-commit" 0x00 CEK)`, public |
| Body | AES-256-GCM, key `HKDF-SHA256(CEK, salt empty, info "lotor/pap/v2/body")`, 12-byte zero nonce, header as associated data |
| X25519 recipient | one ephemeral X25519 key per bundle; `KEK = HKDF-SHA256(X25519(eph, R), salt eph_pub R_pub, info "lotor/pap/v2/x25519-wrap")`; stanza `AES-256-GCM(KEK, zero nonce, CEK)`, 48 B |
| Passphrase | `KEK = PBKDF2-HMAC-SHA256(passphrase, salt16, iterations)`, default 600,000, **floor 100,000 at seal time** (`PAP_KDF_TOO_WEAK` below it); stanza as above |
| Inner binding | Ed25519 by the chain key over `"lotor/pap/v2/inner" 0x00 SHA-256(header) SHA-256(spine) SHA-256(memoirUrl)`, inside the ciphertext |
| Outer signature | Ed25519 by the chain key over `"lotor/pap/v2/outer" 0x00` followed by the whole manifest, appended. v1 signs the bare manifest, unchanged. |

The zero nonce is safe because each key it is used with is used once: the body key
comes from a fresh CEK, each X25519 KEK from a fresh ephemeral key, each passphrase
KEK from a fresh salt. The same reasoning and shape as age's file-key wrapping.

**The zero nonce is not reachable from outside.** That reasoning holds only if no
caller can choose the key, so nothing in `seal.js` or `pack.js` is exported that
encrypts under a caller-supplied key. The only way in is a single-use sealer
(`createSealer()`): it makes the CEK, the ephemeral key and every KEK inside its own
closure, returns the public stanzas, and its `encryptBody()` throws on a second call
(`PAP_SEALER_REUSED`). A test pins the exact export surface. Tests that need to build
hostile bundles by hand use `test-data/pap-vectors/seal-primitives.mjs`, a test-only
reimplementation that shares no code with `seal.js`.

**Why an outer domain string.** The v2 outer signature covers `"lotor/pap/v2/outer"
0x00` plus the manifest, so a v2 signature cannot be valid as anything else, and
cannot be confused with a v1 signature over the same bytes. It is safe without it
today because of the version byte. It costs nothing now and cannot be added after
the format is frozen.

**Why a key commitment.** AES-GCM is not key-committing: a ciphertext can be made to
authenticate under two different keys, so in principle an author could wrap a
different CEK to each recipient and show each one a different plaintext under one
signature. Against random 256-bit keys that is expensive for the author, so this is
defence in depth, not the only thing standing between a reader and fraud. The
commitment also earns its place on the reveal path: a content key published later is
checked against the one public commitment by anyone. Every reader checks the CEK it
unwrapped against that commitment, so everyone who opens a bundle reads the same
bytes.

**Passphrase mode, honestly.** The stanza carries a salt and an iteration count, both
public, so anyone who scans the QR can try passphrases offline as fast as they can
afford. PBKDF2 is not memory-hard; it is what WebCrypto offers, which is why the
offline reader can open these bundles at all. Expect to need a passphrase with real
entropy (a long random one, not a word you chose), or seal to a key (KNOWN-LIMITS 45).
The 100,000 floor stops a writer picking a count that makes a stolen QR cheap; it does
not make a weak passphrase safe.

**Recipient membership is testable by whoever holds the secret.** A stanza carries no
recipient identifier and either authenticates under a candidate secret or it does not.
So anyone holding a candidate passphrase, or a candidate recipient private key (a
leaked or seized one, say), can check offline, against any scanned bundle, whether it
opens, with no cooperation from the author. A candidate public key alone is not enough
for that test: unwrapping needs the secret half (KNOWN-LIMITS 45). What the bundle
does show everyone is how many X25519 stanzas it has and whether a passphrase stanza
exists.

**Why an inner signature.** The outer signature proves who signed the ciphertext. The
inner one proves the same key signed this plaintext, under this header: these
recipients, this chain head, this seq and time. Anyone who holds a content key can
re-encrypt the plaintext. If they re-address it, or move it under another chain head,
or re-sign the outer as themselves while keeping the inner bytes, the inner check
fails. It cannot stop a recipient who strips the inner signature and signs the
plaintext as themselves; that bundle then truthfully names them as signer
(KNOWN-LIMITS 84).

**What it cannot prove about time.** The timestamp and chain head are the signer's
claim. The head proves "signed no earlier than this chain entry", never "signed before
the outcome"; that needs an outside witness, and publishing every bundle before the
outcome is the only thing that stops an author sealing several predictions and
revealing the winner (KNOWN-LIMITS 85).

**Reveal.** Opening returns the CEK. Publishing it later lets anyone open the bundle,
and the public commitment proves it is the right key: commit now, reveal after.

## Layout (all integers big-endian)

```
version          u8   0x02
chainHeadHash    32B
chainPubkeyFp    32B  raw Ed25519 public key
seq              u32
timestamp        u64  epoch ms
keyCommit        32B
x25519Count      u8
passphraseCount  u8   0 or 1
ephemeralPub     32B  only if x25519Count > 0
x25519 stanzas   x25519Count * 48B
passphrase stanza only if passphraseCount = 1: salt 16B, iterations u32, wrapped 48B
---- the header ends here; it is the AEAD associated data ----
ciphertextLen    u16
ciphertext       AES-256-GCM(inner) with 16B tag
---- the manifest ends here ----
signature        64B  Ed25519 over "lotor/pap/v2/outer" 0x00 || manifest
                      (the domain string is signed, not transmitted)

inner = innerSig 64B, memoirUrlLen u16, memoirUrl, brotli(spine)
```

v1 bundles (`version 0x01`) are unchanged byte for byte, and their signature still
covers the bare manifest. A v1 reader rejects v2 on the version byte; it never
misreads it. (The v1 decoder, `decodeManifest`, rejects any version other than 1; the
tests in `test/pap-pack.test.js` and the shared vectors exercise v1 only.)

## Reader order

1. Split off the last 64 bytes. Choose the verify key: the manifest's own embedded
   fingerprint (trust: `self-consistent`), or a key the reader supplies, which must
   equal that fingerprint (else `PAP_SIGNER_MISMATCH`, before any signature work;
   trust: `verified-against-supplied-key`). Verify the outer signature over
   `"lotor/pap/v2/outer" 0x00 || manifest`. Fail: altered, or not signed by the key it
   carries. Stop.
2. Report: verified, the trust basis, signer fingerprint (compare it with one you
   trust), chain head, seq, time, "sealed to N". Do not call this authorship.
3. With a key: unwrap the CEK from a stanza (try each X25519 stanza; the passphrase
   stanza). None opens: not a recipient. A malformed key is `PAP_BAD_KEY`, not
   "not a recipient". A revealed content key that is not 32 bytes / 64 hex chars is
   `PAP_BAD_CONTENT_KEY`.
4. Check the CEK against keyCommit. Mismatch: stop.
5. Decrypt the body with the header as associated data.
6. Decompress the spine with an output cap of 4 MiB (`PAP_SPINE_TOO_LARGE` over it,
   `PAP_DECOMPRESS_FAILED` on malformed brotli; v1 uses the same cap); verify the inner
   signature with the same key as step 1. Mismatch: stop, it is a swap.

## Budget (measured, pinned in test/pap-sealed.test.js)

Against the same spine as a plaintext v1 bundle:

| Sealed to | Overhead |
|---|---|
| 1 recipient key | 194 B |
| each extra key | +48 B |
| passphrase only | 182 B |
| 1 key + passphrase | 262 B |

The 194 B is ephemeral key 32, stanza 48, key commitment 32, inner signature 64, GCM
tag 16, counts 2: 194 B. That is more than the work order's estimate of 60 to 80 B,
which did not count the inner signature, the ephemeral key or the commitment.

One operand is swapped, not added: v2's `u16` `ciphertextLen` takes the place of v1's
`u16` spine-length tag (`SPINE_LEN_TAG_BYTES`), and the memoir URL moves inside the
ciphertext with its own `u16` length, so the line items above are the whole difference
and they sum to 194. Passphrase only is 182: commitment 32, inner signature 64, GCM
tag 16, counts 2, and the passphrase stanza (salt 16, iterations 4, wrapped 48 = 68).
One key plus a passphrase is 194 + 68 = 262.
The QR cap stays 2,953 B and `pack()` refuses over it, naming what sealing cost.
