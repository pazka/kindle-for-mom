/**
 * EPUB 2 / EPUB 3 package reader: metadata, reading order, cover, table of
 * contents. Everything is read from the zip in memory.
 */

import { decodeEntities, elements, resolvePath, textOf, tokenize } from "./markup.js";
import { openZip } from "./zip.js";

export class BookError extends Error {
  /** @param {string} code machine-readable reason, shown translated in the UI */
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const splitHref = (href) => {
  const i = href.indexOf("#");
  return i < 0 ? [href, ""] : [href.slice(0, i), href.slice(i + 1)];
};

export async function readEpub(bytes) {
  let zip;
  try {
    zip = openZip(bytes);
  } catch (e) {
    throw new BookError("not_epub", e.message);
  }
  if (!zip.has("META-INF/container.xml")) throw new BookError("not_epub", "no META-INF/container.xml");

  const container = tokenize(await zip.text("META-INF/container.xml"));
  const rootfile = container.find((t) => t.type === "start" && t.local === "rootfile" && /oebps-package|^$/.test(t.attrs["media-type"] || ""));
  const opfPath = rootfile?.attrs["full-path"];
  if (!opfPath || !zip.has(opfPath)) throw new BookError("not_epub", "no package document");

  // DRM: Adobe ADEPT / Barnes & Noble / Apple FairPlay all encrypt the content files.
  if (zip.has("META-INF/encryption.xml")) {
    const enc = await zip.text("META-INF/encryption.xml");
    const refs = [...enc.matchAll(/<(?:\w+:)?CipherReference[^>]*URI\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
    const algos = [...enc.matchAll(/Algorithm\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
    // Font obfuscation (IDPF / Adobe) is not DRM: only fonts are "encrypted" and we drop fonts anyway.
    const onlyFonts = algos.every((a) => /idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/.test(a)) ||
      refs.every((r) => /\.(otf|ttf|woff2?)$/i.test(r));
    if (refs.length && !onlyFonts) throw new BookError("drm", "the book is DRM-protected");
  }
  if (zip.has("META-INF/rights.xml") || zip.has("sinf.xml") || zip.has("META-INF/sinf.xml")) {
    throw new BookError("drm", "the book is DRM-protected");
  }

  const opfTokens = tokenize(await zip.text(opfPath));
  const pkg = opfTokens.find((t) => t.type === "start" && t.local === "package");
  const version = pkg?.attrs.version || "2.0";

  // --- metadata -------------------------------------------------------------
  const meta = {};
  const first = (local) => elements(opfTokens, local)[0]?.text || "";
  meta.title = first("title") || "Untitled";
  meta.creators = elements(opfTokens, "creator").map((e) => e.text).filter(Boolean);
  meta.publisher = first("publisher");
  meta.language = (first("language") || "en").toLowerCase();
  meta.description = first("description").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  meta.date = first("date");
  meta.subjects = elements(opfTokens, "subject").map((e) => e.text).filter(Boolean);
  meta.isbn = elements(opfTokens, "identifier")
    .map((e) => e.text.replace(/^urn:isbn:/i, ""))
    .find((t) => /^(97[89])?\d{9}[\dXx]$/.test(t.replace(/-/g, ""))) || "";
  const metas = opfTokens.filter((t) => t.type === "start" && t.local === "meta");

  // --- manifest + spine -------------------------------------------------------
  const manifest = new Map(); // id → {id, path, type, props}
  for (const t of opfTokens) {
    if (t.type !== "start" || t.local !== "item" || !t.attrs.href) continue;
    manifest.set(t.attrs.id, {
      id: t.attrs.id,
      path: resolvePath(opfPath, t.attrs.href),
      type: (t.attrs["media-type"] || "").toLowerCase(),
      props: (t.attrs.properties || "").split(/\s+/),
    });
  }
  const spineTag = opfTokens.find((t) => t.type === "start" && t.local === "spine");
  const spine = [];
  for (const t of opfTokens) {
    if (t.type !== "start" || t.local !== "itemref") continue;
    const item = manifest.get(t.attrs.idref);
    if (!item || !zip.has(item.path)) continue;
    const isImage = item.type.startsWith("image/") && item.type !== "image/svg+xml";
    if (!isImage && !/html|xml/.test(item.type) && !/\.(x?html?|svg)$/i.test(item.path)) continue;
    spine.push({ ...item, linear: t.attrs.linear !== "no", isImage });
  }
  // non-linear items (pop-up notes …) go after the main text, as Kindle does
  spine.sort((a, b) => Number(b.linear) - Number(a.linear));
  if (!spine.length) throw new BookError("empty", "the book has no readable chapters");

  // --- cover --------------------------------------------------------------------
  let cover = [...manifest.values()].find((i) => i.props.includes("cover-image"));
  if (!cover) {
    const id = metas.find((t) => (t.attrs.name || "").toLowerCase() === "cover")?.attrs.content;
    const item = id && manifest.get(id);
    if (item && item.type.startsWith("image/")) cover = item;
  }
  if (!cover) {
    cover = [...manifest.values()].find((i) => i.type.startsWith("image/") && /cover/i.test(i.id + " " + i.path));
  }

  // --- start of the text (guide / landmarks) --------------------------------------
  let start = "";
  const guideRef = opfTokens.find((t) => t.type === "start" && t.local === "reference" && /^(text|start|bodymatter)$/i.test(t.attrs.type || ""));
  if (guideRef?.attrs.href) start = resolvePath(opfPath, guideRef.attrs.href);

  // --- table of contents ------------------------------------------------------------
  let toc = [];
  const navItem = [...manifest.values()].find((i) => i.props.includes("nav"));
  if (navItem && zip.has(navItem.path)) {
    const r = parseNav(await zip.text(navItem.path), navItem.path);
    toc = r.toc;
    if (!start && r.start) start = r.start;
  }
  if (!toc.length) {
    const ncxId = spineTag?.attrs.toc;
    const ncx = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((i) => i.type === "application/x-dtbncx+xml");
    if (ncx && zip.has(ncx.path)) toc = parseNcx(await zip.text(ncx.path), ncx.path);
  }

  return { zip, version, opfPath, meta, manifest, spine, cover, toc, start };
}

/** EPUB 3 navigation document → [{title, href, depth}] (+ the bodymatter landmark). */
export function parseNav(src, path) {
  const tokens = tokenize(src);
  const toc = [];
  let start = "";
  let k = 0;
  while (k < tokens.length) {
    const t = tokens[k];
    if (t.type === "start" && t.local === "nav") {
      const type = t.attrs["epub:type"] || t.attrs.type || t.attrs.role || "";
      let depth = 0;
      let e = k + 1;
      let navDepth = 1;
      for (; e < tokens.length && navDepth > 0; e++) {
        const u = tokens[e];
        if (u.type === "start" && u.local === "nav" && !u.selfClosing) navDepth++;
        if (u.type === "end" && u.local === "nav") navDepth--;
        if (u.type === "start" && (u.local === "ol" || u.local === "ul") && !u.selfClosing) depth++;
        if (u.type === "end" && (u.local === "ol" || u.local === "ul")) depth--;
        if (u.type === "start" && u.local === "a" && u.attrs.href && !u.selfClosing) {
          let f = e + 1;
          while (f < tokens.length && !(tokens[f].type === "end" && tokens[f].local === "a")) f++;
          const title = textOf(tokens.slice(e + 1, f));
          const href = resolveRef(path, u.attrs.href);
          if (/\btoc\b|doc-toc/.test(type) && title) toc.push({ title, href, depth: Math.max(0, depth - 1) });
          if (/landmarks/.test(type) && /bodymatter|text|start/.test(u.attrs["epub:type"] || "")) start = href;
          e = f;
        }
      }
      k = e;
      continue;
    }
    k++;
  }
  return { toc, start };
}

/** EPUB 2 NCX → [{title, href, depth}] */
export function parseNcx(src, path) {
  const tokens = tokenize(src);
  const toc = [];
  let depth = -1;
  let current = null;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === "start" && t.local === "navpoint") {
      depth++;
      current = { title: "", href: "", depth };
      toc.push(current);
    } else if (t.type === "end" && t.local === "navpoint") depth--;
    else if (t.type === "start" && t.local === "text" && current && !current.title) {
      let e = k + 1;
      while (e < tokens.length && !(tokens[e].type === "end" && tokens[e].local === "text")) e++;
      current.title = textOf(tokens.slice(k + 1, e));
      k = e;
    } else if (t.type === "start" && t.local === "content" && current && !current.href && t.attrs.src) {
      current.href = resolveRef(path, t.attrs.src);
    }
    if (t.type === "end" && t.local === "navmap") break;
  }
  return toc.filter((e) => e.title && e.href);
}

/** "text/ch1.xhtml#p3" relative to the file it is written in → "OEBPS/text/ch1.xhtml#p3" */
export function resolveRef(base, href) {
  const [file, frag] = splitHref(decodeEntities(href));
  const path = file ? resolvePath(base, file) : base;
  return frag ? `${path}#${frag}` : path;
}
