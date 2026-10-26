/**
 * QR to bytes, byte mode, through the pinned jsQR. Camera and still images.
 * Returns jsQR's binaryData (the raw bytes), never its text decoding, which
 * would mangle a binary bundle.
 */

export function makeScanner(jsQR, doc) {
  function decode(imageData) {
    const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
    return code && code.binaryData && code.binaryData.length ? Uint8Array.from(code.binaryData) : null;
  }

  function fromBitmap(bmp) {
    const canvas = doc.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    return decode(ctx.getImageData(0, 0, canvas.width, canvas.height));
  }

  async function fromCamera(video, onBytes, onStop) {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } } });
    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    await video.play();
    const canvas = doc.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let running = true;
    const stop = () => {
      if (!running) return;
      running = false;
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      onStop();
    };
    const tick = () => {
      if (!running) return;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const bytes = decode(ctx.getImageData(0, 0, canvas.width, canvas.height));
        if (bytes) { onBytes(bytes); return; }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return stop;
  }

  return { decode, fromBitmap, fromCamera };
}
