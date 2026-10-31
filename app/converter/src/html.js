/**
 * XHTML chapter → the HTML dialect of MOBI 6 (what Kindle 1–4, Keyboard,
 * Touch and DX read): plain HTML 3-ish tags, no CSS, <mbp:pagebreak/>,
 * links as <a filepos=NNNNNNNNNN> (byte offsets in the final text) and images
 * as <img recindex="NNNNN">. Output goes to a Builder so that link offsets
 * can be filled once every anchor position is known.
 */

import { computeStyle, parseCss } from "./css.js";
import { decodeEntities, escapeAttr, escapeText, resolvePath, tokenize } from "./markup.js";
import { resolveRef } from "./epub.js";

const enc = new TextEncoder();
const LINK_OPEN_LEN = '<a filepos=0000000000>'.length;

/** Collects output pieces; links/anchors are resolved in finish(). */
export class Builder {
  constructor() {
    this.parts = [];
  }
  text(s) {
    if (s) this.parts.push(s);
  }
  anchor(key) {
    this.parts.push({ anchor: key });
  }
  /** opening <a> pointing at an anchor key (file path, or path#id) */
  link(key) {
    this.parts.push({ link: key });
  }
  /** a bare filepos=NNNNNNNNNN attribute (for <reference>) */
  filepos(key) {
    this.parts.push({ filepos: key });
  }
  /** @returns {{bytes: Uint8Array, anchors: Map<string, number>, broken: number}} */
  finish() {
    const chunks = [];
    const anchors = new Map();
    let pos = 0;
    for (const p of this.parts) {
      if (typeof p === "string") {
        const b = enc.encode(p);
        chunks.push(b);
        pos += b.length;
      } else if (p.anchor !== undefined) {
        if (!anchors.has(p.anchor)) anchors.set(p.anchor, pos);
      } else if (p.link !== undefined) {
        chunks.push(p);
        pos += LINK_OPEN_LEN;
      } else {
        chunks.push(p);
        pos += 18; // filepos=NNNNNNNNNN
      }
    }
    const find = (key) => {
      if (anchors.has(key)) return anchors.get(key);
      const file = key.split("#")[0];
      return anchors.has(file) ? anchors.get(file) : -1;
    };
    const out = new Uint8Array(pos);
    let o = 0;
    let broken = 0;
    for (const c of chunks) {
      let b = c;
      if (!(c instanceof Uint8Array)) {
        const at = find(c.link ?? c.filepos);
        const num = String(Math.max(0, at)).padStart(10, "0");
        if (c.link !== undefined) {
          if (at < 0) broken++;
          b = enc.encode(at < 0 ? "<a" + " ".repeat(LINK_OPEN_LEN - 3) + ">" : `<a filepos=${num}>`);
        } else b = enc.encode(`filepos=${num}`);
      }
      out.set(b, o);
      o += b.length;
    }
    return { bytes: out, anchors, broken };
  }
}

// how each source element is written
const BLOCK = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "dl", "dt", "dd",
  "table", "tr", "td", "th", "caption", "pre", "center"]);
const TO_DIV = new Set(["section", "article", "aside", "nav", "header", "footer", "main", "figure", "figcaption",
  "address", "hgroup", "details", "summary"]);
const INLINE = { b: "b", strong: "b", i: "i", em: "i", cite: "i", var: "i", dfn: "i", u: "u", ins: "u", s: "strike",
  strike: "strike", del: "strike", sub: "sub", sup: "sup", small: "small", big: "big", tt: "tt", code: "tt",
  kbd: "tt", samp: "tt" };
const SKIP = new Set(["head", "script", "style", "title", "math", "object", "embed", "video", "audio", "iframe",
  "template", "rt", "rp", "canvas", "map", "select", "textarea", "button", "input"]);
const VOID = new Set(["br", "hr", "img", "image", "meta", "link", "col", "area", "base", "wbr", "source", "track", "input"]);

