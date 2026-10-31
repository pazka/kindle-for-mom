# kindle-converter

EPUB 2/3 → MOBI 6 (`BOOKMOBI`, PalmDOC, UTF-8, EXTH + cover), the format every Kindle reads,
including the D01100 (Kindle 4, 2011) that predates KF8/AZW3. Plain ES modules, **no dependency**;
runs in Node ≥ 22 and in browsers (Electron/Tauri renderer included).

```js
import { convertEpub, mobiFileName, BookError } from "./src/convert.js";
const { mobi, meta, warnings, stats } = await convertEpub(epubBytes /* Uint8Array */, {
  processImage, // optional (bytes, mime, path) => {bytes, mime} | null; default keeps JPEG/GIF/PNG/BMP
  onProgress,   // optional (doneChapters, totalChapters)
});
// errors: BookError with .code "not_epub" | "drm" | "empty" | "internal"
```

| Module | Role |
|---|---|
| `zip.js` | ZIP reader (stored/deflate via `DecompressionStream`) |
| `markup.js` | tolerant XML/HTML tokenizer, entities, path resolution |
| `epub.js` | container/OPF/nav/NCX: metadata, spine, cover, TOC, DRM detection |
| `css.js` | CSS subset → italic/bold/underline/align/hidden/page breaks |
| `html.js` | XHTML → MOBI HTML (`filepos` links, `recindex` images, `<mbp:pagebreak/>`) |
| `mobi.js` | PalmDOC compressor, MOBI 6 writer **and reader** (self-check after each conversion) |
| `images.js` | browser-only: canvas re-encode to JPEG ≤ 127 KiB, ≤ 1072×1448, white background |
| `convert.js` | orchestration + `mobiFileName()` (FAT32-safe) |

Tests: `node --test test/*.test.js` (22 tests). Validated on all 45 IDPF `epub3-samples` books;
outputs open in KindleUnpack. Known limit: no NCX index records (TOC page + links work, the
5-way "next chapter" jump does not).
