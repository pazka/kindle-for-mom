# ADR-0007: Signed updates from GitHub Releases, channels by "Latest"

Date: 2026-10-31 · Status: accepted

## Context
Pazka must be able to update the app on Mom's PC remotely, and only Pazka.
A bad version must never stay on her PC, and nothing unsigned may run.
A server and admin on livres.hosh.it were planned, but nothing there is
needed for a first, safe version.

## Decision
- The official Tauri updater plugin (`tauri-plugin-updater`, same project as
  Tauri) checks once, at start, the `latest.json` of the GitHub release
  marked **Latest** of this public repository.
- Every installer is signed with Pazka's minisign key. The public key is in
  `tauri.conf.json`. The private key and its password exist only in Pazka's
  password manager and in the repository secrets `TAURI_SIGNING_PRIVATE_KEY`
  and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The app refuses any file not
  signed with that key.
- **One channel, automatic** (amended 2026-11-01, owner's decision): a new
  version merged into `main` (or a tag `vX.Y.Z`) is published as the
  **Latest** release once every check is green, so Mom gets it at her next
  start with no manual step. (Until 0.3.0 a new version was a pre-release
  that Pazka promoted by hand.)
- **Rollback:** mark the previous release Latest. The app installs any version
  different from its own, older ones included, so her next start goes back.
- The update installs at start, before any copy can begin, with a message
  that can't be dismissed; offline or on any error the app starts as usual.

## Consequences
- No server to run or secure; GitHub hosts and serves the files.
- Anyone can download the installers (the repository is public), but only
  Pazka's key can make one her app accepts.
- An admin page on livres.hosh.it can later replace the endpoint (for per-PC
  channels) without changing the signing.
- Losing the private key means her app can no longer be updated remotely:
  it must be backed up in the password manager.
