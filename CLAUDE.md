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

## Agent system: QA gate, journal, "what happened to X"
**Before any work in this repo, whatever the request:** read the hub `pazka/hosh-management`:
`AGENTS.md` (how the hosh.it agents and the owner work together), `README.md` (every app, site, repo and
journal), `roles/` (the full procedure of each agent: QA, Security, Developer, DevOps, dependency updates).
`gh api repos/pazka/hosh-management/contents/AGENTS.md -H "Accept: application/vnd.github.raw"`
(same for `README.md`, `roles/README.md`, `roles/qa.md`...). Those rules apply here; this file adds the
repo's own.

Canonical rules: `AGENTS.md` in the private hub `pazka/hosh-management`
(`gh api repos/pazka/hosh-management/contents/AGENTS.md -H "Accept: application/vnd.github.raw"`).
Summary, binding for every agent that works in this repo:
- **Nothing is merged without the independent QA agent.** Work on `agent/<topic>-<yyyymmdd>`, get CI
  green, write in the PR body what changed, which use cases it touches and how it was tested, then add
  the label `qa:requested`. Merge only when the PR has `qa:approved` AND a comment
  `QA-VERDICT: APPROVED sha=<current head sha>`. On `qa:changes-requested`: fix on the same branch,
  answer each finding, ask again; QA re-tests the whole PR. Never approve your own PR. After QA's
  approval the agent that opened the PR merges it: this replaces "the owner merges" and "merge when
  CI is green" wherever this file still says so.
- **Owner fast lane**: when the owner asks for a feature in a session he is in, do it end to end in
  that session (discuss, develop, QA by a fresh independent QA subagent or a QA routine run now, merge,
  release, deploy, show the live URL). Rules: AGENTS.md section 2b. The session that wrote the code never
  writes the verdict.
- **QA owns the tests and the visual regression**: every use case a user can reach (listed in
  `TESTING.md`), screenshots at 1400 / 1024 / 390 px, baselines in the repo. A wanted visual change
  must be announced in the PR. Never weaken a test or a gate to get green.
- A NEW third-party dependency always needs the owner: open an issue in `pazka/hosh-management`
  labelled `ready-for-human` (that label is the list of places where the owner is needed).
- Release = Actions → release with `version=vX.Y.Z` on the default branch. Never push a git tag.
- **Journal**: after each event (PR ready, QA verdict, merge, release, deploy, rollback, incident,
  blocker) add one comment to this project's journal, `pazka/hosh-management#20`.
- **When the owner asks "what happened to X"** (this app, another one, or the server): open the index
  in `pazka/hosh-management` `README.md`, read the last comments of X's journal issue
  (`gh issue view <n> -R pazka/hosh-management --comments`), then the open `ready-for-human` issues,
  then PRs / Actions runs if needed. Server facts you cannot see: ask the Box agent (mailbox from a
  laptop session, or an issue labelled `box-question`). Answer with: what happened (dated), the state
  now, where the owner is needed.
- Online checks use only the URLs in `pazka/hosh-management` `uptime/checks.json`.
