/**
 * Ma liseuse — screen logic.
 *
 * Flow: poll the Kindle every 2 s (cheap), reload the full overview only
 * when something changed, convert EPUBs in the background, and offer new
 * downloads. Every file operation goes through `run()`, one at a time, so
 * two clicks never write to the Kindle at once.
 *
 * Built for hundreds of books: compact rows, search, filters, and ticking
 * many books to load or unload them in one go.
 */

import { api } from "./js/api.js";
import { Converter } from "./js/converter.js";
import { setupGuide, setupTips } from "./js/guide.js";
import {
  LIGHT_LABEL, SUPPORTED, canGoOnKindle, coverColor, errorText, filterBooks, filterKindle, formatSize, gaugeText, plural,
  splitFileName, tripFit, tripText,
} from "./js/text.js";
import { convertEpub } from "./converter/convert.js";
import { kindle4Image } from "./converter/images.js";

const $ = (id) => document.getElementById(id);
const el = (tag, { dataset, ...props } = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  if (dataset) Object.assign(n.dataset, dataset);
  n.append(...children.filter((c) => c != null));
  return n;
};

const KINDLE_POLL_MS = 2000;
const DOWNLOADS_POLL_MS = 10000;

const state = {
  overview: { pc: [], kindle: null },
  kindleKey: null, // "root|free" of the last overview, to detect changes
  busy: false,
  filter: "all",
  query: "",
  kquery: "",
  sel: new Set(), // PC books ticked to go on the Kindle
  ksel: new Set(), // Kindle books ticked to come back
  stop: false,
  ui: { guideDone: false, tips: [] },
  offered: new Set(),
};

// ---------------------------------------------------------------- feedback

function toast(message, { kind = "", action, actionLabel, ms = 5000 } = {}) {
  const t = el("div", { className: `toast ${kind}` }, el("span", { textContent: message }));
  if (action) {
    t.append(el("button", { textContent: actionLabel, onclick: () => { t.remove(); action(); } }));
    ms = Math.max(ms, 9000);
  }
  $("toasts").append(t);
  setTimeout(() => t.remove(), ms);
}

function bigMessage(title, text, art) {
  $("bm-title").textContent = title;
  $("bm-text").textContent = text;
  $("bm-art").style.backgroundImage = art ? `url(${art})` : "none";
  $("bigmsg").hidden = false;
  $("bigmsg").querySelector("[data-close]").focus();
}

/** Run one file operation at a time; errors become a sentence. */
async function run(fn) {
  if (state.busy) {
    toast("Un instant, je termine l'opération en cours…");
    return undefined;
  }
  state.busy = true;
  render();
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(errorText(e), { kind: "error", ms: 8000 });
    return undefined;
  } finally {
    state.busy = false;
    await refresh();
  }
}

// ---------------------------------------------------------------- data

async function refresh() {
  try {
    state.overview = await api.overview();
  } catch (e) {
    console.error(e);
    return;
  }
  const k = state.overview.kindle?.kindle;
  state.kindleKey = k ? `${k.root}|${k.free_bytes}` : null;
  // forget ticks on books that moved or vanished
  const pcOk = new Set(state.overview.pc.filter(canGoOnKindle).map((b) => b.id));
  state.sel = new Set([...state.sel].filter((id) => pcOk.has(id) && k));
  const kIds = new Set((state.overview.kindle?.books || []).map((b) => b.id));
  state.ksel = new Set([...state.ksel].filter((id) => kIds.has(id)));
  render();
  converter.enqueue(state.overview.pc.filter((b) => b.converting).map((b) => b.id));
}

async function pollKindle() {
  try {
    const k = await api.kindleStatus();
    const key = k ? `${k.root}|${k.free_bytes}` : null;
    const wasOn = Boolean(state.kindleKey);
    if (key !== state.kindleKey && !state.busy) {
      await refresh();
      if (k && !wasOn) onKindleArrived();
    }
  } finally {
    setTimeout(pollKindle, KINDLE_POLL_MS);
  }
}

