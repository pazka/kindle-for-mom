# ADR-0004: EPUB conversion in the web view, with the in-house converter

Date: 2026-10-31 · Status: accepted

## Context
The Kindle 4 can't read EPUB. Options: Calibre's `ebook-convert` (GPL, ~200 MB, a second runtime), Amazon KindleGen (discontinued), or the dependency-free JS converter built in this project.

## Decision
Use `app/converter` (EPUB 2/3 → MOBI 6, self-checks its output, refuses DRM with code `drm`), run in the web view in the background, one book at a time.

## Consequences
- Offline, no extra install, images re-encoded to Kindle-friendly JPEG via canvas.
- Validated on the 45 IDPF epub3 samples; next step is a golden-output corpus test with committed hashes.
- If a real-world book fails, the book is marked red with a plain message and the converter gets a regression test from that file.
