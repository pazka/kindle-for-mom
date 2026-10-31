//! Mom's library: plain files in `Documents\Mes livres`, plus a hidden
//! `.liseuse` folder the app can always rebuild:
//!
//! ```text
//! Mes livres/
//!   Le Comte de Monte-Cristo - Alexandre Dumas.epub   ← her book (master copy)
//!   Recettes de grand-mère.pdf
//!   .liseuse/
//!     kindle/<nom>.mobi        ← the copy made for the Kindle (EPUB only)
//!     kindle/<nom>.error       ← why it couldn't be made (e.g. "drm")
//!     positions/<nom>.sdr/     ← reading position saved when a book leaves the Kindle
//!     corbeille/<id>/          ← deleted books, restorable for 30 days
//!     state.json               ← small app state (downloads already offered, guide progress)
//! ```
//!
//! The files are the truth: if the app disappears, the books are still
//! ordinary files she (or you) can copy by hand.

use crate::formats::{Format, Light};
use crate::kindle::Kindle;
use crate::mobi;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Keep this much free on the Kindle on top of the book itself
/// (the Kindle needs room for its index and reading positions).
pub const KINDLE_MARGIN: u64 = 5 * 1024 * 1024;
/// Used for "about N more books" before she has any converted book.
pub const DEFAULT_BOOK_SIZE: u64 = 700 * 1024;
const TRASH_DAYS: u64 = 30;
/// Files on the Kindle that are not hers to move around.
const KINDLE_PROTECTED: &[&str] = &[
    "clippings",
    "coupures",
    "dictionar",
    "wörterbuch",
    "diccionario",
];

#[derive(Debug, Clone, Serialize)]
pub struct PcBook {
    /// File name without extension; stable id while the file isn't renamed.
    pub id: String,
    pub file_name: String,
    pub title: String,
    pub author: Option<String>,
    pub format: Format,
    pub size: u64,
    /// Size of what goes on the Kindle (the converted copy for an EPUB).
    pub kindle_size: u64,
    pub light: Light,
    pub advice: String,
    /// Ready to go on the Kindle (native format, or converted).
    pub ready: bool,
    /// Conversion still to do (EPUB without a Kindle copy yet).
    pub converting: bool,
    /// Why it can't go on the Kindle ("drm", "convert").
    pub error: Option<String>,
    pub on_kindle: bool,
    /// File name it has (or will have) in the Kindle's `documents` folder.
    pub kindle_name: String,
    pub added: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct KindleBook {
    /// File name in `documents`.
    pub id: String,
    pub title: String,
    pub author: Option<String>,
    pub format: Format,
    pub size: u64,
    /// The same book exists in her library on the PC.
    pub on_pc: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct KindleSide {
    pub kindle: Kindle,
    pub books: Vec<KindleBook>,
    pub used_percent: u8,
    /// "ok", "bientot" (under 15 % free) or "plein" (under 5 %).
    pub level: &'static str,
    pub books_left: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Overview {
    pub library: PathBuf,
    pub pc: Vec<PcBook>,
    pub kindle: Option<KindleSide>,
}

/// An operation that couldn't be done, with a sentence for Mom.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OpError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free: Option<u64>,
}

impl OpError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        OpError {
            code,
            message: message.into(),
            needed: None,
            free: None,
        }
    }
    fn io(e: io::Error) -> Self {
        OpError::new(
            "io",
            format!("Un problème est survenu avec un fichier ({e})."),
        )
    }
}

