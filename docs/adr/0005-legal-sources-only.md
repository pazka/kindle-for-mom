# ADR-0005: The book catalogue uses legal sources only

Date: 2026-10-31 · Status: accepted

## Context
v0.3 adds a "Trouver un livre" catalogue fed by livres.hosh.it. Her Kindle can no longer buy from Amazon.

## Decision
The server aggregates only public-domain and free official catalogues (Project Gutenberg, Wikisource FR, Bibebook, Ebooks libres et gratuits, Feedbooks domaine public, Gallica) and DRM-free stores she buys from, exposed to the app as one OPDS 2.0 feed. No piracy sites.

## Consequences
- No legal exposure for Mom; no malware vector from shady download sites.
- The app speaks only OPDS 2.0, so sources change on the server without app updates.
