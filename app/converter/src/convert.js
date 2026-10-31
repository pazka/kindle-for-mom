/**
 * EPUB → MOBI, end to end. Pure function of the input bytes; images are
 * handed to `processImage` (the page passes a canvas-based one that turns
 * every picture into a Kindle-friendly JPEG; Node keeps JPEG/GIF/PNG as-is).
 */

import { BookError, readEpub } from "./epub.js";
import { Builder, stylesheetsOf, writeChapter } from "./html.js";
import { escapeAttr, escapeText, tokenize, textOf } from "./markup.js";
import { readMobi, writeMobi } from "./mobi.js";

export { BookError };

/** Sniff the real image type (manifest media-types are often wrong). */
export function sniffImage(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  const head = new TextDecoder().decode(b.subarray(0, 512));
  if (/<svg[\s>]/i.test(head)) return "image/svg+xml";
  return "";
}

/** Default (no canvas): keep what MOBI readers display, drop the rest. */
export async function passthroughImages(bytes, mime) {
  return /^image\/(jpeg|gif|png|bmp)$/.test(mime) ? { bytes, mime } : null;
}

const LABELS = {
  fr: { toc: "Table des matières", start: "Début", cover: "Couverture" },
  de: { toc: "Inhaltsverzeichnis", start: "Anfang", cover: "Titelbild" },
  es: { toc: "Índice", start: "Inicio", cover: "Portada" },
  it: { toc: "Indice", start: "Inizio", cover: "Copertina" },
  en: { toc: "Table of Contents", start: "Beginning", cover: "Cover" },
};

/**
 * @param {Uint8Array} bytes the .epub file
 * @param {{ processImage?: Function, onProgress?: (done:number, total:number) => void, now?: number, uid?: number }} [opts]
 * @returns {Promise<{ mobi: Uint8Array, meta: object, warnings: string[], stats: object }>}
 */
export async function convertEpub(bytes, opts = {}) {
  const processImage = opts.processImage || passthroughImages;
  const book = await readEpub(bytes);
  const { zip, meta, spine } = book;
  const warnings = [];
  const lang = meta.language.split(/[-_]/)[0];
  const L = LABELS[lang] || LABELS.en;

  // chapter sources + their stylesheets
  const sources = [];
  for (const item of spine) {
    // a picture straight in the reading order (comics, picture books): wrap it in a page
    if (item.isImage) sources.push(`<html><body><div align="center"><img src="${escapeAttr(item.path.split("/").pop())}"/></div></body></html>`);
    else sources.push(await zip.text(item.path));
  }
  const cssCache = new Map();
  for (let k = 0; k < spine.length; k++) {
    for (const p of stylesheetsOf(sources[k], spine[k].path)) {
      if (!cssCache.has(p)) cssCache.set(p, zip.has(p) ? await zip.text(p) : "");
    }
  }

  // images, in order of first use (recindex is 1-based)
  const images = [];
  const imageIndex = new Map();
  let droppedImages = 0;
  const image = async (path) => {
    if (imageIndex.has(path)) return imageIndex.get(path);
    let idx = null;
    if (zip.has(path)) {
      try {
        const raw = await zip.read(path);
        const res = await processImage(raw, sniffImage(raw), path);
        if (res && res.bytes?.length) {
          images.push(res.bytes);
          idx = images.length;
        }
      } catch {
        idx = null;
      }
    }
    if (!idx) droppedImages++;
    imageIndex.set(path, idx);
    return idx;
  };

  const out = new Builder();
  out.text("<html><head><guide>");
  const hasToc = book.toc.length > 0;
  if (hasToc) {
    out.text(`<reference type="toc" title="${escapeAttr(L.toc)}" `);
    out.filepos("#toc");
    out.text("/>");
  }
  out.text(`<reference type="text" title="${escapeAttr(L.start)}" `);
  out.filepos(book.start || spine.find((s) => s.linear)?.path || spine[0].path);
  out.text("/></guide></head><body>");

  // cover: first image record + its own page, unless the first chapter already shows it
  let coverIndex = null;
  if (book.cover && zip.has(book.cover.path)) {
    const idx = await image(book.cover.path);
    if (idx) {
      coverIndex = idx - 1;
      const name = book.cover.path.split("/").pop();
      if (!sources[0].includes(name)) {
        out.text(`<div align="center"><img recindex="${String(idx).padStart(5, "0")}"/></div><mbp:pagebreak/>`);
      }
    }
  }

  // table of contents page (Kindle: Menu → Go to → Table of Contents)
  if (hasToc) {
    out.anchor("#toc");
    out.text(`<h2 align="center">${escapeText(L.toc)}</h2>`);
    for (const e of book.toc) {
      const indent = "<blockquote>".repeat(Math.min(e.depth, 3));
      out.text(`<div>${indent}`);
      out.link(e.href);
      out.text(`${escapeText(e.title)}</a>${"</blockquote>".repeat(Math.min(e.depth, 3))}</div>`);
    }
    out.text("<mbp:pagebreak/>");
  }

  for (let k = 0; k < spine.length; k++) {
    await writeChapter(sources[k], spine[k].path, out, {
      css: (p) => cssCache.get(p) || "",
      image,
      firstChapter: k === 0,
    });
    opts.onProgress?.(k + 1, spine.length);
  }
  out.text("</body></html>");

  const { bytes: text, broken } = out.finish();
  if (broken) warnings.push(`${broken} internal link(s) point nowhere and were disabled`);
  if (droppedImages) warnings.push(`${droppedImages} image(s) could not be converted and were left out`);

  const mobi = writeMobi({ text, images, meta, coverIndex, now: opts.now, uid: opts.uid });
  // self-check: the file must read back to exactly the text we wrote
  const back = readMobi(mobi);
  if (back.text.length !== text.length || back.images.length !== images.length) {
    throw new BookError("internal", "self-check failed");
  }
  for (let i = 0; i < text.length; i++) if (back.text[i] !== text[i]) throw new BookError("internal", "self-check failed");

  return {
    mobi,
    meta,
    warnings,
    stats: { chapters: spine.length, images: images.length, textBytes: text.length, tocEntries: book.toc.length, cover: coverIndex !== null },
  };
}

/** "Title - Author.mobi", safe on Windows/FAT32 (the Kindle's file system). */
export function mobiFileName(meta) {
  const author = meta.creators?.[0] ? ` - ${meta.creators[0]}` : "";
  let s = `${meta.title || "Livre"}${author}`
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s += "_";
  return `${s || "Livre"}.mobi`;
}

export { textOf, tokenize };
