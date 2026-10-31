//! Core of the "Liseuse" app: everything that touches files, with no UI.
//! The Tauri shell (`src-tauri`) only forwards calls here, so all of this
//! is tested with `cargo test -p liseuse-core` on any OS.

pub mod formats;
pub mod kindle;
pub mod library;
pub mod mobi;

#[cfg(test)]
mod tests;
