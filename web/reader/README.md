# PAP reader: scan, verify, open

A single static page, `index.html`, that checks a Lotor PAP bundle with no server
and no network. Scan the QR with a camera, load a `.bin` or a photo of the QR, or
paste the bundle as hex or base64. It shows whether the signature verifies, the
key fingerprint the bundle carries, the chain head, the seq, the time the signer
claims, the size against the 2,953 B QR cap, and whether the bundle is sealed and to
how many recipients. A sealed bundle verifies before any key is given; a recipient
key, the passphrase, or a revealed content key opens it.

What "verified" means here: the bundle is unaltered and its signature matches the
fingerprint the bundle itself carries (trust: `self-consistent`). The page has no key
of its own to check against, so it cannot say who signed it; compare the printed
fingerprint with one you already trust. A bundle larger than the 2,953 B QR cap is
refused before any decoding, and a decoded spine over 4 MiB is refused (the
vendored brotli decoder has no output limit of its own, KNOWN-LIMITS 83).

It also reads sealed (v2) bundles, specified in `docs/PAP-SEALED.md`. The node side
of sealed mode is queued for a signing sitting; this page can read v2 now, and the
shared vectors in `test-data/pap-vectors/` (made by that queued code) are how both
sides are checked against each other.

## Files

| File | What |
|---|---|
| `index.html` | the page. Generated. Open it, save it, run it offline. |
| `pap-reader.js` | the verify path: parse, Ed25519, X25519, HKDF, AES-GCM, PBKDF2, all through WebCrypto. No DOM. |
| `view.js`, `scan.js` | inputs and rendering. They show only what `pap-reader.js` returns. A cartridge-style view can replace them. |
| `index.src.html` | the page template |
| `build.mjs` | inlines everything into `index.html`; `--check` fails if it is stale |
| `vendor/` | pinned third-party code, hashes in `build.mjs` |

## Pinned vendor code

| File | Version | From | License |
|---|---|---|---|
| `jsQR.js` | jsqr 1.4.0 | npm `jsqr@1.4.0`, `dist/jsQR.js` | Apache-2.0 |
| `brotli-decode.js` | google/brotli v1.1.0 | GitHub tag `v1.1.0`, `js/decode.js` | MIT |
| `noble-ed25519.js` | @noble/ed25519 2.3.0 | npm `@noble/ed25519@2.3.0`, `index.js` | MIT |

noble is used only where a browser has no Ed25519 in WebCrypto. There is no X25519
fallback: a browser without WebCrypto X25519 can verify a sealed bundle but not open
it, and says so (use `pap-boot`).

## No network, enforced

The page's Content-Security-Policy sets `default-src 'none'` and `connect-src 'none'`,
so the browser itself refuses any fetch, XHR, WebSocket or beacon from the page.
Everything is inline. Checked in `test/pap-reader.test.js`, and by hand in a browser:
a same-origin fetch, a remote fetch and a beacon all failed to reach the server.

## Rebuild

```bash
node web/reader/build.mjs
```

## Publishing

This page lives in the repo only. Putting it on ikeanalytics.com is a public-surface
change and is Isaac's call.
