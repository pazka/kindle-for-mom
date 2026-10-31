# ADR-0008: "Trouver un livre" uses the livres.hosh.it catalogue, through Rust

Date: 2026-10-31 · Status: accepted

## Context
Mom should find new books from the app itself, without a store account and
without anything illegal (ADR-0005). Pazka's server livres.hosh.it gathers
public-domain and official free French catalogues behind one OPDS 2.0 feed,
and takes "please find me this book" requests. Its contract (JSON examples)
lives in the server repository under `contract/`; a copy is in
`app/core/testdata/livres/` and the parser is tested against it.

## Decision
- A "🔎 Trouver un livre" button opens a window: search, author ideas from
  the catalogue's first page, results page by page, "Ajouter à mes livres",
  and "Demander ce livre à Alexandre" (title, author, a short note).
- All HTTP is done by the Rust shell (`src-tauri/src/catalog.rs`); the page
  keeps its strict CSP and never loads anything from the internet (no
  external covers: each book gets its coloured spine).
- `core/src/catalog.rs` checks everything the server says:
  - pages are only requested from `https://livres.hosh.it/opds/…`, and
    `next`/`previous` links elsewhere are dropped;
  - books are only downloaded over HTTPS from the hosts listed by
    `/api/v1/download-hosts` (exact host, no user name, no port), also after
    redirects; EPUB is preferred, then MOBI, then PDF;
  - a download bigger than 300 MB, or whose first bytes are not a real
    EPUB/MOBI/PDF, is thrown away;
  - every message is French: the server's own `error` sentence, or one
    chosen from the HTTP status; no internet says so plainly.
- A downloaded book goes through the same path as a dropped file
  (`Library::add_path`), named "Titre - Auteur", so EPUBs are converted for
  the Kindle like any other book.
- HTTP uses `reqwest` and `rustls` (ring), pinned to the exact versions and
  features already shipped by `tauri-plugin-updater`: no new crate in the
  build.

## Consequences
- Without the server (offline, down, not deployed yet) the window shows a
  French sentence; the rest of the app is not affected.
- The install token the server can require (`401`) is not sent yet; if the
  server turns it on, the app needs a release that sends it.