impl From<io::Error> for OpError {
    fn from(e: io::Error) -> Self {
        OpError::io(e)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct State {
    /// Only downloads newer than this (unix seconds) are offered.
    #[serde(default)]
    pub downloads_since: u64,
    /// Downloads already offered (accepted or refused), by file name + size.
    #[serde(default)]
    pub downloads_seen: Vec<String>,
    /// Free-form UI state (guide progress, tips seen…).
    #[serde(default)]
    pub ui: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadCandidate {
    pub path: PathBuf,
    pub file_name: String,
    pub size: u64,
    pub format: Format,
    pub key: String,
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn mtime_secs(m: &fs::Metadata) -> u64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A file name Windows accepts, readable, at most 120 characters.
pub fn safe_name(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let mut out = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.chars().count() > 120 {
        out = out.chars().take(120).collect();
    }
    let out = out.trim_matches(|c: char| c == '.' || c == ' ').to_string();
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "LPT1", "LPT2", "LPT3",
    ];
    if out.is_empty() || reserved.contains(&out.to_ascii_uppercase().as_str()) {
        "Livre".to_string()
    } else {
        out
    }
}

/// "Titre - Auteur" → (titre, Some(auteur)).
pub fn split_title(stem: &str) -> (String, Option<String>) {
    match stem.rsplit_once(" - ") {
        Some((t, a)) if !t.trim().is_empty() && !a.trim().is_empty() => {
            (t.trim().into(), Some(a.trim().into()))
        }
        _ => (stem.to_string(), None),
    }
}

pub fn display_name(title: &str, author: Option<&str>) -> String {
    match author.map(str::trim).filter(|a| !a.is_empty()) {
        Some(a) => format!("{} - {}", title.trim(), a),
        None => title.trim().to_string(),
    }
}

/// Copy a file so that a cut cable never leaves half a book: write to a
/// temporary name, flush to the device, then rename.
pub fn copy_durable(from: &Path, to: &Path) -> io::Result<u64> {
    let tmp = to.with_extension("liseuse-tmp");
    let res = (|| {
        let mut src = fs::File::open(from)?;
        let mut dst = fs::File::create(&tmp)?;
        let n = io::copy(&mut src, &mut dst)?;
        dst.sync_all()?;
        drop(dst);
        if n != fs::metadata(from)?.len() {
            return Err(io::Error::other("copie incomplète"));
        }
        fs::rename(&tmp, to)?;
        Ok(n)
    })();
    if res.is_err() {
        fs::remove_file(&tmp).ok();
    }
    res
}

fn write_durable(to: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = to.with_extension("liseuse-tmp");
    let res = (|| {
        use io::Write;
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, to)
    })();
    if res.is_err() {
        fs::remove_file(&tmp).ok();
    }
    res
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)?.flatten() {
        let p = e.path();
        let target = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&p, &target)?;
        } else {
            copy_durable(&p, &target)?;
        }
    }
    Ok(())
}

/// Move a file or folder (rename, or copy + delete across drives).
fn move_path(from: &Path, to: &Path) -> io::Result<()> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    if from.is_dir() {
        copy_dir(from, to)?;
        fs::remove_dir_all(from)
    } else {
        copy_durable(from, to)?;
        fs::remove_file(from)
    }
}

