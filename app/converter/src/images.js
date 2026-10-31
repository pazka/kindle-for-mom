/**
 * Browser image pipeline: every picture becomes a JPEG an old Kindle can
 * show (grey e-ink, 600×800 to 1072×1448 screens), sized per target profile. Small JPEG/GIF files are
 * kept untouched; everything else (PNG with transparency, WebP, SVG, huge
 * photos) is redrawn on a white canvas, scaled down and recompressed until
 * it fits the 127 KiB that MOBI 6 readers accept per image.
 */

/** Limits per target. MOBI 6 readers refuse images over 127 KiB. */
export const PROFILES = {
  /** Any old Kindle (up to the 1072×1448 Paperwhite screens). */
  generic: { maxW: 1072, maxH: 1448, maxBytes: 127 * 1024, grey: false },
  /**
   * Kindle 4 (D01100): 600×800 screen, 16 greys. Pictures bigger than the
   * screen or in colour only waste her ~1.2 GB: about 3 to 5 times smaller
   * books with pictures, no visible difference on the device.
   */
  kindle4: { maxW: 600, maxH: 800, maxBytes: 60 * 1024, grey: true },
};

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image decode failed"));
    };
    img.src = url;
  });
}

const toBlob = (canvas, quality) =>
  new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", quality));

/** Build a processImage(bytes, mime) for convertEpub: → {bytes, mime} | null */
export function makeKindleImage({ maxW, maxH, maxBytes, grey }) {
  return (bytes, mime) => reencode(bytes, mime, maxW, maxH, maxBytes, grey);
}

/** Generic profile (kept for compatibility). */
export const kindleImage = makeKindleImage(PROFILES.generic);
/** Kindle 4 profile: what the Ma liseuse app uses. */
export const kindle4Image = makeKindleImage(PROFILES.kindle4);

async function reencode(bytes, mime, MAX_W, MAX_H, MAX_BYTES, grey) {
  if (!mime) return null;
  const { img, url } = await loadImage(new Blob([bytes], { type: mime }));
  try {
    let w = img.naturalWidth || img.width || 600;
    let h = img.naturalHeight || img.height || 800;
    if ((!grey || bytes.length <= MAX_BYTES / 2) && (mime === "image/jpeg" || mime === "image/gif") && bytes.length <= MAX_BYTES && w <= MAX_W && h <= MAX_H) {
      return { bytes, mime };
    }
    const scale = Math.min(1, MAX_W / w, MAX_H / h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext("2d");
      g.fillStyle = "#fff"; // transparency would turn black on the Kindle
      g.fillRect(0, 0, w, h);
      g.drawImage(img, 0, 0, w, h);
      if (grey) {
        // e-ink shows greys only; grey pixels compress far better as JPEG
        const px = g.getImageData(0, 0, w, h);
        const d = px.data;
        for (let i = 0; i < d.length; i += 4) {
          const y = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
          d[i] = d[i + 1] = d[i + 2] = y;
        }
        g.putImageData(px, 0, 0);
      }
      for (const q of [0.85, 0.72, 0.6]) {
        const blob = await toBlob(canvas, q);
        if (blob && blob.size <= MAX_BYTES) return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/jpeg" };
      }
      w = Math.max(1, Math.round(w * 0.75));
      h = Math.max(1, Math.round(h * 0.75));
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
