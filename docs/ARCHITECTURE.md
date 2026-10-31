# Architecture

```
                         ┌──────────────────────── Mom's PC (Windows) ─────────────────────────┐
                         │                                                                      │
 livres.hosh.it (v0.2+)  │   Web view (WebView2)                    Rust                        │
 ┌──────────────────┐    │   ┌──────────────────────────┐   IPC   ┌──────────────┐  ┌─────────┐ │
 │ signed updates   │◄───┼───│ app.js  (screen logic)    │ ──────► │ src-tauri    │─►│  core   │ │
 │ admin (you)      │    │   │ js/api.js  (only bridge)  │ ◄────── │ (commands)   │  │ library │ │
 │ OPDS catalogue   │    │   │ js/text.js, converter.js  │  raw    └──────────────┘  │ kindle  │ │
 └──────────────────┘    │   │ js/guide.js               │  bytes                    │ mobi    │ │
                         │   │ converter/ (EPUB→MOBI)    │                           │ formats │ │
                         │   └──────────────────────────┘                            └────┬────┘ │
                         │                                                                │      │
                         │      Documents\Mes livres\  ◄───────────────────────────────────┤      │
                         │      Kindle (USB drive) documents\  ◄───────────────────────────┘      │
                         └──────────────────────────────────────────────────────────────────────┘
```

## Layers

| Layer | Path | Responsibility | Tested by |
|---|---|---|---|
| core | `app/core` | Library folder, Kindle detection and free space, transfers, reading positions, trash, downloads watcher, MOBI metadata, format advice. Rust std + serde only. | `cargo test -p liseuse-core` (Linux + Windows) |
| shell | `app/src-tauri` | Registers commands, maps them to core, validates outside paths, raw binary IPC. No logic. | contract test, Windows build |
| converter | `app/converter` | EPUB 2/3 → MOBI 6 for the Kindle 4, in the web view (offline). | `converter/test` |
| UI | `app/ui` | Desk scene, guide, tips, conversion queue. `api.js` is the only file that calls the backend. | `ui/test`, `e2e/` |

## Why conversion runs in the web view

The converter is plain JavaScript and uses the browser's canvas to re-encode
images into Kindle-friendly JPEGs. Running it in the web view keeps the
installer small and avoids a second runtime. The Rust side never parses
EPUBs, it only stores bytes.

## Kindle detection

Every 2 s the UI asks `kindle_status`: the core scans removable drives for
one labelled `Kindle` (or containing `system\`) with a `documents\` folder.
The full overview (titles read from MOBI headers) is only reloaded when the
drive or its free space changes. See `app/core/src/kindle.rs`.

## Library layout

See the header of `app/core/src/library.rs`. The files are the source of
truth, there is no database to corrupt.

Both the PC and the Kindle use one folder per author ("Nom, Prénom"), the
layout her Kindle was sorted into on 2026-10-31 (ADR-0006). Name rules
(ASCII names for the Kindle, "Prénom Nom" → "Nom, Prénom", the alias table
from that sort, the key that recognises the same book on both sides) are in
`app/core/src/authors.rs`.

## Coming next

- v0.2 (done): signed updates from GitHub Releases, test/stable channels and rollback through the release marked Latest (ADR-0007, `docs/RELEASING.md`). An admin on livres.hosh.it can later replace the endpoint.
- v0.3: OPDS 2.0 catalogue aggregated on the server from legal sources; "Trouver un livre" shelf in the app.
- Windows 10 support pass (same build; test matrix on a Windows 10 VM).