fn eq_ci(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

pub struct Library {
    root: PathBuf,
    /// Titles read from Kindle files, keyed by path + size + mtime: with
    /// hundreds of books on a USB 2 Kindle, re-reading every header on each
    /// refresh would be slow.
    meta_cache: Mutex<HashMap<(PathBuf, u64, u64), Option<mobi::MobiMeta>>>,
}

impl Library {
    /// Open (and create if needed) the library folder.
    pub fn open(root: impl Into<PathBuf>) -> io::Result<Library> {
        let lib = Library {
            root: root.into(),
            meta_cache: Mutex::new(HashMap::new()),
        };
        for d in ["kindle", "positions", "corbeille"] {
            fs::create_dir_all(lib.meta_dir().join(d))?;
        }
        hide(&lib.meta_dir());
        lib.purge_trash();
        Ok(lib)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    fn meta_dir(&self) -> PathBuf {
        self.root.join(".liseuse")
    }
    fn cache_dir(&self) -> PathBuf {
        self.meta_dir().join("kindle")
    }
    fn positions_dir(&self) -> PathBuf {
        self.meta_dir().join("positions")
    }
    fn trash_dir(&self) -> PathBuf {
        self.meta_dir().join("corbeille")
    }

    // ------------------------------------------------------------ state

    pub fn load_state(&self) -> State {
        let p = self.meta_dir().join("state.json");
        let mut s: State = fs::read(&p)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        if s.downloads_since == 0 {
            // first run: offer what was downloaded in the last 30 days
            s.downloads_since = now_secs().saturating_sub(30 * 24 * 3600);
            self.save_state(&s).ok();
        }
        s
    }

    pub fn save_state(&self, s: &State) -> io::Result<()> {
        let bytes = serde_json::to_vec_pretty(s).map_err(io::Error::other)?;
        write_durable(&self.meta_dir().join("state.json"), &bytes)
    }

    // ------------------------------------------------------------ PC side

    fn book_files(&self) -> Vec<(PathBuf, Format, fs::Metadata)> {
        let Ok(rd) = fs::read_dir(&self.root) else {
            return vec![];
        };
        let mut v: Vec<_> = rd
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                let m = e.metadata().ok()?;
                if !m.is_file() || p.file_name()?.to_str()?.starts_with('.') {
                    return None;
                }
                Some((p.clone(), Format::from_path(&p)?, m))
            })
            .collect();
        v.sort_by_key(|(p, _, _)| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));
        v
    }

    fn find_file(&self, id: &str) -> Option<(PathBuf, Format)> {
        self.book_files()
            .into_iter()
            .find(|(p, _, _)| {
                p.file_stem()
                    .is_some_and(|s| eq_ci(&s.to_string_lossy(), id))
            })
            .map(|(p, f, _)| (p, f))
    }

    fn kindle_name(stem: &str, f: Format) -> String {
        let ext = if f.kindle_native() { f.ext() } else { "mobi" };
        format!("{stem}.{ext}")
    }

    fn cache_path(&self, stem: &str) -> PathBuf {
        self.cache_dir().join(format!("{stem}.mobi"))
    }
    fn error_path(&self, stem: &str) -> PathBuf {
        self.cache_dir().join(format!("{stem}.error"))
    }

    pub fn pc_books(&self) -> Vec<PcBook> {
        self.book_files()
            .into_iter()
            .map(|(p, f, m)| {
                let stem = p.file_stem().unwrap_or_default().to_string_lossy().into_owned();
                let (title, author) = split_title(&stem);
                let size = m.len();
                let (light, advice) = f.advice(size);
                let mut b = PcBook {
                    kindle_name: Self::kindle_name(&stem, f),
                    id: stem.clone(),
                    file_name: p.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                    title,
                    author,
                    format: f,
                    size,
                    kindle_size: size,
                    light,
                    advice: advice.to_string(),
                    ready: f.kindle_native(),
                    converting: false,
                    error: None,
                    on_kindle: false,
                    added: mtime_secs(&m),
                };
                if !f.kindle_native() {
                    if let Ok(cm) = fs::metadata(self.cache_path(&stem)) {
                        b.ready = true;
                        b.kindle_size = cm.len();
                    } else if let Ok(code) = fs::read_to_string(self.error_path(&stem)) {
                        let code = code.trim().to_string();
                        b.light = Light::Rouge;
                        b.advice = if code == "drm" {
                            "Ce livre est protégé contre la copie : il ne peut pas aller sur cette liseuse.".into()
                        } else {
                            "Ce livre n'a pas pu être transformé pour la liseuse.".into()
                        };
                        b.error = Some(code);
                    } else {
                        b.converting = true;
                    }
                }
                b
            })
            .collect()
    }

    /// EPUBs that still need a Kindle copy.
    pub fn needs_conversion(&self) -> Vec<String> {
        self.pc_books()
            .into_iter()
            .filter(|b| b.converting)
            .map(|b| b.id)
            .collect()
    }

    fn existing_stems(&self) -> HashSet<String> {
        self.book_files()
            .into_iter()
            .filter_map(|(p, _, _)| Some(p.file_stem()?.to_string_lossy().to_lowercase()))
            .collect()
    }

    fn unique_stem(&self, wanted: &str) -> String {
        let taken = self.existing_stems();
        let base = safe_name(wanted);
        if !taken.contains(&base.to_lowercase()) {
            return base;
        }
        (2..)
            .map(|n| format!("{base} ({n})"))
            .find(|s| !taken.contains(&s.to_lowercase()))
            .unwrap()
    }

    /// Add a book from bytes; returns its id.
    pub fn add_bytes(&self, name: &str, format: Format, bytes: &[u8]) -> Result<String, OpError> {
        let stem = self.unique_stem(name);
        write_durable(&self.root.join(format!("{stem}.{}", format.ext())), bytes)?;
        Ok(stem)
    }

    /// Add a book from a file on disk (a download, a dropped file). The name
    /// comes from `name` if given, else the MOBI title, else the file name.
    pub fn add_path(&self, path: &Path, name: Option<&str>) -> Result<String, OpError> {
        let format = Format::from_path(path).ok_or_else(|| {
            OpError::new(
                "format",
                "Ce fichier n'est pas un livre que la liseuse peut lire.",
            )
        })?;
        let wanted = match name {
            Some(n) => n.to_string(),
            None => {
                let meta = if format.palmdb() {
                    mobi::read_meta(path)
                } else {
                    None
                };
                match meta.and_then(|m| m.title.clone().map(|t| (t, m.author))) {
                    Some((t, a)) => display_name(&t, a.as_deref()),
                    None => path
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                }
            }
        };
        let stem = self.unique_stem(&wanted);
        copy_durable(path, &self.root.join(format!("{stem}.{}", format.ext())))?;
        Ok(stem)
    }

    pub fn read_book(&self, id: &str) -> Result<Vec<u8>, OpError> {
        let (p, _) = self.find_file(id).ok_or_else(missing)?;
        Ok(fs::read(p)?)
    }

    pub fn save_kindle_copy(&self, id: &str, mobi: &[u8]) -> Result<(), OpError> {
        self.find_file(id).ok_or_else(missing)?;
        fs::remove_file(self.error_path(id)).ok();
        write_durable(&self.cache_path(id), mobi)?;
        Ok(())
    }

    /// Rename a book (and its Kindle copy and saved reading position).
    /// Used after converting an EPUB with an unhelpful file name such as
    /// "pg17989-images". Returns the new id. A book already on the Kindle
    /// keeps its old name there until it comes back.
    pub fn rename(&self, id: &str, name: &str) -> Result<String, OpError> {
        let (p, f) = self.find_file(id).ok_or_else(missing)?;
        let stem = p
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        if safe_name(name) == stem {
            return Ok(stem);
        }
        let new = self.unique_stem(name);
        fs::rename(&p, self.root.join(format!("{new}.{}", f.ext())))?;
        for (old, newp) in [
            (self.cache_path(&stem), self.cache_path(&new)),
            (self.error_path(&stem), self.error_path(&new)),
            (
                self.positions_dir().join(format!("{stem}.sdr")),
                self.positions_dir().join(format!("{new}.sdr")),
            ),
        ] {
            if old.exists() {
                fs::rename(old, newp).ok();
            }
        }
        Ok(new)
    }

    pub fn save_conversion_error(&self, id: &str, code: &str) -> Result<(), OpError> {
        self.find_file(id).ok_or_else(missing)?;
        let code: String = code
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .take(32)
            .collect();
        fs::write(self.error_path(id), code)?;
        Ok(())
    }

    // ------------------------------------------------------------ Kindle side

    pub fn kindle_books(&self, k: &Kindle) -> Vec<KindleBook> {
        let pc_names: HashSet<String> = self
            .pc_books()
            .into_iter()
            .map(|b| b.kindle_name.to_lowercase())
            .collect();
        let Ok(rd) = fs::read_dir(k.documents()) else {
            return vec![];
        };
        let mut v: Vec<KindleBook> = rd
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                let m = e.metadata().ok()?;
                let name = p.file_name()?.to_str()?.to_string();
                let lower = name.to_lowercase();
                if !m.is_file()
                    || name.starts_with('.')
                    || KINDLE_PROTECTED.iter().any(|w| lower.contains(w))
                {
                    return None;
                }
                let format = Format::from_path(&p).filter(|f| f.kindle_native())?;
                let stem = p.file_stem()?.to_string_lossy().into_owned();
                let meta = if format.palmdb() {
                    self.cached_meta(&p, &m)
                } else {
                    None
                };
                let (title, author) = match meta.and_then(|m| m.title.map(|t| (t, m.author))) {
                    Some((t, a)) => (t, a),
                    None => split_title(&stem),
                };
                Some(KindleBook {
                    on_pc: pc_names.contains(&lower),
                    id: name,
                    title,
                    author,
                    format,
                    size: m.len(),
                })
            })
            .collect();
        v.sort_by_key(|b| b.title.to_lowercase());
        v
    }

    fn cached_meta(&self, p: &Path, m: &fs::Metadata) -> Option<mobi::MobiMeta> {
        let key = (p.to_path_buf(), m.len(), mtime_secs(m));
        let mut cache = self.meta_cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(v) = cache.get(&key) {
            return v.clone();
        }
        let v = mobi::read_meta(p);
        if cache.len() > 5000 {
            cache.clear();
        }
        cache.insert(key, v.clone());
        v
    }

    /// The file to send to a friend (the original: EPUB reads everywhere).
    pub fn share_file(&self, id: &str) -> Result<PathBuf, OpError> {
        self.find_file(id).map(|(p, _)| p).ok_or_else(missing)
    }

    pub fn overview(&self, k: Option<&Kindle>) -> Overview {
        let mut pc = self.pc_books();
        let kindle = k.map(|k| {
            let books = self.kindle_books(k);
            let on: HashSet<String> = fs::read_dir(k.documents())
                .map(|rd| {
                    rd.flatten()
                        .map(|e| e.file_name().to_string_lossy().to_lowercase())
                        .collect()
                })
                .unwrap_or_default();
            for b in &mut pc {
                b.on_kindle = on.contains(&b.kindle_name.to_lowercase());
            }
            kindle_side(k.clone(), books)
        });
        Overview {
            library: self.root.clone(),
            pc,
            kindle,
        }
    }

    /// Put a book from the PC onto the Kindle (with its saved reading position).
    /// `k` must be fresh (the shell calls `kindle::find()` just before), so its
    /// `free_bytes` is the space left right now; tests pass a Kindle with a
    /// chosen free space.
    pub fn put_on_kindle(&self, id: &str, k: &Kindle) -> Result<(), OpError> {
        let book = self
            .pc_books()
            .into_iter()
            .find(|b| eq_ci(&b.id, id))
            .ok_or_else(missing)?;
        if let Some(code) = &book.error {
            return Err(OpError::new(
                if code == "drm" { "drm" } else { "convert" },
                book.advice,
            ));
        }
        if !book.ready {
            return Err(OpError::new(
                "not_ready",
                "Ce livre est encore en préparation. Réessayez dans un instant.",
            ));
        }
        let src = if book.format.kindle_native() {
            self.root.join(&book.file_name)
        } else {
            self.cache_path(&book.id)
        };
        let docs = k.documents();
        let dst = docs.join(&book.kindle_name);
        let already = fs::metadata(&dst).map(|m| m.len()).unwrap_or(0);
        let needed = book.kindle_size.saturating_sub(already) + KINDLE_MARGIN;
        let free = k.free_bytes;
        if needed > free {
            return Err(OpError {
                code: "no_space",
                message: "Il n'y a plus assez de place sur la liseuse. Rangez d'abord un livre sur l'ordinateur.".into(),
                needed: Some(needed),
                free: Some(free),
            });
        }
        copy_durable(&src, &dst)?;
        let saved = self.positions_dir().join(format!("{}.sdr", book.id));
        let sdr = docs.join(format!("{}.sdr", book.id));
        if saved.is_dir() && !sdr.exists() {
            copy_dir(&saved, &sdr).ok(); // a lost reading position must not fail the copy
        }
        Ok(())
    }

    /// Take a book off the Kindle. If the PC doesn't have it yet it is saved
    /// in the library first, and only then removed from the Kindle.
    /// Returns the id of the book on the PC.
    pub fn take_from_kindle(&self, kindle_file: &str, k: &Kindle) -> Result<String, OpError> {
        if kindle_file.contains(['/', '\\']) || kindle_file.starts_with('.') {
            return Err(missing());
        }
        let docs = k.documents();
        let src = docs.join(kindle_file);
        if !src.is_file() {
            return Err(missing());
        }
        let kb = self
            .kindle_books(k)
            .into_iter()
            .find(|b| eq_ci(&b.id, kindle_file))
            .ok_or_else(missing)?;
        let kstem = src
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let pc = self
            .pc_books()
            .into_iter()
            .find(|b| eq_ci(&b.kindle_name, kindle_file));
        let id = match pc {
            Some(b) => b.id,
            None => {
                let name = if kb.title != kstem || kb.author.is_some() {
                    display_name(&kb.title, kb.author.as_deref())
                } else {
                    kstem.clone()
                };
                let id = self.add_path(&src, Some(&name))?;
                let saved = self.root.join(format!("{id}.{}", kb.format.ext()));
                if fs::metadata(&saved).map(|m| m.len()).unwrap_or(0) != kb.size {
                    return Err(OpError::new(
                        "io",
                        "La copie sur l'ordinateur a échoué : le livre reste sur la liseuse.",
                    ));
                }
                id
            }
        };
        let sdr = docs.join(format!("{kstem}.sdr"));
        if sdr.is_dir() {
            let saved = self.positions_dir().join(format!("{id}.sdr"));
            if saved.exists() {
                fs::remove_dir_all(&saved).ok();
            }
            copy_dir(&sdr, &saved).ok();
            fs::remove_dir_all(&sdr).ok();
        }
        fs::remove_file(&src)?;
        Ok(id)
    }

    // ------------------------------------------------------------ trash

    /// Move a book (and its Kindle copy and reading position) to the trash.
    pub fn delete(&self, id: &str) -> Result<String, OpError> {
        let (p, _) = self.find_file(id).ok_or_else(missing)?;
        let stem = p
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let tid = format!("{}-{}", now_secs(), safe_name(&stem));
        let t = self.trash_dir().join(&tid);
        fs::create_dir_all(&t)?;
        move_path(&p, &t.join(p.file_name().unwrap()))?;
        for extra in [
            self.cache_path(&stem),
            self.error_path(&stem),
            self.positions_dir().join(format!("{stem}.sdr")),
        ] {
            if extra.exists() {
                move_path(
                    &extra,
                    &t.join(format!(
                        "meta-{}",
                        extra.file_name().unwrap().to_string_lossy()
                    )),
                )
                .ok();
            }
        }
        Ok(tid)
    }

    pub fn restore(&self, trash_id: &str) -> Result<String, OpError> {
        if trash_id.contains(['/', '\\']) || trash_id.contains("..") || trash_id.is_empty() {
            return Err(missing());
        }
        let t = self.trash_dir().join(trash_id);
        let rd = fs::read_dir(&t).map_err(|_| missing())?;
        let mut id = None;
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let p = e.path();
            if let Some(meta) = name.strip_prefix("meta-") {
                let dest = if meta.ends_with(".sdr") {
                    self.positions_dir()
                } else {
                    self.cache_dir()
                }
                .join(meta);
                move_path(&p, &dest).ok();
            } else {
                let dest = self.root.join(&name);
                if dest.exists() {
                    return Err(OpError::new(
                        "exists",
                        "Un livre du même nom est déjà dans la bibliothèque.",
                    ));
                }
                move_path(&p, &dest)?;
                id = Some(
                    p.file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
        fs::remove_dir_all(&t).ok();
        id.ok_or_else(missing)
    }

    fn purge_trash(&self) {
        let limit = now_secs().saturating_sub(TRASH_DAYS * 24 * 3600);
        let Ok(rd) = fs::read_dir(self.trash_dir()) else {
            return;
        };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if let Some(ts) = name.split('-').next().and_then(|s| s.parse::<u64>().ok()) {
                if ts < limit {
                    fs::remove_dir_all(e.path()).ok();
                }
            }
        }
    }

    // ------------------------------------------------------------ downloads

    /// New ebooks in the Downloads folder that haven't been offered yet.
    pub fn new_downloads(&self, downloads: &Path, state: &State) -> Vec<DownloadCandidate> {
        let seen: HashSet<&str> = state.downloads_seen.iter().map(String::as_str).collect();
        let Ok(rd) = fs::read_dir(downloads) else {
            return vec![];
        };
        let lib: HashSet<(String, u64)> = self
            .book_files()
            .into_iter()
            .filter_map(|(p, _, m)| {
                Some((p.file_name()?.to_string_lossy().to_lowercase(), m.len()))
            })
            .collect();
        rd.flatten()
            .filter_map(|e| {
                let p = e.path();
                let m = e.metadata().ok()?;
                let format = Format::from_path(&p)?;
                if !m.is_file() || m.len() == 0 || mtime_secs(&m) < state.downloads_since {
                    return None;
                }
                let file_name = p.file_name()?.to_string_lossy().into_owned();
                let key = format!("{}|{}", file_name.to_lowercase(), m.len());
                if seen.contains(key.as_str()) {
                    return None;
                }
                // already in the library (same name and size): added by hand
                if lib.contains(&(file_name.to_lowercase(), m.len())) {
                    return None;
                }
                Some(DownloadCandidate {
                    path: p,
                    file_name,
                    size: m.len(),
                    format,
                    key,
                })
            })
            .collect()
    }
}

