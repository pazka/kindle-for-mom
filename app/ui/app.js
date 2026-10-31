/**
 * Ma liseuse — screen logic.
 *
 * Flow: poll the Kindle every 2 s (cheap), reload the full overview only
 * when something changed, convert EPUBs in the background, and offer new
 * downloads. Every file operation goes through `run()`, one at a time, so
 * two clicks never write to the Kindle at once.
 */

import { api } from "./js/api.js";
import { Converter } from "./js/converter.js";
import { setupGuide, setupTips } from "./js/guide.js";
import {
  LIGHT_LABEL, SUPPORTED, coverColor, errorText, formatSize, gaugeText, plural, splitFileName, tripFit, tripText,
} from "./js/text.js";
import { convertEpub } from "./converter/convert.js";
import { kindleImage } from "./converter/images.js";

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
  trip: null, // Set of selected ids while preparing a trip
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
  document.body.classList.add("busy");
  render();
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(errorText(e), { kind: "error", ms: 8000 });
    return undefined;
  } finally {
    state.busy = false;
    document.body.classList.remove("busy");
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
  $("k-detected").hidden = false;
  $("k-detected").style.animation = "none";
  void $("k-detected").offsetWidth; // replay the pop animation
  $("k-detected").style.animation = "";
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
  processImage: kindleImage,
  onDone: async (r) => {
    if (!r.ok && r.code === "drm") toast("Un livre est protégé contre la copie : il ne pourra pas aller sur la liseuse.", { kind: "error", ms: 8000 });
    if (!state.busy) await refresh();
  },
});

// ---------------------------------------------------------------- actions

async function putOnKindle(book) {
  const ok = await run(async () => { await api.putOnKindle(book.id); return true; });
  if (ok) toast(`« ${book.title} » est dans la liseuse.`, { kind: "ok" });
}

