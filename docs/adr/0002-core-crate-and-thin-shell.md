# ADR-0002: All file logic in a UI-free core crate

Date: 2026-10-31 · Status: accepted

## Context
The riskiest code (moving Mom's books) must be testable on every commit, on Linux and on Windows, without a GUI.

## Decision
`app/core` (`liseuse-core`) holds every file operation and depends only on std, serde and windows-sys. `app/src-tauri` only registers commands. The UI calls the backend through one module (`ui/js/api.js`), and a contract test keeps the Rust commands, the UI and the test fake in sync.

## Consequences
- Core tests run in CI on Ubuntu and Windows in seconds.
- UI journeys run against a fake backend; the real behaviour of each command is covered by core tests.
- Adding a command touches four files; the contract test enforces it.
