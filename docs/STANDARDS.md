# Engineering standards

These rules exist for one reason: **an update must never break Mom's
workflow or lose a book.** They apply to the app, the updater and the
server. A change that doesn't meet them doesn't ship.

## 1. Data-safety invariants

Each invariant has a test that fails if it is broken. Changing one needs an
ADR.

| # | Invariant | Guarded by |
|---|---|---|
| D1 | Her books are plain files in `Documents\Mes livres` (one folder per author); the app's own data is in `.liseuse/` and can be rebuilt. | `core/src/library.rs` layout, ADR-0003, ADR-0006 |
| D2 | A book is never removed from the Kindle unless a verified copy exists on the PC. | `book_only_on_kindle_is_saved_before_removal` |
| D3 | Deleting from the PC goes to a 30-day trash with an undo. | `duplicate_names_get_a_number_and_trash_restores`, e2e "deleting a book can be undone" |
| D4 | Every copy is atomic: temp file, flush to the device, rename. A pulled cable never leaves half a book. | `copy_durable` |
| D5 | Reading positions (Kindle 4 `.mbp`/`.apnx`/… files, or `.sdr` folders) leave and come back with their book. | `epub_lifecycle_put_and_take_back_with_reading_position`, `a_book_goes_back_to_its_exact_place…` |
| D6 | The original EPUB is kept; the MOBI is a disposable copy. | `epub_lifecycle…`, `rename_moves_kindle_copy` |
| D7 | Nothing is copied when it doesn't fit; she gets a sentence explaining what to do. | `refuses_when_kindle_is_full_and_on_drm`, e2e "a full Kindle…" |
| D8 | Notes ("Mes extraits", clippings), dictionaries, screenshots and `system/` are never listed or moved. | `her_sorted_kindle_is_listed_and_left_untouched`, `book_only_on_kindle_is_saved_before_removal` |
| D10 | Files already on the Kindle are never renamed, moved or replaced, and `collections.json` is never edited; a book that comes back goes to the exact path it left from, so her collections still find it. Looking at the Kindle changes nothing. | `her_sorted_kindle_is_listed_and_left_untouched`, `a_book_goes_back_to_its_exact_place_so_collections_still_find_it`, `new_books_join_her_author_folders_and_never_replace_a_file` |
| D11 | "Tout sauvegarder sur l'ordinateur" never changes the Kindle and never copies a book twice. | `whole_kindle_is_saved_on_the_pc_without_touching_it`, e2e "her sorted Kindle…" |
| D9 | Books bought on Amazon (DRM) are listed, kept on the PC as a backup and can go back on her Kindle, but are never offered for sharing. | `amazon_protected_books_are_listed_kept_and_flagged`, e2e "a book bought on Amazon…" |

## 2. The safety net (non-regression)

| Layer | What | Where | Runs |
|---|---|---|---|
| Rust core unit/integration | Library, Kindle detection, MOBI metadata, against real temp folders | `app/core/src/**` | Linux **and Windows** in CI |
| Converter | EPUB → MOBI, round-trip self-check, DRM refusal | `app/converter/test/` | CI |
| UI unit | Wording, sizes, fit computation, conversion queue | `app/ui/test/*.test.js` | CI |
| Contract | Rust commands = UI calls = fake backend | `app/ui/test/contract.test.js` | CI |
| End-to-end journeys | Mom's real flows in Chromium (same engine as WebView2) | `app/e2e/journeys.test.mjs` | CI |
| Lint/format | `cargo fmt --check`, `clippy -D warnings` | CI | CI |
| Screenshots | Main screens rendered for human review on each run | CI artifact `screenshots` | CI |

Rules:

1. **Every bug fix starts with a failing test** that reproduces it.
2. **Every user-visible behaviour has a journey test.** Removing or weakening one needs the owner's yes.
3. Never skip, disable or loosen a test to get green.
4. The installer is built only after all checks pass; a release is published only from a green tag build.

## 3. Architecture rules

- Layers (see ARCHITECTURE.md): `core` (Rust, all file logic, no UI) ← `src-tauri` (thin command shell) ← UI.
- The UI reaches the backend only through `ui/js/api.js`. Pure logic goes in `ui/js/*.js` modules without DOM access, so it is unit-tested in Node.
- The converter is an independent module (`app/converter`, no dependencies) with its own tests and README.
- Errors that reach Mom are full French sentences (`OpError.message`); technical details go to logs, never on screen.
- One file operation at a time (`run()` in `app.js`); the Kindle is never written by two actions at once.

## 4. Releases and updates

- **SemVer.** `x.y.z` in `Cargo.toml`, `tauri.conf.json` and `package.json`, checked by `scripts/check-version.mjs` (also against the tag).
- **CHANGELOG.md** entry for every user-visible change, written so you could read it to Mom.
- **A new version merged into `main`** (or a pushed tag `vX.Y.Z`) → CI → signed pre-release with the installer and SHA-256 sums; CI creates the tag.
- From v0.2 (updater, ADR-0007): updates are **signed** (minisign/Ed25519, key only in GitHub secrets and your password manager) and the app refuses anything else. Two channels, served by GitHub Releases (procedure: `docs/RELEASING.md`):
  1. `test`: merging a new version into `main` (or pushing its tag) publishes a pre-release; you install it on your own PC first.
  2. `stable`: Mom's app follows the release marked Latest; you promote a release there only after the test channel ran it. Rollback = mark the previous release Latest.
- Data-layout changes (anything under `Mes livres/.liseuse/`) need a migration that runs at start, a test with a library in the old layout, and must keep working if the update is rolled back.
- Never ship on a Friday evening before her trip: the updater applies on next start, so a bad version only affects her after a restart, and a rollback fixes it on the following start.

## 5. Code standards

- Rust: edition 2021, toolchain pinned in `rust-toolchain.toml`, `cargo fmt`, `clippy -D warnings`, no `unwrap()` on user data paths, `unsafe` only for Win32 calls in `core/src/kindle.rs` and `library.rs::hide`.
- JS: plain ES modules, no bundler, no framework. JSDoc on exported functions.
- Commits: [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). One concern per PR. PRs need green CI.

## 6. Dependencies and supply chain

- New third-party dependency only with the owner's yes. Today: `tauri`, `tauri-build`, `tauri-plugin-updater`, `reqwest` + `rustls` (same versions and features as inside the updater, ADR-0008), `serde`, `serde_json`, `windows-sys` (Rust); `@tauri-apps/cli`, `playwright` (dev only, JS). The converter has none.
- Libraries are kept up to date for security: Dependabot (`.github/dependabot.yml`) proposes updates 7 days after a release; minor and patch updates are merged automatically once every check above is green on that exact commit (`dependabot-merge.yml`, policy in `.github/scripts/dependabot-merge.sh`, which tests itself on each run); major updates get the `needs-review` label and a review first. After each merge the checks run again on `main`.
- Exact versions, lockfiles committed (`Cargo.lock`, `package-lock.json`), `--locked` / `npm ci --ignore-scripts` everywhere, chosen releases at least 7 days old.
- No secrets in the repo (it is public). No telemetry without the owner's and Mom's agreement.

## 7. Security for Mom's PC

- Per-user install, no admin rights, no listening ports, no remote shell or remote control.
- Files from outside the library (drops, downloads) are only read when they are ebooks under 300 MB.
- Strict Content-Security-Policy in the web view; only the app's own files load.
- Updates and remote content must be signed (v0.2+); the app refuses anything else.
