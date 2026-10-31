/**
 * The only file that talks to the Rust core. Every other module gets `api`
 * injected, so tests swap it for a fake (ui/test/fake-backend.js).
 * Argument names are camelCase here; Tauri maps them to snake_case.
 */

const core = () => window.__TAURI__.core;
const invoke = (cmd, args, opts) => core().invoke(cmd, args, opts);
const enc = (s) => encodeURIComponent(s);

export const api = {
  kindleStatus: () => invoke("kindle_status"),
  overview: () => invoke("overview"),
  putOnKindle: (id) => invoke("put_on_kindle", { id }),
  takeFromKindle: (file) => invoke("take_from_kindle", { file }),
  saveToPc: (file) => invoke("save_to_pc", { file }),
  eject: () => invoke("eject"),
  addPath: (path) => invoke("add_path", { path }),
  addBytes: (name, ext, bytes) => invoke("add_bytes", bytes, { headers: { "x-name": enc(name), "x-ext": ext } }),
  readBook: async (id) => new Uint8Array(await invoke("read_book", { id })),
  saveKindleCopy: (id, mobi) => invoke("save_kindle_copy", mobi, { headers: { "x-id": enc(id) } }),
  saveConversionError: (id, code) => invoke("save_conversion_error", { id, code }),
  renameBook: (id, name) => invoke("rename_book", { id, name }),
  sortAuthor: (name) => invoke("sort_author", { name }),
  deleteBook: (id) => invoke("delete_book", { id }),
  restoreBook: (trashId) => invoke("restore_book", { trashId }),
  newDownloads: () => invoke("new_downloads"),
  markDownloadSeen: (key) => invoke("mark_download_seen", { key }),
  getUiState: () => invoke("get_ui_state"),
  setUiState: (ui) => invoke("set_ui_state", { ui }),
  openLibrary: () => invoke("open_library"),
  shareBook: (id) => invoke("share_book", { id }),
  /** {current, version} when another signed version should run here, else null. */
  checkUpdate: () => invoke("check_update"),
  installUpdate: () => invoke("install_update"),
  /** Files dropped from File Explorer: cb(paths), plus hover in/out. */
  onFileDrop(cb, hover) {
    const ev = window.__TAURI__.event;
    ev.listen("tauri://drag-drop", (e) => { hover?.(false); cb(e.payload?.paths || []); });
    ev.listen("tauri://drag-enter", () => hover?.(true));
    ev.listen("tauri://drag-leave", () => hover?.(false));
  },
};