function onKindleArrived() {
  const d = $("k-detected");
  d.hidden = false;
  d.style.animation = "none";
  void d.offsetWidth; // replay the pop animation
  d.style.animation = "";
  setTimeout(() => tips("kindle", $("kindle")), 600);
}

async function pollDownloads() {
  try {
    const found = await api.newDownloads();
    for (const c of found) if (!state.offered.has(c.key)) offerDownload(c);
  } catch (e) {
    console.error(e);
  } finally {
    setTimeout(pollDownloads, DOWNLOADS_POLL_MS);
  }
}

function offerDownload(c) {
  state.offered.add(c.key);
  const card = el(
    "div",
    { className: "offer" },
    el("p", {}, "Nouveau livre trouvé dans vos téléchargements : ", el("b", { textContent: c.file_name })),
  );
  const done = () => { card.remove(); api.markDownloadSeen(c.key).catch(console.error); };
  card.append(
    el("button", {
      className: "btn btn-green", textContent: "L'ajouter",
      onclick: async () => {
        done();
        const id = await run(() => api.addPath(c.path));
        if (id) toast(`« ${id} » est dans votre bibliothèque.`, { kind: "ok" });
      },
    }),
    el("button", { className: "btn btn-link", textContent: "Non merci", onclick: done }),
  );
  $("offers").append(card);
}

const converter = new Converter({
  api,
  convert: convertEpub,
  processImage: kindle4Image,
  onDone: async (r) => {
    if (!r.ok && r.code === "drm") toast("Un livre est protégé contre la copie : il ne pourra pas aller sur la liseuse.", { kind: "error", ms: 8000 });
    if (!state.busy) await refresh();
  },
});

// ---------------------------------------------------------------- actions

/** Copy many books one by one with a progress bar she can stop. */
async function bulk(items, { title, step, done }) {
  state.stop = false;
  let n = 0;
  $("p-title").textContent = title;
  $("p-stop").disabled = false;
  $("progress").hidden = items.length < 2;
  const show = (label) => {
    $("p-fill").style.width = `${Math.round((n / items.length) * 100)}%`;
    $("p-text").textContent = label ? `${n + 1} sur ${items.length} : « ${label} »` : "";
  };
  try {
    await run(async () => {
      for (const it of items) {
        if (state.stop) break;
        show(it.title);
        await step(it);
        n++;
      }
      show("");
    });
  } finally {
    $("progress").hidden = true;
  }
  if (n) done(n, items.length);
}

function putOnKindle(books) {
  return bulk(books, {
    title: "Je mets les livres dans la liseuse…",
    step: (b) => api.putOnKindle(b.id),
    done: (n, total) => {
      const msg = n === 1 && total === 1 ? `« ${books[0].title} » est dans la liseuse.` : `${plural(n, "livre est", "livres sont")} dans la liseuse.`;
      toast(n < total ? `${msg} (arrêté avant la fin)` : msg, { kind: "ok", ms: 7000 });
    },
  });
}

function takeFromKindle(kbs) {
  return bulk(kbs, {
    title: "Je range les livres sur l'ordinateur…",
    step: (kb) => api.takeFromKindle(kb.id),
    done: (n, total) => {
      if (n === 1 && total === 1) {
        const where = kbs[0].on_pc ? "Il reste sur l'ordinateur" : "Il a été mis sur l'ordinateur";
        toast(`« ${kbs[0].title} » est rangé. ${where}, et votre page est gardée.`, { kind: "ok", ms: 7000 });
      } else {
        toast(`${plural(n, "livre rangé", "livres rangés")} sur l'ordinateur. Vos pages sont gardées.`, { kind: "ok", ms: 7000 });
      }
    },
  });
}

async function deleteBook(book) {
  const trashId = await run(() => api.deleteBook(book.id));
  if (!trashId) return;
  const also = book.on_kindle ? " Il reste sur la liseuse." : "";
  toast(`« ${book.title} » a été enlevé de l'ordinateur.${also}`, {
    actionLabel: "Annuler",
    action: () => run(() => api.restoreBook(trashId)),
  });
}

