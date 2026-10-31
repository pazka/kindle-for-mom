//! Mom's library: plain files in `Documents\Mes livres`, one folder per
//! author like on her Kindle, plus a hidden `.liseuse` folder the app can
//! always rebuild (ADR-0003, ADR-0006):
//!
//! ```text
//! Mes livres/
//!   Dumas, Alexandre/
//!     Le Comte de Monte-Cristo.epub   ← her book (master copy)
//!   Recettes de grand-mère.pdf        ← no author: at the top
//!   .liseuse/                         ← same sub-folders as the books
//!     kindle/<id>.mobi                ← the copy made for the Kindle (EPUB only)
//!     kindle/<id>.error               ← why it couldn't be made (e.g. "drm")
//!     positions/<id>.sdr/             ← reading position (older Kindles: a folder)
//!     positions/<id>.mbp, .apnx, …    ← reading position (Kindle 4: files next to the book)
//!     positions/<id>.kindle-path      ← where the book was on the Kindle, to put it back there
//!     corbeille/<n>/                  ← deleted books, restorable for 30 days
//!     state.json                      ← small app state (downloads already offered, guide progress)
//! ```
//!
//! A book's id is its path in `Mes livres` without extension, with `/`
//! ("Dumas, Alexandre/Le Comte de Monte-Cristo"). On the Kindle, a book is
//! identified by its path in `documents` ("Dumas, Alexandre/Le Comte de
//! Monte-Cristo.mobi"). The same book on both sides is found by its path
//! or by title + author (`authors::book_key`).
//!
//! The files are the truth: if the app disappears, the books are still
//! ordinary files she (or you) can copy by hand.

use crate::authors::{self, book_key};
use crate::formats::{Format, Light};
use crate::kindle::Kindle;
use crate::mobi;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf, MAIN_SEPARATOR_STR};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Keep this much free on the Kindle on top of the book itself
/// (the Kindle needs room for its index and reading positions).
pub const KINDLE_MARGIN: u64 = 5 * 1024 * 1024;
/// Used for "about N more books" before she has any converted book.
pub const DEFAULT_BOOK_SIZE: u64 = 700 * 1024;
const TRASH_DAYS: u64 = 30;
const PROTECTED_ADVICE: &str =
    "Acheté sur Amazon : ce livre se lit seulement sur votre liseuse. Gardez-le ici, c'est votre copie de sauvegarde.";
/// Files and folders on the Kindle that are not hers to move around
/// (notes, dictionaries, screenshots), matched anywhere in the name.
const KINDLE_PROTECTED: &[&str] = &[
    "clippings",
    "coupures",
    "mes extraits",
    "screen_shot",
    "dictionar",
    "dictionnaire",
    "wörterbuch",
    "diccionario",
];
/// Files the Kindle 4 writes next to a book (last page read, notes, page
/// numbers…). They have the book's name and travel with it.
pub const SIDECARS: &[&str] = &["mbp", "apnx", "eal", "ea", "han", "pdr"];
/// documents/Auteur/Série/livre is the deepest the app looks.
const KINDLE_DEPTH: usize = 3;