async function takeFromKindle(kb) {
  const id = await run(() => api.takeFromKindle(kb.id));
  if (id) {
    const where = kb.on_pc ? "Il reste sur l'ordinateur" : "Il a été mis sur l'ordinateur";
    toast(`« ${kb.title} » est rangé. ${where}, et votre page est gardée.`, { kind: "ok", ms: 7000 });
  }
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

async function startTripTransfer() {
  const k = state.overview.kindle;
  const books = state.overview.pc.filter((b) => state.trip.has(b.id));
  const fit = tripFit(books, k?.kindle.free_bytes);
  if (!fit.fits) return;
  state.trip = null;
  let n = 0;
  await run(async () => {
    for (const b of books) {
      await api.putOnKindle(b.id);
      n++;
      toast(`${n} / ${books.length} : « ${b.title} »`, { ms: 2500 });
    }
  });
  if (n === books.length) toast(`Bon voyage ! ${plural(n, "livre est", "livres sont")} dans la liseuse.`, { kind: "ok", ms: 7000 });
}

// ---------------------------------------------------------------- rendering

function cover(book, cls = "cover") {
  return el("div", { className: cls, textContent: book.title, style: `background:${coverColor(book.title)}` });
}

function lightBadge(book) {
  return el("span", { className: `light ${book.light}`, textContent: LIGHT_LABEL[book.light], title: book.advice });
}

function pcAction(book, kindleOn) {
  if (book.converting) return el("span", { className: "muted small" }, el("span", { className: "spinner" }), " Préparation…");
  if (book.error || !kindleOn) return null;
  if (book.on_kindle) return el("span", { className: "badge-on", textContent: "✓ Dans la liseuse" });
  return el("button", {
    className: "btn btn-green btn-small book-action", textContent: "Mettre dans la liseuse →", disabled: state.busy,
    onclick: (e) => { e.stopPropagation(); putOnKindle(book); },
  });
}

function renderPc() {
  const { pc, kindle } = state.overview;
  const kindleOn = Boolean(kindle);
  $("pc-empty").hidden = pc.length > 0;
  $("pc-count").textContent = pc.length ? plural(pc.length, "livre") : "";
  const tripping = Boolean(state.trip);
  $("pc-list").replaceChildren(
    ...pc.map((b) => {
      const selectable = tripping && b.ready && !b.on_kindle && !b.error;
      const li = el(
        "li",
        { className: `book${tripping && state.trip.has(b.id) ? " selected" : ""}`, dataset: { id: b.id } },
        cover(b),
        el(
          "div",
          { className: "book-info" },
          el("span", { className: "book-title", textContent: b.title }),
          b.author ? el("span", { className: "book-author", textContent: b.author }) : null,
          lightBadge(b),
          tripping && b.on_kindle ? el("span", { className: "badge-on", textContent: "✓ Déjà dans la liseuse" }) : null,
        ),
        selectable ? el("span", { className: "check", "aria-hidden": "true" }) : null,
      );
      const action = tripping ? null : pcAction(b, kindleOn);
      if (action) li.append(el("div", { className: "book-foot" }, action));
      li.onclick = () => {
        if (!tripping) return showDetails(b);
        if (!selectable) return;
        state.trip.has(b.id) ? state.trip.delete(b.id) : state.trip.add(b.id);
        render();
      };
      return li;
    }),
  );
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
  $("k-list").replaceChildren(
    ...side.books.map((kb) =>
      el(
        "li",
        { className: "k-item" },
        el(
          "div",
          { className: "k-text" },
          el("div", { className: "k-title", textContent: kb.title }),
          kb.author ? el("div", { className: "k-author", textContent: kb.author }) : null,
        ),
        el("button", {
          className: "btn btn-wood btn-small", textContent: "← Ranger", disabled: state.busy, title: "Enlever de la liseuse (il reste sur l'ordinateur)",
          onclick: () => takeFromKindle(kb),
        }),
      ),
    ),
  );
  $("gauge").className = `gauge ${side.level}`;
  $("gauge-fill").style.width = `${side.used_percent}%`;
  $("gauge-text").textContent = gaugeText(side);
}

function renderTrip() {
  const side = state.overview.kindle;
  const canTrip = Boolean(side) && state.overview.pc.some((b) => b.ready && !b.on_kindle && !b.error);
  $("trip-start").hidden = Boolean(state.trip) || !canTrip;
  $("trip").hidden = !state.trip;
  if (!state.trip) return;
  if (!side) { state.trip = null; return renderTrip(); }
  const books = state.overview.pc.filter((b) => state.trip.has(b.id));
  const fit = tripFit(books, side.kindle.free_bytes);
  $("trip-info").textContent = tripText(fit);
  $("trip-info").classList.toggle("bad", fit.count > 0 && !fit.fits);
  $("trip-go").disabled = !fit.count || !fit.fits || state.busy;
}

function render() {
  renderPc();
  renderKindle();
  renderTrip();
  const first = document.querySelector(".book-action");
  if (first) tips("firstPut", first);
}

function showDetails(book) {
  $("d-cover").replaceWith(Object.assign(cover(book, "d-cover"), { id: "d-cover" }));
  $("d-title").textContent = book.title;
  $("d-author").textContent = book.author || "";
  $("d-light").replaceChildren(lightBadge(book), el("br"), book.advice);
  const kSize = book.kindle_size !== book.size ? ` · sur la liseuse : ${formatSize(book.kindle_size)}` : "";
  $("d-size").textContent = `${book.format.toUpperCase()} · ${formatSize(book.size)}${kSize}`;
  const close = () => { $("details").hidden = true; };
  const actions = [];
  const kindleOn = Boolean(state.overview.kindle);
  if (kindleOn && book.ready && !book.on_kindle && !book.error) {
    actions.push(el("button", { className: "btn btn-green", textContent: "Mettre dans la liseuse →", onclick: () => { close(); putOnKindle(book); } }));
  }
  if (kindleOn && book.on_kindle) {
    const kb = state.overview.kindle.books.find((k) => k.id.toLowerCase() === book.kindle_name.toLowerCase());
    if (kb) actions.push(el("button", { className: "btn btn-wood", textContent: "← Enlever de la liseuse", onclick: () => { close(); takeFromKindle(kb); } }));
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
  $("trip-start").onclick = () => { state.trip = new Set(); render(); };
  $("trip-cancel").onclick = () => { state.trip = null; render(); };
  $("trip-go").onclick = startTripTransfer;
  for (const m of document.querySelectorAll(".modal")) {
    m.addEventListener("click", (e) => { if (e.target === m || e.target.closest("[data-close]")) m.hidden = true; });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") for (const m of document.querySelectorAll(".modal")) m.hidden = true;
  });
  api.onFileDrop(addPaths, (on) => { $("drop-hint").hidden = !on; });

  await refresh();
  if (state.overview.kindle) onKindleArrived();
  if (!state.ui.guideDone) openGuide();
  setTimeout(pollKindle, KINDLE_POLL_MS);
  setTimeout(pollDownloads, 1500);
}

main();
