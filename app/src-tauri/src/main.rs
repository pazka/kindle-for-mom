// No console window behind the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Thin Tauri shell: every command forwards to `liseuse-core`.
//! Binary payloads (books) travel raw over IPC, never as JSON arrays.

use liseuse_core::formats::Format;
use liseuse_core::kindle::{self, Kindle};
use liseuse_core::library::{DownloadCandidate, Library, OpError, Overview};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Manager, State};

/// Books bigger than this are refused (nobody's novel is 300 MB).
const MAX_BOOK: u64 = 300 * 1024 * 1024;

struct App {
    lib: Library,
    downloads: Option<PathBuf>,
    kindle: Mutex<Option<Kindle>>,
}

type Res<T> = Result<T, OpError>;

fn no_kindle() -> OpError {
    OpError::new("no_kindle", "La liseuse n'est pas branchée.")
}

fn current_kindle(app: &App) -> Res<Kindle> {
    let found = kindle::find();
    *app.kindle.lock().unwrap() = found.clone();
    found.ok_or_else(no_kindle)
}

fn raw_body(req: &Request<'_>) -> Res<Vec<u8>> {
    match req.body() {
        InvokeBody::Raw(b) => Ok(b.clone()),
        _ => Err(OpError::new("bad_request", "Données invalides.")),
    }
}

fn header(req: &Request<'_>, name: &str) -> Res<String> {
    let v = req
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| OpError::new("bad_request", "Données invalides."))?;
    Ok(percent_decode(v))
}

/// Header values are sent with encodeURIComponent (accents in titles).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Only ebook files, of a sane size, may be read from outside the library
/// (dropped files and downloads).
fn check_outside_file(path: &Path) -> Res<Format> {
    let f = Format::from_path(path).ok_or_else(|| {
        OpError::new(
            "format",
            "Ce fichier n'est pas un livre que la liseuse peut lire.",
        )
    })?;
    let m = std::fs::metadata(path)
        .map_err(|_| OpError::new("missing", "Ce fichier n'est plus là."))?;
    if !m.is_file() || m.len() > MAX_BOOK {
        return Err(OpError::new(
            "too_big",
            "Ce fichier est trop gros pour être un livre.",
        ));
    }
    Ok(f)
}

// ---------------------------------------------------------------- commands

/// Cheap: is the Kindle plugged in, and how much room is left?
#[tauri::command]
async fn kindle_status(app: State<'_, App>) -> Res<Option<Kindle>> {
    let found = kindle::find();
    *app.kindle.lock().unwrap() = found.clone();
    Ok(found)
}

/// Everything the screen shows (reads book titles; call after changes only).
#[tauri::command]
async fn overview(app: State<'_, App>) -> Res<Overview> {
    let k = kindle::find();
    *app.kindle.lock().unwrap() = k.clone();
    Ok(app.lib.overview(k.as_ref()))
}

#[tauri::command]
async fn put_on_kindle(app: State<'_, App>, id: String) -> Res<()> {
    let k = current_kindle(&app)?;
    app.lib.put_on_kindle(&id, &k)
}

#[tauri::command]
async fn take_from_kindle(app: State<'_, App>, file: String) -> Res<String> {
    let k = current_kindle(&app)?;
    app.lib.take_from_kindle(&file, &k)
}

#[tauri::command]
async fn eject(app: State<'_, App>) -> Res<()> {
    let k = current_kindle(&app)?;
    kindle::eject(&k).map_err(|e| {
        OpError::new(
            "eject",
            format!("La liseuse n'a pas pu être éjectée ({e})."),
        )
    })
}

/// Add a book from a path (dropped file or download).
#[tauri::command]
async fn add_path(app: State<'_, App>, path: String) -> Res<String> {
    let p = PathBuf::from(path);
    check_outside_file(&p)?;
    app.lib.add_path(&p, None)
}

