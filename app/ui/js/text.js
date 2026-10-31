/**
 * Pure helpers: wording, sizes, colours. No DOM, no backend, so they are
 * unit-tested in Node (ui/test/text.test.js).
 */

/** "1,2 Mo", "850 Ko", "1,4 Go" (French units and decimal comma). */
export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  const fmt = (v, unit) => `${v.toLocaleString("fr-FR", { maximumFractionDigits: v < 10 ? 1 : 0 })} ${unit}`;
  if (n < 1024 * 1024) return fmt(Math.max(1, Math.round(n / 1024)), "Ko");
  if (n < 1024 * 1024 * 1024) return fmt(n / (1024 * 1024), "Mo");
  return fmt(n / (1024 * 1024 * 1024), "Go");
}

/** plural(3, "livre") → "3 livres" */
export function plural(n, word, pluralWord = `${word}s`) {
  return `${n.toLocaleString("fr-FR")} ${n > 1 ? pluralWord : word}`;
}

export const LIGHT_LABEL = { vert: "Parfait", orange: "Lourd ou peu lisible", rouge: "Impossible sur la liseuse" };

const COVERS = ["#8c3b2e", "#2f5d7c", "#3d6b45", "#7a5c1e", "#5b3f7a", "#8a4f2a", "#2e6b6b", "#6b2e4f", "#4a5a2a", "#33456b"];

/** Stable cover colour for a title. */
export function coverColor(title) {
  let h = 0;
  for (const c of String(title)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return COVERS[h % COVERS.length];
}

/** "Titre - Auteur" from converter metadata (same rule as the Rust side). */
export function bookName(meta) {
  const title = String(meta?.title || "").trim();
  const author = String(meta?.creators?.[0] || "").trim();
  if (!title) return "";
  return author ? `${title} - ${author}` : title;
}

/**
 * After converting an EPUB, rename it to "Titre - Auteur" unless its file
 * name already reads like one (Mom or Pazka named it on purpose) or it is
 * already in an author folder.
 */
export function shouldRename(id, wanted) {
  if (!wanted || wanted.toLowerCase() === "livre") return false;
  if (id.includes(" - ") || id.includes("/")) return false; // "Auteur/Titre" is already filed
  return id.toLowerCase() !== wanted.toLowerCase();
}

/** Sentence under the Kindle's fill gauge. */
export function gaugeText(side) {
  if (!side) return "";
  if (side.level === "plein") return "La liseuse est pleine. Rangez quelques livres sur l'ordinateur pour faire de la place.";
  const left = side.books_left;
  const room = left > 1000 ? "Encore beaucoup de place" : `Encore de la place pour environ ${plural(left, "livre")}`;
  return side.level === "bientot" ? `Bientôt pleine : ${room.charAt(0).toLowerCase()}${room.slice(1)}.` : `${room}.`;
}

/**
 * Do these books fit on the Kindle? `margin` mirrors KINDLE_MARGIN in Rust.
 * @returns {{ count:number, bytes:number, fits:boolean, missing:number }}
 */
export function tripFit(books, freeBytes, margin = 5 * 1024 * 1024) {
  const bytes = books.reduce((s, b) => s + (b.kindle_size || 0), 0);
  const avail = Math.max(0, (freeBytes || 0) - margin);
  return { count: books.length, bytes, fits: bytes <= avail, missing: Math.max(0, bytes - avail) };
}

export function tripText(fit) {
  if (!fit.count) return "Cochez les livres à emporter.";
  const what = `${plural(fit.count, "livre")} · ${formatSize(fit.bytes)}`;
  return fit.fits ? `${what} — ça rentre ✓` : `${what} — il manque ${formatSize(fit.missing)} de place`;
}

/** A sentence for any error coming back from the app's core. */
export function errorText(err) {
  if (err && typeof err === "object" && typeof err.message === "string" && err.code) return err.message;
  return "Quelque chose n'a pas marché. Réessayez, et si ça recommence, prévenez Alexandre.";
}

/** File extension (lowercase, no dot) and name without extension. */
export function splitFileName(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? { stem: name.slice(0, i), ext: name.slice(i + 1).toLowerCase() } : { stem: name, ext: "" };
}

export const SUPPORTED = ["epub", "mobi", "azw", "azw3", "prc", "pdf", "txt"];

/** Lowercase without accents, for forgiving search ("emile" finds "Émile"). */
export function fold(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Books shown in the computer list.
 * @param {"all"|"kindle"|"pc"} filter  all / on the Kindle / not on the Kindle
 */
export function filterBooks(books, { query = "", filter = "all" } = {}) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return books.filter((b) => {
    if (filter === "kindle" && !b.on_kindle) return false;
    if (filter === "pc" && b.on_kindle) return false;
    const hay = fold(`${b.title} ${b.author || ""}`);
    return words.every((w) => hay.includes(w));
  });
}

/** Kindle books matching a search. */
export function filterKindle(books, query = "") {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return books.filter((b) => words.every((w) => fold(`${b.title} ${b.author || ""}`).includes(w)));
}

/** A PC book that can be ticked to go on the Kindle. */
export const canGoOnKindle = (b) => b.ready && !b.error && !b.on_kindle;