/**
 * Pre-scan: stylesheet paths a chapter uses (so the caller can load them first).
 */
export function stylesheetsOf(src, path) {
  const out = [];
  for (const t of tokenize(src)) {
    if (t.type === "start" && t.local === "link" && /stylesheet/i.test(t.attrs.rel || "") && t.attrs.href) {
      out.push(resolvePath(path, t.attrs.href.split("#")[0]));
    }
  }
  return out;
}

/**
 * @param {string} src XHTML source
 * @param {string} path its path in the zip
 * @param {Builder} out
 * @param {{ css: (path) => string, image: (path) => Promise<number|null>, firstChapter: boolean }} ctx
 */
export async function writeChapter(src, path, out, ctx) {
  const tokens = tokenize(src);
  // styles: linked sheets (preloaded by the caller) + <style> blocks
  let cssText = "";
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === "start" && t.local === "link" && /stylesheet/i.test(t.attrs.rel || "") && t.attrs.href) {
      cssText += "\n" + (ctx.css(resolvePath(path, t.attrs.href.split("#")[0])) || "");
    } else if (t.type === "start" && t.local === "style" && !t.selfClosing) {
      let e = k + 1;
      while (e < tokens.length && !(tokens[e].type === "end" && tokens[e].local === "style")) {
        if (tokens[e].type === "text") cssText += "\n" + decodeEntities(tokens[e].text);
        e++;
      }
      k = e;
    }
  }
  const rules = parseCss(cssText);

  if (!ctx.firstChapter) out.text("<mbp:pagebreak/>");
  out.anchor(path);

  const bodyAt = tokens.findIndex((t) => t.type === "start" && t.local === "body");
  const stack = []; // {local, close: string}
  let pre = 0;
  let pendingSpace = false;
  let lastWasBlock = true;
  let sawContent = false; // a CSS page break before the first content of a chapter is redundant
  const emitText = (s) => {
    out.text(s);
    lastWasBlock = false;
    sawContent = true;
  };

  for (let k = bodyAt < 0 ? 0 : bodyAt; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === "text") {
      let s = decodeEntities(t.text);
      if (!pre) {
        s = s.replace(/[ \t\r\n\f]+/g, " ");
        if (s === " ") {
          if (!lastWasBlock) pendingSpace = true;
          continue;
        }
        if (s.startsWith(" ")) {
          if (!lastWasBlock) pendingSpace = true;
          s = s.slice(1);
        }
        const trailing = s.endsWith(" ");
        if (trailing) s = s.slice(0, -1);
        if (pendingSpace) s = " " + s;
        pendingSpace = trailing;
      }
      if (s) emitText(escapeText(s));
      continue;
    }

    if (t.type === "end") {
      // close up to the matching open element (tolerates sloppy nesting)
      let idx = stack.length - 1;
      while (idx >= 0 && stack[idx].local !== t.local) idx--;
      if (idx < 0) continue;
      while (stack.length > idx) {
        const e = stack.pop();
        if (e.block) pendingSpace = false;
        out.text(e.close);
        if (e.local === "pre") pre--;
        if (e.block) lastWasBlock = true;
      }
      if (t.local === "body") break;
      continue;
    }

    // start tag
    const local = t.local;
    const a = t.attrs;
    const id = a.id || (local === "a" ? a.name : "");

    if (SKIP.has(local)) {
      if (id) out.anchor(`${path}#${id}`);
      k = skipTo(tokens, k);
      continue;
    }
    if (local === "svg") {
      if (id) out.anchor(`${path}#${id}`);
      const end = skipTo(tokens, k);
      for (let j = k + 1; j < end; j++) {
        const u = tokens[j];
        if (u.type === "start" && u.local === "image") {
          const href = u.attrs["xlink:href"] || u.attrs.href;
          if (href) await writeImage(resolvePath(path, href), out, ctx);
        }
      }
      k = end;
      continue;
    }

    const style = computeStyle(rules, local, a.class, a.style);
    if (style.hidden) {
      if (id) out.anchor(`${path}#${id}`);
      k = skipTo(tokens, k);
      continue;
    }
    if (style.pageBreak && sawContent) out.text("<mbp:pagebreak/>");
    if (id) out.anchor(`${path}#${id}`);

    if (local === "img") {
      if (a.src) await writeImage(resolvePath(path, a.src), out, ctx);
      lastWasBlock = false;
      sawContent = true;
      continue;
    }
    if (local === "br") {
      out.text("<br/>");
      pendingSpace = false;
      lastWasBlock = true;
      continue;
    }
    if (local === "hr") {
      out.text("<hr/>");
      pendingSpace = false;
      lastWasBlock = true;
      continue;
    }
    if (VOID.has(local) || t.selfClosing) {
      // <a id="x"/>, <p/>, <div/> …: an empty block still separates text
      if (BLOCK.has(local) || TO_DIV.has(local)) {
        pendingSpace = false;
        lastWasBlock = true;
      }
      continue;
    }

    // wrappers from CSS (inside the element, closed in reverse order)
    const wrap = [];
    if (style.bold && local !== "b" && local !== "strong" && !/^h[1-6]$/.test(local)) wrap.push("b");
    if (style.italic && !(local in INLINE && INLINE[local] === "i")) wrap.push("i");
    if (style.underline && local !== "u" && local !== "a") wrap.push("u");
    if (style.strike && INLINE[local] !== "strike") wrap.push("strike");
    if (style.sup && local !== "sup") wrap.push("sup");
    else if (style.sub && local !== "sub") wrap.push("sub");
    const openWrap = wrap.map((w) => `<${w}>`).join("");
    const closeWrap = wrap.reverse().map((w) => `</${w}>`).join("");

    let open = "";
    let close = "";
    let block = false;
    if (BLOCK.has(local) || TO_DIV.has(local)) {
      const tag = TO_DIV.has(local) ? "div" : local;
      const align = style.align && style.align !== "left" && style.align !== "justify" && tag !== "table" ? ` align="${style.align}"` : "";
      const extra = (tag === "td" || tag === "th") && a.colspan ? ` colspan="${escapeAttr(a.colspan)}"` : "";
      open = `<${tag}${align}${extra}>`;
      close = `</${tag}>`;
      block = true;
      pendingSpace = false;
      if (local === "pre") pre++;
    } else if (local === "a") {
      const href = a.href || "";
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        open = /^(https?|mailto):/i.test(href) ? `<a href="${escapeAttr(href)}">` : "<a>";
        close = "</a>";
      } else if (href) {
        if (pendingSpace) {
          out.text(" ");
          pendingSpace = false;
        }
        out.link(resolveRef(path, href));
        close = "</a>";
      }
    } else if (local in INLINE) {
      open = `<${INLINE[local]}>`;
      close = `</${INLINE[local]}>`;
    }
    if ((open || openWrap) && pendingSpace && !block) {
      out.text(" ");
      pendingSpace = false;
    }
    out.text(open + openWrap);
    if (block) lastWasBlock = true;
    stack.push({ local, close: closeWrap + close, block });
  }
  while (stack.length) out.text(stack.pop().close);
}

async function writeImage(path, out, ctx) {
  const idx = await ctx.image(path);
  if (idx) out.text(`<img recindex="${String(idx).padStart(5, "0")}"/>`);
}

/** index of the token that closes the element opened at k (or k if self-closing) */
function skipTo(tokens, k) {
  const t = tokens[k];
  if (t.selfClosing || VOID.has(t.local)) return k;
  let depth = 1;
  for (let j = k + 1; j < tokens.length; j++) {
    const u = tokens[j];
    if (u.local !== t.local) continue;
    if (u.type === "start" && !u.selfClosing) depth++;
    else if (u.type === "end" && --depth === 0) return j;
  }
  return tokens.length;
}