#[derive(Debug, Clone, Serialize)]
pub struct PcBook {
    /// Path in the library without extension ("Auteur/Titre"); stable while
    /// the file isn't renamed.
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
    /// Bought on Amazon with copy protection: fine on her Kindle, useless to share.
    pub protected: bool,
    /// Path it has (or will have) in the Kindle's `documents` folder.
    pub kindle_name: String,
    /// The book on the Kindle that is this one (`KindleBook::id`), if plugged in.
    pub kindle_id: Option<String>,
    /// `kindle_name` is where the book really was on the Kindle (it left
    /// from there), not just where it would go.
    #[serde(skip)]
    remembered: bool,
    pub added: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct KindleBook {
    /// Path in `documents`, with `/` ("Hugo, Victor/Les Miserables.mobi").
    pub id: String,
    pub title: String,
    pub author: Option<String>,
    pub format: Format,
    pub size: u64,
    /// The same book exists in her library on the PC.
    pub on_pc: bool,
    /// Bought on Amazon with copy protection.
    pub protected: bool,
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

/// `base` + "Auteur/Titre" + `suffix`, with the platform's separator.
fn under(base: &Path, id: &str, suffix: &str) -> PathBuf {
    base.join(format!("{id}{suffix}").replace('/', MAIN_SEPARATOR_STR))
}

/// A path in `documents` the UI may name: relative, no `..`, no hidden part.
fn valid_rel(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.contains('\\')
        && rel.split('/').count() <= KINDLE_DEPTH
        && rel
            .split('/')
            .all(|c| !c.is_empty() && !c.starts_with('.') && !c.contains(':'))
}

fn protected_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    KINDLE_PROTECTED.iter().any(|w| lower.contains(w))
}

/// Remove `from`'s parent folders while they are empty, up to `stop`.
fn remove_empty_parents(from: &Path, stop: &Path) {
    let mut d = from.parent();
    while let Some(dir) = d {
        if dir == stop || !dir.starts_with(stop) || fs::remove_dir(dir).is_err() {
            break;
        }
        d = dir.parent();
    }
}

fn create_parent(p: &Path) -> io::Result<()> {
    match p.parent() {
        Some(d) => fs::create_dir_all(d),
        None => Ok(()),
    }
}

/// Mark PC and Kindle books that are the same book: back at the place it
/// left from, or else same title + author. A file that only happens to have
/// the name the book would get is another book.
fn link(pc: &mut [PcBook], kindle: &mut [KindleBook]) {
    let mut by_path: HashMap<String, usize> = HashMap::new();
    let mut by_key: HashMap<String, usize> = HashMap::new();
    for (i, k) in kindle.iter().enumerate() {
        by_path.insert(k.id.to_lowercase(), i);
        by_key
            .entry(book_key(&k.title, k.author.as_deref()))
            .or_insert(i);
    }
    for b in pc.iter_mut() {
        let hit = by_path
            .get(&b.kindle_name.to_lowercase())
            .filter(|_| b.remembered)
            .or_else(|| by_key.get(&book_key(&b.title, b.author.as_deref())));
        if let Some(&i) = hit {
            b.on_kindle = true;
            b.kindle_id = Some(kindle[i].id.clone());
            kindle[i].on_pc = true;
        }
    }
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

    /// Every book file: at the top of the library and one folder down
    /// (author folders). Returns (path, id, format, metadata).
    fn book_files(&self) -> Vec<(PathBuf, String, Format, fs::Metadata)> {
        let mut v = Vec::new();
        let Ok(rd) = fs::read_dir(&self.root) else {
            return v;
        };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(m) = e.metadata() else { continue };
            if m.is_dir() {
                let Ok(sub) = fs::read_dir(e.path()) else {
                    continue;
                };
                for f in sub.flatten() {
                    let fname = f.file_name().to_string_lossy().into_owned();
                    let Ok(fm) = f.metadata() else { continue };
                    if fname.starts_with('.') || !fm.is_file() {
                        continue;
                    }
                    let p = f.path();
                    if let Some(format) = Format::from_path(&p) {
                        let stem = p.file_stem().unwrap_or_default().to_string_lossy();
                        v.push((p.clone(), format!("{name}/{stem}"), format, fm));
                    }
                }
            } else if m.is_file() {
                let p = e.path();
                if let Some(format) = Format::from_path(&p) {
                    let stem = p
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned();
                    v.push((p, stem, format, m));
                }
            }
        }
        v.sort_by_key(|(_, id, _, _)| id.to_lowercase());
        v
    }

    fn find_file(&self, id: &str) -> Option<(PathBuf, Format)> {
        self.book_files()
            .into_iter()
            .find(|(_, i, _, _)| eq_ci(i, id))
            .map(|(p, _, f, _)| (p, f))
    }