/// Add a book from bytes (file picker). Headers: x-name, x-ext.
#[tauri::command]
async fn add_bytes(app: State<'_, App>, request: Request<'_>) -> Res<String> {
    let bytes = raw_body(&request)?;
    let name = header(&request, "x-name")?;
    let f = Format::from_ext(&header(&request, "x-ext")?).ok_or_else(|| {
        OpError::new(
            "format",
            "Ce fichier n'est pas un livre que la liseuse peut lire.",
        )
    })?;
    if bytes.len() as u64 > MAX_BOOK {
        return Err(OpError::new(
            "too_big",
            "Ce fichier est trop gros pour être un livre.",
        ));
    }
    app.lib.add_bytes(&name, f, &bytes)
}

#[tauri::command]
async fn read_book(app: State<'_, App>, id: String) -> Res<Response> {
    Ok(Response::new(app.lib.read_book(&id)?))
}

/// Header: x-id. Body: the converted MOBI.
#[tauri::command]
async fn save_kindle_copy(app: State<'_, App>, request: Request<'_>) -> Res<()> {
    let id = header(&request, "x-id")?;
    app.lib.save_kindle_copy(&id, &raw_body(&request)?)
}

#[tauri::command]
async fn save_conversion_error(app: State<'_, App>, id: String, code: String) -> Res<()> {
    app.lib.save_conversion_error(&id, &code)
}

#[tauri::command]
async fn rename_book(app: State<'_, App>, id: String, name: String) -> Res<String> {
    app.lib.rename(&id, &name)
}

#[tauri::command]
async fn delete_book(app: State<'_, App>, id: String) -> Res<String> {
    app.lib.delete(&id)
}

#[tauri::command]
async fn restore_book(app: State<'_, App>, trash_id: String) -> Res<String> {
    app.lib.restore(&trash_id)
}

#[tauri::command]
async fn new_downloads(app: State<'_, App>) -> Res<Vec<DownloadCandidate>> {
    let Some(dl) = &app.downloads else {
        return Ok(vec![]);
    };
    Ok(app.lib.new_downloads(dl, &app.lib.load_state()))
}

/// Remember a download was offered (accepted or refused) so it isn't offered again.
#[tauri::command]
async fn mark_download_seen(app: State<'_, App>, key: String) -> Res<()> {
    let mut s = app.lib.load_state();
    if !s.downloads_seen.contains(&key) {
        s.downloads_seen.push(key);
        if s.downloads_seen.len() > 2000 {
            s.downloads_seen.drain(..500);
        }
    }
    app.lib.save_state(&s).map_err(OpError::from)
}

#[tauri::command]
async fn get_ui_state(app: State<'_, App>) -> Res<serde_json::Value> {
    Ok(app.lib.load_state().ui)
}

#[tauri::command]
async fn set_ui_state(app: State<'_, App>, ui: serde_json::Value) -> Res<()> {
    let mut s = app.lib.load_state();
    s.ui = ui;
    app.lib.save_state(&s).map_err(OpError::from)
}

/// Show the library folder in File Explorer.
#[tauri::command]
async fn open_library(app: State<'_, App>) -> Res<()> {
    let root = app.lib.root().to_path_buf();
    #[cfg(windows)]
    let cmd = "explorer.exe";
    #[cfg(not(windows))]
    let cmd = "xdg-open";
    std::process::Command::new(cmd)
        .arg(root)
        .spawn()
        .map(|_| ())
        .map_err(OpError::from)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let docs = app
                .path()
                .document_dir()
                .unwrap_or_else(|_| app.path().home_dir().unwrap_or_default());
            let root = std::env::var_os("LISEUSE_LIBRARY")
                .map(PathBuf::from)
                .unwrap_or_else(|| docs.join("Mes livres"));
            let lib = Library::open(root)?;
            let downloads = app.path().download_dir().ok();
            app.manage(App {
                lib,
                downloads,
                kindle: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            kindle_status,
            overview,
            put_on_kindle,
            take_from_kindle,
            eject,
            add_path,
            add_bytes,
            read_book,
            save_kindle_copy,
            save_conversion_error,
            rename_book,
            delete_book,
            restore_book,
            new_downloads,
            mark_download_seen,
            get_ui_state,
            set_ui_state,
            open_library,
        ])
        .run(tauri::generate_context!())
        .expect("Ma liseuse n'a pas pu démarrer");
}