async function shareBook(book) {
  const ok = await run(async () => { await api.shareBook(book.id); return true; });
  if (ok) {
    bigMessage(
      "Envoyer à un ami",
      "Votre messagerie s'ouvre avec un message déjà écrit. Le livre est sélectionné dans la fenêtre « Mes livres » : faites-le glisser dans le message, puis écrivez l'adresse de votre ami(e).",
      "art/share.svg",
    );
  }
}

async function addFiles(files) {
  let added = 0;
  for (const f of files) {
    const { stem, ext } = splitFileName(f.name);
    if (!SUPPORTED.includes(ext)) {
      toast(`« ${f.name} » n'est pas un livre que la liseuse peut lire.`, { kind: "error" });
      continue;
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (await run(() => api.addBytes(stem, ext, bytes))) added++;
  }
  if (added) toast(`${plural(added, "livre ajouté", "livres ajoutés")} à votre bibliothèque.`, { kind: "ok" });
}

async function addPaths(paths) {
  let added = 0;
  for (const p of paths) if (await run(() => api.addPath(p))) added++;
  if (added) toast(`${plural(added, "livre ajouté", "livres ajoutés")} à votre bibliothèque.`, { kind: "ok" });
}

async function eject() {
  const ok = await run(async () => { await api.eject(); return true; });
  if (ok) bigMessage("C'est fini !", "Vous pouvez débrancher le câble. Vos livres apparaissent sur l'écran de la liseuse.", "art/unplug.svg");
}

// ---------------------------------------------------------------- rendering

const spine = (title) => el("div", { className: "spine", style: `background:${coverColor(title)}` });
const lightBadge = (b) => el("span", { className: `light ${b.light}`, textContent: LIGHT_LABEL[b.light], title: b.advice });

function rowAction(b, kindleOn) {
  if (b.converting) return el("span", { className: "muted small" }, el("span", { className: "spinner" }), " Préparation…");
  if (!kindleOn || b.error) return null;
  if (b.on_kindle) return el("span", { className: "badge-on", textContent: "✓ Dans la liseuse" });
  return el("button", {
    className: "btn btn-green btn-small book-action", textContent: "Mettre dans la liseuse →", disabled: state.busy,
    onclick: (e) => { e.stopPropagation(); putOnKindle([b]); },
  });
}

function renderPc() {
  const { pc, kindle } = state.overview;
  const kindleOn = Boolean(kindle);
  const onK = pc.filter((b) => b.on_kindle).length;
  $("pc-empty").hidden = pc.length > 0;
  $("pc-tools").hidden = pc.length === 0;
  $("pc-count").textContent = pc.length ? plural(pc.length, "livre") : "";

  // filters only make sense with the Kindle plugged in
  if (!kindleOn) state.filter = "all";
  $("pc-filters").hidden = !kindleOn;
  const labels = { all: `Tous (${pc.length})`, kindle: `Dans la liseuse (${onK})`, pc: `Pas dans la liseuse (${pc.length - onK})` };
  for (const c of $("pc-filters").children) {
    c.textContent = labels[c.dataset.filter];
    c.classList.toggle("on", c.dataset.filter === state.filter);
  }

  const shown = filterBooks(pc, { query: state.query, filter: state.filter });
  $("pc-none").hidden = !(pc.length && !shown.length);
  const tickable = kindleOn ? shown.filter(canGoOnKindle) : [];
  $("pc-all").hidden = tickable.length < 2;
  $("pc-all-box").checked = tickable.length > 0 && tickable.every((b) => state.sel.has(b.id));

  $("pc-list").replaceChildren(
    ...shown.map((b) => {
      const ticked = state.sel.has(b.id);
      const box = kindleOn && canGoOnKindle(b)
        ? el("input", {
          type: "checkbox", checked: ticked, title: "Cocher pour mettre dans la liseuse", ariaLabel: `Cocher ${b.title}`,
          onclick: (e) => { e.stopPropagation(); ticked ? state.sel.delete(b.id) : state.sel.add(b.id); render(); },
        })
        : null;
      const li = el(
        "li",
        { className: `row book${ticked ? " selected" : ""}`, dataset: { id: b.id } },
        box,
        spine(b.title),
        el(
          "div",
          { className: "row-text" },
          el("div", { className: "row-title", textContent: b.title }),
          el(
            "div",
            { className: "row-sub" },
            b.author ? el("span", { className: "author", textContent: b.author }) : null,
            lightBadge(b),
            b.protected ? el("span", { className: "badge-amazon", textContent: "Acheté sur Amazon", title: b.advice }) : null,
          ),
        ),
        el("div", { className: "row-act" }, rowAction(b, kindleOn)),
      );
      li.onclick = () => showDetails(b);
      return li;
    }),
  );

  // selection bar
  const selected = pc.filter((b) => state.sel.has(b.id));
  $("pc-bar").hidden = selected.length === 0;
  if (selected.length) {
    const fit = tripFit(selected, kindle?.kindle.free_bytes);
    $("pc-bar-text").textContent = tripText(fit);
    $("pc-bar-text").classList.toggle("bad", !fit.fits);
    $("pc-bar-go").disabled = !fit.fits || state.busy;
    $("pc-bar-go").textContent = `Mettre ${selected.length > 1 ? `ces ${selected.length} livres` : "ce livre"} dans la liseuse →`;
  }
}

function renderKindle() {
  const side = state.overview.kindle;
  $("kindle").classList.toggle("off", !side);
  $("k-off").hidden = Boolean(side);
  $("k-on").hidden = !side;
  $("gauge").hidden = !side;
  $("btn-eject").hidden = !side;
  $("cable").classList.toggle("on", Boolean(side));
  if (!side) {
    $("k-detected").hidden = true;
    return;
  }
  $("btn-eject").disabled = state.busy;
  $("k-count").textContent = plural(side.books.length, "livre");
  $("k-empty").hidden = side.books.length > 0;
  $("k-search").hidden = side.books.length < 8;
  const shown = filterKindle(side.books, state.kquery);
  $("k-list").replaceChildren(
    ...shown.map((kb) => {
      const ticked = state.ksel.has(kb.id);
      const toggle = () => { ticked ? state.ksel.delete(kb.id) : state.ksel.add(kb.id); render(); };
      const li = el(
        "li",
        { className: `k-item${ticked ? " selected" : ""}` },
        el("input", { type: "checkbox", checked: ticked, ariaLabel: `Cocher ${kb.title}`, onclick: (e) => { e.stopPropagation(); toggle(); } }),
        el(
          "div",
          { className: "k-text" },
          el("div", { className: "k-title", textContent: kb.title }),
          kb.author ? el("div", { className: "k-author", textContent: kb.author }) : null,
        ),
        el("button", {
          className: "btn btn-wood btn-small k-take", textContent: "← Ranger", disabled: state.busy,
          title: "Enlever de la liseuse (il reste sur l'ordinateur)",
          onclick: (e) => { e.stopPropagation(); takeFromKindle([kb]); },
        }),
      );
      li.onclick = toggle;
      return li;
    }),
  );
  const picked = side.books.filter((b) => state.ksel.has(b.id));
  $("k-bar").hidden = picked.length === 0;
  $("k-bar-text").textContent = `${plural(picked.length, "livre coché", "livres cochés")}`;
  $("k-bar-go").disabled = state.busy;
  $("gauge").className = `gauge ${side.level}`;
  $("gauge-fill").style.width = `${side.used_percent}%`;
  $("gauge-text").textContent = gaugeText(side);
}

function render() {
  renderPc();
  renderKindle();
  const first = document.querySelector(".book-action");
  if (first) tips("firstPut", first);
}

function showDetails(book) {
  $("d-cover").replaceWith(el("div", { id: "d-cover", className: "d-cover", textContent: book.title, style: `background:${coverColor(book.title)}` }));
  $("d-title").textContent = book.title;
  $("d-author").textContent = book.author || "";
  $("d-light").replaceChildren(lightBadge(book), el("br"), book.advice);
  const kSize = book.kindle_size !== book.size ? ` · sur la liseuse : ${formatSize(book.kindle_size)}` : "";
  $("d-size").textContent = `${book.format.toUpperCase()} · ${formatSize(book.size)}${kSize}`;
  const close = () => { $("details").hidden = true; };
  const actions = [];
  const side = state.overview.kindle;
  if (side && canGoOnKindle(book)) {
    actions.push(el("button", { className: "btn btn-green", textContent: "Mettre dans la liseuse →", onclick: () => { close(); putOnKindle([book]); } }));
  }
  if (side && book.on_kindle) {
    const kb = side.books.find((k) => k.id.toLowerCase() === book.kindle_name.toLowerCase());
    if (kb) actions.push(el("button", { className: "btn btn-wood", textContent: "← Enlever de la liseuse", onclick: () => { close(); takeFromKindle([kb]); } }));
  }
  if (!book.protected) {
    actions.push(el("button", { className: "btn btn-blue", textContent: "✉ Envoyer à un ami", onclick: () => { close(); shareBook(book); } }));
  }
  actions.push(el("button", { className: "btn btn-red", textContent: "Supprimer de l'ordinateur", onclick: () => { close(); deleteBook(book); } }));
  $("d-actions").replaceChildren(...actions);
  $("details").hidden = false;
}

// ---------------------------------------------------------------- setup

let tips = () => false;

async function main() {
  try {
    state.ui = { guideDone: false, tips: [], ...((await api.getUiState()) || {}) };
  } catch (e) {
    console.error(e);
  }
  const saveUi = () => api.setUiState(state.ui).catch(console.error);
  const seen = new Set(state.ui.tips || []);
  tips = setupTips(document, { seen, onSeen: (k) => { seen.add(k); state.ui.tips = [...seen]; saveUi(); } });
  const openGuide = setupGuide(document, { onClose: () => { if (!state.ui.guideDone) { state.ui.guideDone = true; saveUi(); } } });

  $("btn-help").onclick = openGuide;
  $("btn-add").onclick = () => $("file-input").click();
  $("file-input").onchange = async (e) => { const files = [...e.target.files]; e.target.value = ""; await addFiles(files); };
  $("btn-folder").onclick = () => api.openLibrary().catch((e) => toast(errorText(e), { kind: "error" }));
  $("btn-eject").onclick = eject;
  $("pc-search").oninput = (e) => { state.query = e.target.value; renderPc(); };
  $("k-search").oninput = (e) => { state.kquery = e.target.value; renderKindle(); };
  for (const c of $("pc-filters").children) c.onclick = () => { state.filter = c.dataset.filter; renderPc(); };
  $("pc-all-box").onchange = (e) => {
    const shown = filterBooks(state.overview.pc, { query: state.query, filter: state.filter }).filter(canGoOnKindle);
    for (const b of shown) e.target.checked ? state.sel.add(b.id) : state.sel.delete(b.id);
    render();
  };
  $("pc-bar-clear").onclick = () => { state.sel.clear(); render(); };
  $("pc-bar-go").onclick = () => {
    const books = state.overview.pc.filter((b) => state.sel.has(b.id));
    state.sel.clear();
    putOnKindle(books);
  };
  $("k-bar-go").onclick = () => {
    const kbs = (state.overview.kindle?.books || []).filter((b) => state.ksel.has(b.id));
    state.ksel.clear();
    takeFromKindle(kbs);
  };
  $("p-stop").onclick = () => { state.stop = true; $("p-stop").disabled = true; $("p-text").textContent = "J'arrête après ce livre…"; };
  for (const m of document.querySelectorAll(".modal")) {
    if (m.id === "progress") continue; // can't be dismissed mid-copy
    m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-close]")) m.hidden = true; });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") for (const m of document.querySelectorAll(".modal")) if (m.id !== "progress") m.hidden = true;
  });
  api.onFileDrop(addPaths, (on) => { $("drop-hint").hidden = !on; });

  await refresh();
  if (state.overview.kindle) onKindleArrived();
  if (!state.ui.guideDone) openGuide();
  setTimeout(pollKindle, KINDLE_POLL_MS);
  setTimeout(pollDownloads, 1500);
}

main();
