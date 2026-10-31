/**
 * Browser image pipeline: every picture becomes a JPEG an old Kindle can
 * show (grey e-ink, 600×800 to 1072×1448 screens). Small JPEG/GIF files are
 * kept untouched; everything else (PNG with transparency, WebP, SVG, huge
 * photos) is redrawn on a white canvas, scaled down and recompressed until
 * it fits the 127 KiB that MOBI 6 readers accept per image.
 */

const MAX_BYTES = 127 * 1024;
const MAX_W = 1072;
const MAX_H = 1448;

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

/** processImage(bytes, mime) for convertEpub: → {bytes, mime} | null */
export async function kindleImage(bytes, mime) {
  if (!mime) return null;
  const { img, url } = await loadImage(new Blob([bytes], { type: mime }));
  try {
    let w = img.naturalWidth || img.width || 600;
    let h = img.naturalHeight || img.height || 800;
    if ((mime === "image/jpeg" || mime === "image/gif") && bytes.length <= MAX_BYTES && w <= MAX_W && h <= MAX_H) {
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
