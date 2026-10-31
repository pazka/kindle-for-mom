/**
 * « Trouver un livre » : free, legal French books from livres.hosh.it
 * (public domain and official free catalogues), and « Demander un livre »
 * when the book isn't there. All HTTP is done by the Rust shell; this file
 * only shows pages. Covers are never loaded from the internet (strict CSP):
 * each book gets its coloured spine, like on the shelf.
 */

import { coverColor, errorText } from "./text.js";

const $ = (doc, id) => doc.getElementById(id);

export function setupFind(doc, { api, run, toast, el }) {
  const box = $(doc, "find");
  const q = $(doc, "f-query");
  const status = $(doc, "f-status");
  const list = $(doc, "f-results");
  const added = new Set(); // ids added during this session
  let page = null;
  let loading = 0;

  const say = (text, kind = "") => {
    status.textContent = text;
    status.className = `f-status ${kind}`;
    status.hidden = !text;
  };

  async function load(args, { first = false } = {}) {
    const ticket = ++loading;
    say("Je cherche…", "busy");
    list.replaceChildren();
    $(doc, "f-pager").hidden = true;
    try {
      const p = await api.catalogPage(args);
      if (ticket !== loading) return;
      page = p;
      show(first);
    } catch (e) {
      if (ticket !== loading) return;
      console.error(e);
      say(errorText(e), "bad");
    }
  }

  function show(first) {
    const p = page;
    if (p.suggestions.length) {
      $(doc, "f-suggest").replaceChildren(
        el("span", { className: "muted", textContent: "Idées : " }),
        ...p.suggestions.map((s) => el("button", {
          className: "chip", textContent: s.title, type: "button",
          onclick: () => { q.value = s.title; load({ url: s.url }); },
        })),
      );
    }
    if (first) say("");
    else if (!p.books.length) say("Je n'ai trouvé aucun livre. Essayez avec moins de mots, ou demandez-le ci-dessous.");
    else say(p.title);
    list.replaceChildren(...p.books.map(row));
    $(doc, "f-prev").hidden = !p.previous;
    $(doc, "f-next").hidden = !p.next;
    $(doc, "f-pager").hidden = !p.previous && !p.next;
    list.scrollTop = 0;
  }

  function row(b) {
    const act = el("div", { className: "row-act" });
    const setAct = () => {
      if (added.has(b.id)) act.replaceChildren(el("span", { className: "badge-on", textContent: "✓ Dans vos livres" }));
      else if (!b.download) act.replaceChildren(el("span", { className: "muted small", textContent: "Pas disponible" }));
      else {
        act.replaceChildren(el("button", {
          className: "btn btn-green btn-small", textContent: "Ajouter à mes livres", type: "button",
          onclick: async (e) => {
            e.target.disabled = true;
            e.target.replaceChildren(el("span", { className: "spinner" }), " Téléchargement…");
            const id = await run(() => api.catalogDownload(b.download.url, b.download.format, b.title, b.author));
            if (id) {
              added.add(b.id);
              toast(`« ${b.title} » est dans vos livres.`, { kind: "ok" });
            }
            setAct();
          },
        }));
      }
    };
    setAct();
    return el(
      "li",
      { className: "row f-book" },
      el("div", { className: "spine", style: `background:${coverColor(b.title)}` }),
      el(
        "div",
        { className: "row-text" },
        el("div", { className: "row-title", textContent: b.title }),
        el("div", { className: "row-sub" }, b.author ? el("span", { className: "author", textContent: b.author }) : null,
          b.source ? el("span", { textContent: b.source }) : null),
        b.description ? el("p", { className: "f-desc", textContent: b.description }) : null,
      ),
      act,
    );
  }

  // ---------------------------------------------------- « Demander un livre »

  const ask = $(doc, "f-ask");
  function openAsk() {
    $(doc, "f-ask-title").value = page?.books.length ? "" : q.value.trim();
    $(doc, "f-ask-msg").textContent = "";
    $(doc, "f-ask-cta").hidden = true;
    ask.hidden = false;
    box.firstElementChild.classList.add("asking");
    $(doc, "f-ask-title").focus();
  }
  function closeAsk() {
    ask.hidden = true;
    $(doc, "f-ask-cta").hidden = false;
    box.firstElementChild.classList.remove("asking");
  }
  ask.onsubmit = async (e) => {
    e.preventDefault();
    const title = $(doc, "f-ask-title").value.trim();
    const msg = $(doc, "f-ask-msg");
    if (title.length < 2) {
      msg.textContent = "Indiquez le titre du livre que vous cherchez.";
      msg.className = "f-status bad";
      return;
    }
    const send = $(doc, "f-ask-send");
    send.disabled = true;
    try {
      await api.catalogRequest(title, $(doc, "f-ask-author").value.trim(), $(doc, "f-ask-note").value.trim());
      ask.reset();
      closeAsk();
      say(`Votre demande pour « ${title} » est envoyée à Alexandre. Il vous dira quand le livre est prêt.`, "ok");
    } catch (err) {
      console.error(err);
      msg.textContent = errorText(err);
      msg.className = "f-status bad";
    } finally {
      send.disabled = false;
    }
  };
  $(doc, "f-ask-open").onclick = openAsk;
  $(doc, "f-ask-cancel").onclick = closeAsk;

  // ---------------------------------------------------- search

  $(doc, "f-form").onsubmit = (e) => {
    e.preventDefault();
    const query = q.value.trim();
    if (query) load({ query });
  };
  $(doc, "f-prev").onclick = () => page?.previous && load({ url: page.previous });
  $(doc, "f-next").onclick = () => page?.next && load({ url: page.next });

  return function open() {
    box.hidden = false;
    closeAsk();
    if (!page) load({}, { first: true });
    q.focus();
  };
}
