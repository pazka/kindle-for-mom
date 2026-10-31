# Ma liseuse

A Windows app that lets Mom keep her ebooks on her PC and on her Kindle 4
(model D01100, USB only), see how full the Kindle is, and move books in and
out before a trip. EPUBs are converted automatically to MOBI. The app is in
French and is its own guide.

| Part | Where | State |
|---|---|---|
| Windows app (Tauri 2) | [`app/`](app/) | v0.1 offline core |
| Server `livres.hosh.it` (updates, admin, OPDS catalogue) | `server/` | planned (v0.2, v0.3) |

Start here:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pieces fit
- [docs/STANDARDS.md](docs/STANDARDS.md): the rules every change follows (tests, releases, data safety)
- [docs/adr/](docs/adr/): decisions and why
- [CHANGELOG.md](app/CHANGELOG.md)

## Develop

```sh
cd app
npm ci --ignore-scripts
npm test                 # converter + UI unit and contract tests
npm run e2e              # Mom's journeys in Chromium (fake backend)
npm run screenshots      # renders the main screens to e2e/screenshots/
cargo test -p liseuse-core
npx tauri dev            # Windows only: runs the real app
```

On Linux/macOS, `LISEUSE_FAKE_KINDLE=/some/folder` (with `documents/` and
`system/` inside) makes the core treat that folder as a plugged-in Kindle.
