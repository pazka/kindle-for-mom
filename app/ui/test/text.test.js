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
