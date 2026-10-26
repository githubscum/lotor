# Sealed PAP bundles (manifest v2)

Status: **queued for a signing sitting.** The code is `proposals/pap-sealed.patch`
(src/publish and bin/ are core). Until it lands, this file is the spec the patch and
the offline reader implement, and `test/pap-sealed-patch.test.js` proves the patch
on a temp copy inside every `npm test`.

## What it claims

Share a workflow sealed and signed in one QR. Anyone can check that it is untouched
and was signed by the key whose fingerprint it carries, without a key of their own.
Only the recipients the author chose can read the spine.

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
| Passphrase | `KEK = PBKDF2-HMAC-SHA256(passphrase, salt16, iterations)`, default 600,000; stanza as above |
| Inner binding | Ed25519 by the chain key over `"lotor/pap/v2/inner" 0x00 SHA-256(header) SHA-256(spine) SHA-256(memoirUrl)`, inside the ciphertext |
| Outer signature | Ed25519 by the chain key over the whole manifest, appended |

The zero nonce is safe because each key it is used with is used once: the body key
comes from a fresh CEK, each X25519 KEK from a fresh ephemeral key, each passphrase
KEK from a fresh salt. The same reasoning and shape as age's file-key wrapping.

**Why a key commitment.** AES-GCM is not key-committing. Without the commitment an
author could wrap a different CEK to each recipient and show each one a different
plaintext under one valid signature. For a prediction signed before the outcome,
that is the whole fraud. Every reader checks the CEK it unwrapped against the one
public commitment, so everyone who opens a bundle reads the same bytes.

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
signature        64B  Ed25519 over the manifest

inner = innerSig 64B, memoirUrlLen u16, memoirUrl, brotli(spine)
```

v1 bundles (`version 0x01`) are unchanged byte for byte. A v1 reader rejects v2 on the
version byte; it never misreads it.

## Reader order

1. Split off the last 64 bytes; verify the outer signature against the manifest's own
   key (or a key the reader already trusts). Fail: tampered or other signer, stop.
2. Report: verified, signer fingerprint, chain head, seq, time, "sealed to N".
3. With a key: unwrap the CEK from a stanza (try each X25519 stanza; the passphrase
   stanza). None opens: not a recipient.
4. Check the CEK against keyCommit. Mismatch: stop.
5. Decrypt the body with the header as associated data.
6. Decompress the spine; verify the inner signature with the same key as step 1.
   Mismatch: stop, it is a swap.

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
The QR cap stays 2,953 B and `pack()` refuses over it, naming what sealing cost.
