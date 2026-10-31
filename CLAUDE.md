# Working on Ma liseuse

The user of this app is the owner's mother: French, not technical, using an
old Kindle 4 over USB. Every change must keep her workflow safe.

Read before changing anything: `docs/STANDARDS.md` (non-negotiable rules),
`docs/ARCHITECTURE.md` (layers), `docs/adr/`.

Rules of thumb:
- All user-facing text is French, plain, no jargon, no drive letters, no format names unless explaining.
- File logic lives in `app/core` (Rust, std-only + serde) with tests in `core/src/tests.rs`.
  `app/src-tauri` stays a thin shell. The UI talks to Rust only through `app/ui/js/api.js`.
- A new command must be added in four places, or `ui/test/contract.test.js` fails:
  `#[tauri::command]` + `generate_handler!` in main.rs, `api.js`, `ui/test/fake-backend.js`.
- A new user-visible behaviour gets an end-to-end journey in `app/e2e/journeys.test.mjs`.
- Before pushing: `cargo fmt --all`, `cargo clippy -p liseuse-core --all-targets -- -D warnings`,
  `cargo test -p liseuse-core`, `npm test`, `npm run e2e`.
- No new third-party dependency without the owner's yes; pin exact versions; `npm ci --ignore-scripts`.
- Never put a secret in this repo (it is public). Signing keys live in GitHub secrets.
