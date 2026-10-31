import assert from "node:assert/strict";
import { test } from "node:test";
import { bookName, coverColor, errorText, formatSize, gaugeText, plural, shouldRename, splitFileName, tripFit, tripText } from "../js/text.js";

const nb = (s) => s.replace(/ | /g, " ");

test("sizes are in French units", () => {
  assert.equal(nb(formatSize(500)), "1 Ko");
  assert.equal(nb(formatSize(850 * 1024)), "850 Ko");
  assert.equal(nb(formatSize(1.25 * 1024 * 1024)), "1,3 Mo");
  assert.equal(nb(formatSize(1.4 * 1024 ** 3)), "1,4 Go");
});

test("plural", () => {
  assert.equal(plural(0, "livre"), "0 livre");
  assert.equal(plural(1, "livre"), "1 livre");
  assert.equal(plural(3, "livre ajouté", "livres ajoutés"), "3 livres ajoutés");
});

test("book names and renaming rule", () => {
  assert.equal(bookName({ title: " Candide ", creators: ["Voltaire"] }), "Candide - Voltaire");
  assert.equal(bookName({ title: "Candide", creators: [] }), "Candide");
  assert.equal(bookName({}), "");
  assert.equal(shouldRename("pg4650-images", "Candide - Voltaire"), true);
  assert.equal(shouldRename("Mon livre - Moi", "Candide - Voltaire"), false, "a name with an author is kept");
  assert.equal(shouldRename("candide - voltaire", "Candide - Voltaire"), false);
  assert.equal(shouldRename("Voltaire/Candide", "Candide - Voltaire"), false, "already in its author folder");
  assert.equal(shouldRename("x", ""), false);
  assert.equal(shouldRename("x", "Livre"), false);
});

test("gauge sentence by level", () => {
  assert.match(gaugeText({ level: "ok", books_left: 120 }), /^Encore de la place pour environ 120 livres\.$/);
  assert.match(gaugeText({ level: "ok", books_left: 5000 }), /beaucoup de place/);
  assert.match(gaugeText({ level: "bientot", books_left: 14 }), /^Bientôt pleine : encore de la place pour environ 14 livres\.$/);
  assert.match(gaugeText({ level: "plein", books_left: 0 }), /pleine.*Rangez/);
  assert.equal(gaugeText(null), "");
});

test("trip fit keeps the same margin as the Rust core", () => {
  const MB = 1024 * 1024;
  const books = [{ kindle_size: 10 * MB }, { kindle_size: 10 * MB }];
  assert.equal(tripFit(books, 25 * MB).fits, true);
  const tight = tripFit(books, 24 * MB);
  assert.equal(tight.fits, false);
  assert.equal(tight.missing, 1 * MB);
  assert.match(tripText(tripFit([], 1)), /Cochez/);
  assert.match(tripText(tight), /il manque/);
});

test("errors always become a sentence", () => {
  assert.equal(errorText({ code: "no_space", message: "Plus de place." }), "Plus de place.");
  assert.match(errorText(new Error("boom")), /Réessayez/);
  assert.match(errorText("x"), /Réessayez/);
});

test("misc", () => {
  assert.equal(coverColor("Germinal"), coverColor("Germinal"));
  assert.deepEqual(splitFileName("Le Rouge et le Noir.EPUB"), { stem: "Le Rouge et le Noir", ext: "epub" });
  assert.deepEqual(splitFileName(".hidden"), { stem: ".hidden", ext: "" });
});

import { canGoOnKindle, filterBooks, filterKindle, fold } from "../js/text.js";

test("search ignores accents and case, and combines words", () => {
  const books = [
    { title: "Germinal", author: "Émile Zola", on_kindle: true },
    { title: "Nana", author: "Émile Zola", on_kindle: false },
    { title: "Candide", author: "Voltaire", on_kindle: false },
  ];
  assert.equal(fold("Émile"), "emile");
  assert.deepEqual(filterBooks(books, { query: "emile" }).map((b) => b.title), ["Germinal", "Nana"]);
  assert.deepEqual(filterBooks(books, { query: "zola nana" }).map((b) => b.title), ["Nana"]);
  assert.deepEqual(filterBooks(books, { filter: "kindle" }).map((b) => b.title), ["Germinal"]);
  assert.deepEqual(filterBooks(books, { filter: "pc", query: "VOLT" }).map((b) => b.title), ["Candide"]);
  assert.equal(filterBooks(books).length, 3);
  assert.deepEqual(filterKindle([{ title: "Le Petit Prince", author: "Saint-Exupéry" }], "exupery").length, 1);
});

test("only ready books not yet on the Kindle can be ticked", () => {
  assert.equal(canGoOnKindle({ ready: true, error: null, on_kindle: false }), true);
  assert.equal(canGoOnKindle({ ready: false, error: null, on_kindle: false }), false);
  assert.equal(canGoOnKindle({ ready: true, error: "drm", on_kindle: false }), false);
  assert.equal(canGoOnKindle({ ready: true, error: null, on_kindle: true }), false);
});
