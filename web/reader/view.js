/**
 * PAP reader view: inputs (camera, file, paste) and rendering. No crypto.
 *
 * Every status this view shows is a field of the object reader.verify() or
 * reader.open() returned. It never decides "verified" itself, and nothing
 * here animates a result that did not come from that path. A different view
 * (a cartridge, say) can replace this file and keep pap-reader.js as is.
 */

export function mount(doc, reader, deps, scanQr) {
  const $ = (id) => doc.getElementById(id);
  let current = null;
  let stopCamera = null;

  function setText(id, text) { $(id).textContent = text; }

  function showVerification(v) {
    $('result').hidden = false;
    $('status').className = v.ok ? 'status ok' : 'status bad';
    setText('status', v.ok
      ? (v.sealed ? 'Verified. Sealed: the signature matches the fingerprint this bundle carries, checked without reading the contents. Compare that fingerprint with one you trust; this does not say who signed it.'
        : 'Verified. The signature matches the fingerprint this bundle carries. Compare that fingerprint with one you trust; this does not say who signed it.')
      : 'Not verified. ' + v.reason);
    setText('f-signer', v.signerFingerprint || 'n/a');
    setText('f-trust', v.ok ? describeTrust(v.trust) : 'n/a');
    setText('f-head', v.chainHead || 'n/a');
    setText('f-seq', v.seq === undefined ? 'n/a' : String(v.seq));
    setText('f-time', v.timestamp === undefined ? 'n/a' : new Date(v.timestamp).toISOString() + " (the signer's claim)");
    setText('f-size', v.bytes + ' of ' + v.cap + ' bytes');
    setText('f-sealed', v.sealed ? describe(v.recipients) : 'no, anyone who scans it can read it');
    setText('f-via', v.verifiedVia || 'n/a');
    $('open-form').hidden = !(v.ok && v.sealed);
    setText('spine', '');
    $('spine-box').hidden = true;
    setText('open-msg', '');
  }

  function describeTrust(t) {
    return t === 'self-consistent'
      ? 'self-consistent: unaltered, and it matches the fingerprint above, which the bundle supplied itself'
      : String(t || 'n/a');
  }

  function describe(r) {
    const parts = [];
    if (r.x25519 > 0) parts.push(r.x25519 + ' recipient key' + (r.x25519 === 1 ? '' : 's'));
    if (r.passphrase) parts.push('a passphrase');
    return 'yes, to ' + parts.join(' and ');
  }

  function showSpine(res) {
    $('spine-box').hidden = false;
    setText('spine', res.spine);
    setText('memoir', res.memoirUrl ? 'memoir: ' + res.memoirUrl : '');
  }

  async function load(bytes) {
    current = bytes;
    const v = await reader.verify(bytes, deps);
    showVerification(v);
    if (v.ok && !v.sealed) showSpine(await reader.open(bytes, {}, deps));
  }

  function bytesFromText(text) {
    const t = text.trim();
    if (/^([0-9a-f]{2}\s*)+$/i.test(t)) return reader.fromHex(t.replace(/\s+/g, ''));
    const bin = atob(t.replace(/\s+/g, ''));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  function report(err) {
    $('result').hidden = false;
    $('status').className = 'status bad';
    setText('status', 'Could not read that. ' + (err && err.message ? err.message : String(err)));
  }

  $('file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      if (f.type.startsWith('image/')) {
        const bmp = await createImageBitmap(f);
        const bytes = scanQr.fromBitmap(bmp);
        if (!bytes) throw new Error('no QR code found in that image');
        await load(bytes);
      } else {
        await load(new Uint8Array(await f.arrayBuffer()));
      }
    } catch (err) { report(err); }
  });

  $('paste-go').addEventListener('click', async () => {
    try { await load(bytesFromText($('paste').value)); } catch (err) { report(err); }
  });

  $('camera').addEventListener('click', async () => {
    if (stopCamera) { stopCamera(); return; }
    try {
      stopCamera = await scanQr.fromCamera($('video'), async (bytes) => {
        stopCamera();
        await load(bytes);
      }, () => { stopCamera = null; setText('camera', 'Scan with camera'); $('video').hidden = true; });
      setText('camera', 'Stop camera');
      $('video').hidden = false;
    } catch (err) {
      stopCamera = null;
      report(new Error('camera unavailable: ' + (err && err.message ? err.message : err) +
        '. The camera needs the page served over https or from localhost; a file or a pasted bundle works anywhere.'));
    }
  });

  $('open-go').addEventListener('click', async () => {
    if (!current) return;
    const opener = {};
    const key = $('k-recipient').value.trim();
    const pass = $('k-pass').value;
    const ck = $('k-content').value.trim();
    if (key) opener.recipientKey = key;
    if (pass) opener.passphrase = pass;
    if (ck) opener.contentKey = ck;
    try {
      const res = await reader.open(current, opener, deps);
      setText('open-msg', 'Opened. The key matches the commitment and the inner signature binds this text to this bundle.');
      showSpine(res);
    } catch (err) {
      setText('open-msg', (err.code ? err.code + ': ' : '') + err.message);
    }
  });
}