    fn cache_path(&self, id: &str) -> PathBuf {
        under(&self.cache_dir(), id, ".mobi")
    }
    fn error_path(&self, id: &str) -> PathBuf {
        under(&self.cache_dir(), id, ".error")
    }
    fn kindle_path_file(&self, id: &str) -> PathBuf {
        under(&self.positions_dir(), id, ".kindle-path")
    }
    /// Everything the app keeps about a book besides the book itself.
    fn extras(&self, id: &str) -> Vec<PathBuf> {
        let mut v = vec![
            self.cache_path(id),
            self.error_path(id),
            under(&self.positions_dir(), id, ".sdr"),
            self.kindle_path_file(id),
        ];
        v.extend(
            SIDECARS
                .iter()
                .map(|e| under(&self.positions_dir(), id, &format!(".{e}"))),
        );
        v
    }

    pub fn pc_books(&self) -> Vec<PcBook> {
        self.book_files()
            .into_iter()
            .map(|(p, id, f, m)| {
                let (folder, stem) = match id.split_once('/') {
                    Some((a, s)) => (Some(a.to_string()), s.to_string()),
                    None => (None, id.clone()),
                };
                let (mut title, mut author) = match &folder {
                    Some(a) => (stem.clone(), Some(a.clone())),
                    None => split_title(&stem),
                };
                let meta = if f.palmdb() {
                    self.cached_meta(&p, &m)
                } else {
                    None
                };
                if let Some(mm) = &meta {
                    if let Some(t) = mm.title.clone().filter(|t| !t.is_empty()) {
                        title = t;
                        author = mm.author.clone().or(author);
                    }
                }
                let size = m.len();
                let (light, advice) = f.advice(size);
                let kext = if f.kindle_native() { f.ext() } else { "mobi" };
                let remembered = fs::read_to_string(self.kindle_path_file(&id))
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| valid_rel(s));
                let kindle_name = remembered
                    .clone()
                    .unwrap_or_else(|| authors::kindle_path(&title, author.as_deref(), kext));
                let mut b = PcBook {
                    kindle_name,
                    kindle_id: None,
                    remembered: remembered.is_some(),
                    file_name: p.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                    id,
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
                    protected: false,
                    added: mtime_secs(&m),
                };
                if meta.is_some_and(|mm| mm.drm) {
                    b.protected = true;
                    b.advice = PROTECTED_ADVICE.into();
                }
                if !f.kindle_native() {
                    if let Ok(cm) = fs::metadata(self.cache_path(&b.id)) {
                        b.ready = true;
                        b.kindle_size = cm.len();
                    } else if let Ok(code) = fs::read_to_string(self.error_path(&b.id)) {
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

    /// Where a book called "Titre - Auteur" goes in the library:
    /// "Nom, Prénom/Titre", or "Titre" when there is no author.
    fn place(name: &str) -> String {
        let (title, author) = split_title(name.trim());
        let file = safe_name(&title);
        match author
            .map(|a| authors::author_sort(&a))
            .filter(|a| !a.trim().is_empty())
        {
            Some(a) => format!("{}/{file}", safe_name(&a)),
            None => file,
        }
    }

    /// A free id for `name`, with " (2)", " (3)"… if the place is taken.
    fn unique_id(&self, name: &str) -> String {
        let taken: HashSet<String> = self
            .book_files()
            .into_iter()
            .map(|(_, id, _, _)| id.to_lowercase())
            .collect();
        let base = Self::place(name);
        if !taken.contains(&base.to_lowercase()) {
            return base;
        }
        (2..)
            .map(|n| format!("{base} ({n})"))
            .find(|s| !taken.contains(&s.to_lowercase()))
            .unwrap_or(base)
    }

    fn file_of(&self, id: &str, format: Format) -> PathBuf {
        under(&self.root, id, &format!(".{}", format.ext()))
    }

    /// Add a book from bytes; `name` is "Titre - Auteur". Returns its id.
    pub fn add_bytes(&self, name: &str, format: Format, bytes: &[u8]) -> Result<String, OpError> {
        let id = self.unique_id(name);
        let to = self.file_of(&id, format);
        create_parent(&to)?;
        write_durable(&to, bytes)?;
        Ok(id)
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
        let id = self.unique_id(&wanted);
        let to = self.file_of(&id, format);
        create_parent(&to)?;
        copy_durable(path, &to)?;
        Ok(id)
    }

    pub fn read_book(&self, id: &str) -> Result<Vec<u8>, OpError> {
        let (p, _) = self.find_file(id).ok_or_else(missing)?;
        Ok(fs::read(p)?)
    }

    pub fn save_kindle_copy(&self, id: &str, mobi: &[u8]) -> Result<(), OpError> {
        self.find_file(id).ok_or_else(missing)?;
        fs::remove_file(self.error_path(id)).ok();
        let to = self.cache_path(id);
        create_parent(&to)?;
        write_durable(&to, mobi)?;
        Ok(())
    }

    /// Rename a book (and everything the app keeps about it). Used after
    /// converting an EPUB with an unhelpful file name such as
    /// "pg17989-images"; `name` is "Titre - Auteur", so the book also moves
    /// to its author's folder. Returns the new id.
    pub fn rename(&self, id: &str, name: &str) -> Result<String, OpError> {
        let (p, f) = self.find_file(id).ok_or_else(missing)?;
        let old = self
            .book_files()
            .into_iter()
            .find(|(bp, _, _, _)| *bp == p)
            .map(|(_, i, _, _)| i)
            .ok_or_else(missing)?;
        if Self::place(name) == old {
            return Ok(old);
        }
        let new = self.unique_id(name);
        let to = self.file_of(&new, f);
        create_parent(&to)?;
        fs::rename(&p, &to)?;
        remove_empty_parents(&p, &self.root);
        for (from, to) in self.extras(&old).into_iter().zip(self.extras(&new)) {
            if from.exists() && create_parent(&to).is_ok() {
                fs::rename(&from, to).ok();
                remove_empty_parents(&from, &self.meta_dir());
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
        let to = self.error_path(id);
        create_parent(&to)?;
        fs::write(to, code)?;
        Ok(())
    }

    // ------------------------------------------------------------ Kindle side

    /// Her books on the Kindle, in author folders or at the top of
    /// `documents`, without notes, dictionaries or reading-position files.
    fn scan_kindle(&self, k: &Kindle) -> Vec<KindleBook> {
        let mut v = Vec::new();
        self.scan_dir(&k.documents(), "", None, &mut v);
        v.sort_by_cached_key(|b| {
            (
                authors::fold(&authors::author_sort(b.author.as_deref().unwrap_or(""))),
                authors::fold(&b.title),
            )
        });
        v
    }

    fn scan_dir(&self, dir: &Path, prefix: &str, folder: Option<&str>, out: &mut Vec<KindleBook>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || protected_name(&name) {
                continue;
            }
            let Ok(m) = e.metadata() else { continue };
            let p = e.path();
            let rel = format!("{prefix}{name}");
            if m.is_dir() {
                let depth = rel.split('/').count();
                if !name.to_lowercase().ends_with(".sdr") && depth < KINDLE_DEPTH {
                    // the author is the top folder ("Hugo, Victor/Série/…")
                    let author_folder = folder.unwrap_or(&name).to_string();
                    self.scan_dir(&p, &format!("{rel}/"), Some(&author_folder), out);
                }
                continue;
            }
            let Some(format) = Format::from_path(&p).filter(|f| f.kindle_native()) else {
                continue;
            };
            let stem = p
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let meta = if format.palmdb() {
                self.cached_meta(&p, &m)
            } else {
                None
            };
            let protected = meta.as_ref().is_some_and(|m| m.drm);
            let (path_title, path_author) = match folder {
                Some(a) => (stem.clone(), Some(a.to_string())),
                None => split_title(&stem),
            };
            let (title, author) = match meta.and_then(|m| m.title.map(|t| (t, m.author))) {
                Some((t, a)) if !t.is_empty() => (t, a.or(path_author)),
                _ => (path_title, path_author),
            };
            out.push(KindleBook {
                id: rel,
                title,
                author,
                format,
                size: m.len(),
                on_pc: false,
                protected,
            });
        }
    }

    pub fn kindle_books(&self, k: &Kindle) -> Vec<KindleBook> {
        let mut pc = self.pc_books();
        let mut kb = self.scan_kindle(k);
        link(&mut pc, &mut kb);
        kb
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
        let (p, f) = self.find_file(id).ok_or_else(missing)?;
        if f.palmdb() && mobi::read_meta(&p).is_some_and(|m| m.drm) {
            return Err(OpError::new(
                "protected",
                "Ce livre a été acheté sur Amazon : il ne s'ouvrirait pas chez votre ami.",
            ));
        }
        Ok(p)
    }

    pub fn overview(&self, k: Option<&Kindle>) -> Overview {
        let mut pc = self.pc_books();
        let kindle = k.map(|k| {
            let mut books = self.scan_kindle(k);
            link(&mut pc, &mut books);
            kindle_side(k.clone(), books)
        });
        Overview {
            library: self.root.clone(),
            pc,
            kindle,
        }
    }

    /// The author folder already on the Kindle for this author ("Hugo,
    /// Victor" for "Victor Hugo"), so new books join her existing folders.
    fn existing_author_folder(docs: &Path, wanted: &str) -> Option<String> {
        let (folder, _) = wanted.split_once('/')?;
        let words = authors::author_words(folder);
        fs::read_dir(docs)
            .ok()?
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .find(|n| !n.starts_with('.') && authors::author_words(n) == words)
    }

    /// A free path in `documents` for `wanted`, with " (2)"… if taken.
    fn free_kindle_rel(docs: &Path, wanted: &str) -> String {
        let wanted = match Self::existing_author_folder(docs, wanted) {
            Some(f) => format!("{f}/{}", wanted.split_once('/').map_or(wanted, |(_, r)| r)),
            None => wanted.to_string(),
        };
        if !under(docs, &wanted, "").exists() {
            return wanted;
        }
        let (stem, ext) = wanted.rsplit_once('.').unwrap_or((&wanted, ""));
        (2..)
            .map(|n| format!("{stem} ({n}).{ext}"))
            .find(|r| !under(docs, r, "").exists())
            .unwrap_or(wanted.clone())
    }

    /// Put a book from the PC onto the Kindle, in its author's folder, with
    /// its saved reading position. Never replaces a file already there.
    /// `k` must be fresh (the shell calls `kindle::find()` just before), so its
    /// `free_bytes` is the space left right now; tests pass a Kindle with a
    /// chosen free space.
    pub fn put_on_kindle(&self, id: &str, k: &Kindle) -> Result<(), OpError> {
        let mut pc = self.pc_books();
        let mut kb = self.scan_kindle(k);
        link(&mut pc, &mut kb);
        let book = pc
            .into_iter()
            .find(|b| eq_ci(&b.id, id))
            .ok_or_else(missing)?;
        if book.on_kindle {
            return Ok(());
        }
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
            self.file_of(&book.id, book.format)
        } else {
            self.cache_path(&book.id)
        };
        let needed = book.kindle_size + KINDLE_MARGIN;
        let free = k.free_bytes;
        if needed > free {
            return Err(OpError {
                code: "no_space",
                message: "Il n'y a plus assez de place sur la liseuse. Rangez d'abord un livre sur l'ordinateur.".into(),
                needed: Some(needed),
                free: Some(free),
            });
        }
        let docs = k.documents();
        let rel = Self::free_kindle_rel(&docs, &book.kindle_name);
        let dst = under(&docs, &rel, "");
        create_parent(&dst)?;
        copy_durable(&src, &dst)?;
        self.restore_position(&book.id, &dst); // a lost position must not fail the copy
        Ok(())
    }

    /// Copy the saved reading position next to the book on the Kindle,
    /// renamed after it, without replacing anything the Kindle has.
    fn restore_position(&self, id: &str, dst: &Path) {
        let (Some(dir), Some(kstem)) = (dst.parent(), dst.file_stem()) else {
            return;
        };
        let kstem = kstem.to_string_lossy();
        let sdr = under(&self.positions_dir(), id, ".sdr");
        let target = dir.join(format!("{kstem}.sdr"));
        if sdr.is_dir() && !target.exists() {
            copy_dir(&sdr, &target).ok();
        }
        for ext in SIDECARS {
            let saved = under(&self.positions_dir(), id, &format!(".{ext}"));
            let target = dir.join(format!("{kstem}.{ext}"));
            if saved.is_file() && !target.exists() {
                copy_durable(&saved, &target).ok();
            }
        }
    }

    /// Move the reading position of a book leaving the Kindle into the
    /// library, and remember where the book was.
    fn save_position(&self, id: &str, src: &Path, rel: &str) {
        let (Some(dir), Some(kstem)) = (src.parent(), src.file_stem()) else {
            return;
        };
        let kstem = kstem.to_string_lossy();
        let sdr = dir.join(format!("{kstem}.sdr"));
        if sdr.is_dir() {
            let saved = under(&self.positions_dir(), id, ".sdr");
            if saved.exists() {
                fs::remove_dir_all(&saved).ok();
            }
            if create_parent(&saved).is_ok() && copy_dir(&sdr, &saved).is_ok() {
                fs::remove_dir_all(&sdr).ok();
            }
        }
        for ext in SIDECARS {
            let side = dir.join(format!("{kstem}.{ext}"));
            if !side.is_file() {
                continue;
            }
            let saved = under(&self.positions_dir(), id, &format!(".{ext}"));
            if create_parent(&saved).is_ok() && copy_durable(&side, &saved).is_ok() {
                fs::remove_file(&side).ok();
            }
        }
        let kp = self.kindle_path_file(id);
        if create_parent(&kp).is_ok() {
            write_durable(&kp, rel.as_bytes()).ok();
        }
    }

    /// Make sure a book on the Kindle also exists on the PC (copied into
    /// its author's folder if needed). The Kindle is not changed. Returns
    /// the id of the book on the PC.
    pub fn save_to_pc(&self, kindle_file: &str, k: &Kindle) -> Result<String, OpError> {
        if !valid_rel(kindle_file) {
            return Err(missing());
        }
        let src = under(&k.documents(), kindle_file, "");
        if !src.is_file() {
            return Err(missing());
        }
        let mut pc = self.pc_books();
        let mut kb = self.scan_kindle(k);
        link(&mut pc, &mut kb);
        let book = kb
            .into_iter()
            .find(|b| eq_ci(&b.id, kindle_file))
            .ok_or_else(missing)?;
        if let Some(b) = pc.iter().find(|b| {
            b.kindle_id
                .as_deref()
                .is_some_and(|i| eq_ci(i, kindle_file))
        }) {
            return Ok(b.id.clone());
        }
        let id = self.add_path(
            &src,
            Some(&display_name(&book.title, book.author.as_deref())),
        )?;
        let copied = fs::metadata(self.file_of(&id, book.format)).map_or(0, |m| m.len());
        if copied != book.size {
            return Err(OpError::new(
                "io",
                "La copie sur l'ordinateur a échoué : le livre reste sur la liseuse.",
            ));
        }
        let kp = self.kindle_path_file(&id);
        create_parent(&kp)?;
        write_durable(&kp, book.id.as_bytes())?;
        Ok(id)
    }

    /// Take a book off the Kindle. If the PC doesn't have it yet it is saved
    /// in the library first, and only then removed from the Kindle, with its
    /// reading-position files. Returns the id of the book on the PC.
    pub fn take_from_kindle(&self, kindle_file: &str, k: &Kindle) -> Result<String, OpError> {
        let id = self.save_to_pc(kindle_file, k)?;
        let docs = k.documents();
        let src = under(&docs, kindle_file, "");
        self.save_position(&id, &src, kindle_file);
        fs::remove_file(&src)?;
        remove_empty_parents(&src, &docs);
        Ok(id)
    }

    // ------------------------------------------------------------ trash

    /// Move a book (and everything the app keeps about it) to the trash.
    pub fn delete(&self, id: &str) -> Result<String, OpError> {
        let (p, _) = self.find_file(id).ok_or_else(missing)?;
        let id = self
            .book_files()
            .into_iter()
            .find(|(bp, _, _, _)| *bp == p)
            .map(|(_, i, _, _)| i)
            .ok_or_else(missing)?;
        let (folder, stem) = match id.rsplit_once('/') {
            Some((f, s)) => (f, s),
            None => ("", id.as_str()),
        };
        let tid = format!("{}-{}", now_secs(), safe_name(stem));
        let t = self.trash_dir().join(&tid);
        fs::create_dir_all(&t)?;
        fs::write(t.join("dossier.txt"), folder)?;
        let file_name = p.file_name().ok_or_else(missing)?.to_owned();
        move_path(&p, &t.join(file_name))?;
        remove_empty_parents(&p, &self.root);
        for extra in self.extras(&id) {
            if extra.exists() {
                let name = extra.file_name().unwrap_or_default().to_string_lossy();
                move_path(&extra, &t.join(format!("meta-{name}"))).ok();
                remove_empty_parents(&extra, &self.meta_dir());
            }
        }
        Ok(tid)
    }

    pub fn restore(&self, trash_id: &str) -> Result<String, OpError> {
        if trash_id.contains(['/', '\\']) || trash_id.contains("..") || trash_id.is_empty() {
            return Err(missing());
        }
        let t = self.trash_dir().join(trash_id);
        let folder = fs::read_to_string(t.join("dossier.txt")).unwrap_or_default();
        let folder = folder.trim();
        if !folder.is_empty() && !valid_rel(folder) {
            return Err(missing());
        }
        let in_folder = |base: &Path, name: &str| {
            if folder.is_empty() {
                base.join(name)
            } else {
                under(base, &format!("{folder}/{name}"), "")
            }
        };
        let rd = fs::read_dir(&t).map_err(|_| missing())?;
        let mut book = None;
        let mut metas = Vec::new();
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name == "dossier.txt" {
                continue;
            }
            match name.strip_prefix("meta-") {
                Some(meta) => metas.push((e.path(), meta.to_string())),
                None => book = Some((e.path(), name)),
            }
        }
        let (p, name) = book.ok_or_else(missing)?;
        let dest = in_folder(&self.root, &name);
        if dest.exists() {
            return Err(OpError::new(
                "exists",
                "Un livre du même nom est déjà dans la bibliothèque.",
            ));
        }
        create_parent(&dest)?;
        move_path(&p, &dest)?;
        for (mp, meta) in metas {
            let base = if meta.ends_with(".mobi") || meta.ends_with(".error") {
                self.cache_dir()
            } else {
                self.positions_dir()
            };
            let to = in_folder(&base, &meta);
            if create_parent(&to).is_ok() {
                move_path(&mp, &to).ok();
            }
        }
        fs::remove_dir_all(&t).ok();
        let stem = Path::new(&name)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        Ok(if folder.is_empty() {
            stem
        } else {
            format!("{folder}/{stem}")
        })
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
            .filter_map(|(p, _, _, m)| {
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
