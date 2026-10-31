# Releasing a new version

1. On `main`, set the same version `X.Y.Z` in `app/Cargo.toml`
   (`[workspace.package]`), `app/src-tauri/tauri.conf.json` and
   `app/package.json` (`npm run check:version` checks them), and write the
   `CHANGELOG.md` entry.
2. Merge that change into `main` (a PR, like any change). Nothing else to do:
   when `main` carries a version without a tag, CI runs every check, builds
   the installer **signed** with the updater key, creates the tag `vX.Y.Z` on
   that commit and publishes a **pre-release** with the installer, its
   `.sig`, `latest.json` and `SHA256SUMS.txt`. Pushing a tag `vX.Y.Z` by hand
   does the same. A release build fails if the signing secrets are missing.
4. **Test channel:** install the pre-release's installer on your own PC and
   use it.
5. **Promote to Mom:** on GitHub, edit the release, untick "Set as a
   pre-release" and tick "Set as the latest release". Her app updates the
   next time she opens it.
6. **Rollback:** edit the previous release and tick "Set as the latest
   release". Her app goes back to it at the next start.

Don't promote on a Friday evening before one of her trips (STANDARDS §4).