fn missing() -> OpError {
    OpError::new("missing", "Ce livre n'est plus là.")
}

fn kindle_side(kindle: Kindle, books: Vec<KindleBook>) -> KindleSide {
    let book_sizes: Vec<u64> = books
        .iter()
        .filter(|b| b.format != Format::Pdf)
        .map(|b| b.size)
        .filter(|&s| s > 0)
        .collect();
    let avg = if book_sizes.is_empty() {
        DEFAULT_BOOK_SIZE
    } else {
        (book_sizes.iter().sum::<u64>() / book_sizes.len() as u64)
            .clamp(200 * 1024, 5 * 1024 * 1024)
    };
    let usable = kindle.free_bytes.saturating_sub(KINDLE_MARGIN);
    let used_percent = kindle
        .free_bytes
        .saturating_mul(100)
        .checked_div(kindle.total_bytes)
        .map_or(0, |free_pct| (100 - free_pct.min(100)) as u8);
    let free_pct = 100 - used_percent as u64;
    let level = if free_pct < 5 {
        "plein"
    } else if free_pct < 15 {
        "bientot"
    } else {
        "ok"
    };
    KindleSide {
        books_left: usable / avg,
        kindle,
        books,
        used_percent,
        level,
    }
}

#[cfg(windows)]
fn hide(p: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN};
    let w: Vec<u16> = p.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe { SetFileAttributesW(w.as_ptr(), FILE_ATTRIBUTE_HIDDEN) };
}

#[cfg(not(windows))]
fn hide(_p: &Path) {}

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// A `mailto:` link with a ready-written message to send a book to a friend.
pub fn share_mailto(title: &str, author: Option<&str>) -> String {
    let by = author.map(|a| format!(" de {a}")).unwrap_or_default();
    let subject = format!("Un livre pour toi : {title}");
    let body = format!(
        "Bonjour,\n\nJe te fais découvrir « {title} »{by}. Le livre est en pièce jointe.\n\nBonne lecture !\n"
    );
    format!(
        "mailto:?subject={}&body={}",
        percent_encode(&subject),
        percent_encode(&body.replace('\n', "\r\n"))
    )
}
