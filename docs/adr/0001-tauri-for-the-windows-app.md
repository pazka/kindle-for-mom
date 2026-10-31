# ADR-0001: Tauri 2 for the Windows app

Date: 2026-10-31 · Status: accepted (owner approved)

## Context
Mom uses Windows 11 (Windows 10 support later). The app needs a rich illustrated UI, offline EPUB conversion, USB drive access, and remote updates only the owner can publish.

## Decision
Tauri 2: Rust core + HTML/CSS/JS UI in WebView2, NSIS per-user installer.

## Consequences
- Small installer (~10 MB), no admin rights, same build on Windows 10 and 11 (WebView2 ships with both).
- Built-in updater with mandatory Ed25519 signatures (used from v0.2).
- The EPUB converter (plain JS) runs in the web view unchanged.
- Rejected: Electron (100+ MB, larger attack surface), .NET/WPF (harder skeuomorphic UI, converter rewrite).
