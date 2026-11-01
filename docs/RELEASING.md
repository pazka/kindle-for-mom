# Releasing a new version

1. On `main`, set the same version `X.Y.Z` in `app/Cargo.toml`
   (`[workspace.package]`), `app/src-tauri/tauri.conf.json` and
   `app/package.json` (`npm run check:version` checks them), and write the
   `CHANGELOG.md` entry.
2. Merge that change into `main` (a PR, like any change). Nothing else to do:
   when `main` carries a version without a tag, CI runs every check, builds
   the installer **signed** with the updater key, creates the tag `vX.Y.Z` on
   that commit and publishes it as the **Latest release** with the installer, its
   `.sig`, `latest.json` and `SHA256SUMS.txt`. Pushing a tag `vX.Y.Z` by hand
   does the same. A release build fails if the signing secrets are missing.
3. **That's it: one channel, fully automatic** (owner's decision,
   2026-11-01). Her app installs the new version the next time she opens
   it, with a short message, and reopens by itself. The release is only
   published if every check is green (core and UI tests, the 28 journeys,
   the Windows build). The live check against livres.hosh.it is shown on
   the run but doesn't block a release, so a server outage never holds back
   a fix.
4. **Rollback:** on GitHub, edit the previous release and tick "Set as the
   latest release". Her app goes back to it at the next start. Then fix
   forward with a new version.

Don't merge a version bump on a Friday evening before one of her trips (STANDARDS §4).
