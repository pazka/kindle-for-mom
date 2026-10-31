/**
 * In-memory stand-in for the Rust core, injected as window.__TAURI__ by the
 * end-to-end tests (and usable to preview the UI in any browser).
 * It mirrors the command contract of src-tauri/src/main.rs; the real
 * behaviour of each command is tested in Rust (app/core/src/tests.rs).
 *
 * Test hooks: window.__fake.plug(), .unplug(), .addDownload(name, size),
 * .state, .calls.
 */
(() => {
  const MB = 1024 * 1024;
  const KINDLE_MARGIN = 5 * MB;
  const fake = {
    calls: [],
    listeners: {},
    state: {
      pc: [],
      kindle: null, // { total, books: [{ id, title, author, size, format }] }
      downloads: [],
      seen: new Set(),
      ui: {},
      trash: new Map(),
      update: null, // version offered by check_update
    },
  };

  const err = (code, message, extra = {}) => ({ code, message, ...extra });
  const ext = (f) => f.slice(f.lastIndexOf(".") + 1).toLowerCase();
  const splitTitle = (stem) => {
    const i = stem.lastIndexOf(" - ");
    return i > 0 ? [stem.slice(0, i), stem.slice(i + 3)] : [stem, null];
  };
  const advice = (format, size) =>
    format === "pdf"
      ? ["orange", "PDF : il s'affiche en tout petit sur la liseuse."]
      : format === "epub"
        ? ["vert", "Livre au format EPUB : il est transformé automatiquement pour la liseuse."]
        : ["vert", "Format idéal pour la liseuse : léger et confortable à lire."];

  function pcBook(stem, format, size, extra = {}) {
    const [title, author] = splitTitle(stem);
    const [light, adv] = advice(format, size);
    const native = format !== "epub";
    return {
      id: stem, file_name: `${stem}.${format}`, title, author, format, size, kindle_size: native ? size : Math.round(size * 1.3),
      light, advice: adv, ready: native, converting: !native, error: null, on_kindle: false,
      kindle_name: `${stem}.${native ? format : "mobi"}`, kindle_id: null, added: 0, protected: false, ...extra,
    };
  }

  function kindleInfo() {
    const k = fake.state.kindle;
    if (!k) return null;
    const used = k.books.reduce((s, b) => s + b.size, 0) + 20 * MB;
    return { root: "E:\\", label: "Kindle", total_bytes: k.total, free_bytes: Math.max(0, k.total - used) };
  }

  // Same book on both sides: same Kindle path, or same title + author
  // (the real rules are in core/src/library.rs `link`).
  const words = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const key = (b) => `${words(b.author).sort().join(" ")}|${words(b.title).join(" ")}`;
  function overview() {
    const info = kindleInfo();
    const kbooks = fake.state.kindle?.books || [];
    const match = (b) => kbooks.find((k) => k.id.toLowerCase() === b.kindle_name.toLowerCase() || key(k) === key(b));
    const pc = fake.state.pc.map((b) => {
      const k = match(b);
      return { ...b, on_kindle: Boolean(k), kindle_id: k ? k.id : null };
    });
    let kindle = null;
    if (info) {
      const linked = new Set(pc.map((b) => b.kindle_id).filter(Boolean));
      const books = kbooks.map((b) => ({ ...b, on_pc: linked.has(b.id) }));
      const used = Math.round(100 - (info.free_bytes * 100) / info.total_bytes);
      const freePct = 100 - used;
      const sizes = books.filter((b) => b.format !== "pdf").map((b) => b.size);
      const avg = sizes.length ? Math.min(5 * MB, Math.max(200 * 1024, sizes.reduce((a, c) => a + c, 0) / sizes.length)) : 700 * 1024;
      kindle = {
        kindle: info, books, used_percent: used,
        level: freePct < 5 ? "plein" : freePct < 15 ? "bientot" : "ok",
        books_left: Math.floor(Math.max(0, info.free_bytes - KINDLE_MARGIN) / avg),
      };
    }
    return { library: "C:\\Users\\Maman\\Documents\\Mes livres", pc, kindle };
  }

  function uniqueStem(name) {
    const taken = new Set(fake.state.pc.map((b) => b.id.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) if (!taken.has(`${name} (${n})`.toLowerCase())) return `${name} (${n})`;
  }

  const commands = {
    kindle_status: () => kindleInfo(),
    overview,
    put_on_kindle: ({ id }) => {
      const k = fake.state.kindle;
      if (!k) throw err("no_kindle", "La liseuse n'est pas branchée.");
      const b = overview().pc.find((x) => x.id === id);
      if (!b) throw err("missing", "Ce livre n'est plus là.");
      if (b.error === "drm") throw err("drm", b.advice);
      if (!b.ready) throw err("not_ready", "Ce livre est encore en préparation. Réessayez dans un instant.");
      const free = kindleInfo().free_bytes;
      if (b.kindle_size + KINDLE_MARGIN > free) {
        throw err("no_space", "Il n'y a plus assez de place sur la liseuse. Rangez d'abord un livre sur l'ordinateur.", { needed: b.kindle_size + KINDLE_MARGIN, free });
      }
      if (!b.on_kindle) k.books.push({ id: b.kindle_name, title: b.title, author: b.author, size: b.kindle_size, format: b.kindle_name.endsWith(".mobi") ? "mobi" : b.format });
      return null;
    },
    take_from_kindle: ({ file }) => {
      const id = commands.save_to_pc({ file });
      const k = fake.state.kindle;
      k.books.splice(k.books.findIndex((b) => b.id === file), 1);
      return id;
    },
    save_to_pc: ({ file }) => {
      const k = fake.state.kindle;
      if (!k) throw err("no_kindle", "La liseuse n'est pas branchée.");
      const kb = k.books.find((b) => b.id === file);
      if (!kb) throw err("missing", "Ce livre n'est plus là.");
      const linked = overview().pc.find((b) => b.kindle_id === file);
      if (linked) return linked.id;
      const stem = uniqueStem(kb.author ? `${kb.title} - ${kb.author}` : kb.title);
      fake.state.pc.push(pcBook(stem, kb.format, kb.size, { kindle_name: file }));
      return stem;
    },
    eject: () => { if (!fake.state.kindle) throw err("no_kindle", "La liseuse n'est pas branchée."); fake.ejected = true; return null; },
    add_path: ({ path }) => {
      const name = path.split(/[\\/]/).pop();
      const f = ext(name);
      if (!["epub", "mobi", "azw", "azw3", "prc", "pdf", "txt"].includes(f)) throw err("format", "Ce fichier n'est pas un livre que la liseuse peut lire.");
      const dl = fake.state.downloads.find((d) => d.path === path);
      const stem = uniqueStem(name.slice(0, name.lastIndexOf(".")));
      fake.state.pc.push(pcBook(stem, f, dl?.size || 400 * 1024));
      return stem;
    },
    add_bytes: (bytes, opts) => {
      const name = decodeURIComponent(opts.headers["x-name"]);
      const stem = uniqueStem(name);
      fake.state.pc.push(pcBook(stem, opts.headers["x-ext"], bytes.length));
      return stem;
    },
    read_book: ({ id }) => {
      const b = fake.state.pc.find((x) => x.id === id);
      if (!b) throw err("missing", "Ce livre n'est plus là.");
      return (b.bytes || new Uint8Array([1, 2, 3])).buffer;
    },
    save_kindle_copy: (bytes, opts) => {
      const b = fake.state.pc.find((x) => x.id === decodeURIComponent(opts.headers["x-id"]));
      Object.assign(b, { ready: true, converting: false, kindle_size: bytes.length || 500 * 1024 });
      return null;
    },
    save_conversion_error: ({ id, code }) => {
      const b = fake.state.pc.find((x) => x.id === id);
      Object.assign(b, { converting: false, ready: false, error: code, light: "rouge",
        advice: code === "drm" ? "Ce livre est protégé contre la copie : il ne peut pas aller sur cette liseuse." : "Ce livre n'a pas pu être transformé pour la liseuse." });
      return null;
    },
    rename_book: ({ id, name }) => {
      const b = fake.state.pc.find((x) => x.id === id);
      const stem = uniqueStem(name);
      const [title, author] = splitTitle(stem);
      Object.assign(b, { id: stem, title, author, file_name: `${stem}.${b.format}`, kindle_name: `${stem}.mobi` });
      return stem;
    },
    delete_book: ({ id }) => {
      const i = fake.state.pc.findIndex((x) => x.id === id);
      if (i < 0) throw err("missing", "Ce livre n'est plus là.");
      const tid = `t${Date.now()}${Math.random()}`;
      fake.state.trash.set(tid, fake.state.pc.splice(i, 1)[0]);
      return tid;
    },
    restore_book: ({ trashId }) => {
      const b = fake.state.trash.get(trashId);
      fake.state.trash.delete(trashId);
      fake.state.pc.push(b);
      return b.id;
    },
    new_downloads: () => fake.state.downloads.filter((d) => !fake.state.seen.has(d.key)),
    mark_download_seen: ({ key }) => { fake.state.seen.add(key); return null; },
    get_ui_state: () => fake.state.ui,
    set_ui_state: ({ ui }) => { fake.state.ui = ui; return null; },
    open_library: () => null,
    check_update: () => (fake.state.update ? { current: "0.2.0", version: fake.state.update } : null),
    install_update: () => { fake.installed = fake.state.update; return new Promise(() => {}); }, // the real app closes here
    sort_author: ({ name }) => (name.includes(",") ? name : name.replace(/^(.*) (\S+)$/, "$2, $1")),
    share_book: ({ id }) => { if (!fake.state.pc.some((b) => b.id === id)) throw err("missing", "Ce livre n'est plus là."); fake.shared = id; return null; },
  };

  async function invoke(cmd, args, opts) {
    fake.calls.push(cmd);
    await new Promise((r) => setTimeout(r, 5));
    if (!commands[cmd]) throw err("unknown", `commande inconnue ${cmd}`);
    const out = await commands[cmd](args || {}, opts);
    return out === undefined ? null : structuredClone(out);
  }

  fake.plug = (total = 1400 * MB) => { fake.state.kindle ??= { total, books: [] }; fake.state.kindle.total = total; fake.ejected = false; };
  fake.unplug = () => { fake.state.kindle = null; };
  fake.addDownload = (name, size = 600 * 1024) => {
    fake.state.downloads.push({ path: `C:\\Users\\Maman\\Downloads\\${name}`, file_name: name, size, format: ext(name), key: `${name.toLowerCase()}|${size}` });
  };
  fake.addPcBook = (stem, format, size, extra) => fake.state.pc.push(pcBook(stem, format, size, extra));
  fake.addKindleBook = (id, title, author, size = 600 * 1024, format = "mobi") => fake.state.kindle.books.push({ id, title, author, size, format });
  fake.drop = (paths) => (fake.listeners["tauri://drag-drop"] || []).forEach((cb) => cb({ payload: { paths } }));

  window.__fake = fake;
  window.__TAURI__ = {
    core: { invoke },
    event: {
      listen: async (name, cb) => {
        (fake.listeners[name] ||= []).push(cb);
        return () => {};
      },
    },
  };
})();
