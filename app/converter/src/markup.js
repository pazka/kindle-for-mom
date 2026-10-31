/**
 * Tolerant XML/HTML tokenizer + entity decoding, shared by the OPF/NCX
 * readers and the XHTML → MOBI HTML rewriter. Works the same in the browser
 * and in Node (no DOMParser needed), which keeps the converter testable.
 *
 * Tokens: {type:"start", name, local, attrs, selfClosing} · {type:"end", name, local}
 *         {type:"text", text}  (text is still entity-encoded; use decodeEntities)
 */

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "­",
  ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚",
  ldquo: "“", rdquo: "”", bdquo: "„", dagger: "†", Dagger: "‡",
  bull: "•", hellip: "…", permil: "‰", prime: "′", Prime: "″",
  lsaquo: "‹", rsaquo: "›", euro: "€", trade: "™", larr: "←",
  rarr: "→", uarr: "↑", darr: "↓", minus: "−", times: "×", divide: "÷",
  iexcl: "¡", cent: "¢", pound: "£", curren: "¤", yen: "¥", brvbar: "¦", sect: "§", uml: "¨",
  copy: "©", ordf: "ª", laquo: "«", not: "¬", reg: "®", macr: "¯", deg: "°", plusmn: "±",
  sup2: "²", sup3: "³", acute: "´", micro: "µ", para: "¶", middot: "·", cedil: "¸", sup1: "¹",
  ordm: "º", raquo: "»", frac14: "¼", frac12: "½", frac34: "¾", iquest: "¿",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ",
  Ccedil: "Ç", Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë", Igrave: "Ì", Iacute: "Í",
  Icirc: "Î", Iuml: "Ï", ETH: "Ð", Ntilde: "Ñ", Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô",
  Otilde: "Õ", Ouml: "Ö", Oslash: "Ø", Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü",
  Yacute: "Ý", THORN: "Þ", szlig: "ß", agrave: "à", aacute: "á", acirc: "â", atilde: "ã",
  auml: "ä", aring: "å", aelig: "æ", ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê",
  euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï", eth: "ð", ntilde: "ñ",
  ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø", ugrave: "ù",
  uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý", thorn: "þ", yuml: "ÿ", OElig: "Œ",
  oelig: "œ", Scaron: "Š", scaron: "š", Yuml: "Ÿ", fnof: "ƒ", circ: "ˆ", tilde: "˜",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", pi: "π", sigma: "σ", omega: "ω", Omega: "Ω",
};

export function decodeEntities(s) {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
      return String.fromCodePoint(cp);
    }
    return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : m;
  });
}

export const escapeText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const escapeAttr = (s) => escapeText(s).replace(/"/g, "&quot;");

const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseAttrs(src) {
  const attrs = {};
  ATTR.lastIndex = 0;
  let m;
  while ((m = ATTR.exec(src))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

const localName = (name) => {
  const i = name.indexOf(":");
  return i < 0 ? name : name.slice(i + 1);
};

/** @returns {Array<object>} tokens */
export function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      out.push({ type: "text", text: src.slice(i) });
      break;
    }
    if (lt > i) out.push({ type: "text", text: src.slice(i, lt) });
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      const text = src.slice(lt + 9, end < 0 ? n : end);
      out.push({ type: "text", text: text.replace(/&/g, "&amp;").replace(/</g, "&lt;") });
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src[lt + 1] === "!" || src[lt + 1] === "?") {
      const end = src.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const m = /^<(\/?)([A-Za-z_][\w:.-]*)/.exec(src.slice(lt, lt + 200));
    if (!m) {
      out.push({ type: "text", text: "&lt;" });
      i = lt + 1;
      continue;
    }
    // find the closing ">" outside quotes
    let j = lt + m[0].length;
    let q = null;
    for (; j < n; j++) {
      const c = src[j];
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === ">") break;
    }
    const inner = src.slice(lt + m[0].length, j);
    const name = m[2].toLowerCase();
    if (m[1]) out.push({ type: "end", name, local: localName(name) });
    else {
      const selfClosing = /\/\s*$/.test(inner);
      out.push({ type: "start", name, local: localName(name), attrs: parseAttrs(inner.replace(/\/\s*$/, "")), selfClosing });
    }
    i = j + 1;
  }
  return out;
}

/** Plain text of a fragment (tags dropped, entities decoded, whitespace collapsed). */
export function textOf(tokens) {
  return decodeEntities(tokens.filter((t) => t.type === "text").map((t) => t.text).join(""))
    .replace(/\s+/g, " ")
    .trim();
}

/** Text content of each element with this local name: [{attrs, text}] (no nesting of the same name). */
export function elements(tokens, local) {
  const res = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== "start" || t.local !== local) continue;
    if (t.selfClosing) {
      res.push({ attrs: t.attrs, text: "" });
      continue;
    }
    let e = k + 1;
    while (e < tokens.length && !(tokens[e].type === "end" && tokens[e].local === local)) e++;
    res.push({ attrs: t.attrs, text: textOf(tokens.slice(k + 1, e)) });
    k = e;
  }
  return res;
}

/** Resolve an href relative to a file path inside the zip ("OEBPS/text/ch1.xhtml"). */
export function resolvePath(base, href) {
  let h = href;
  try {
    h = decodeURIComponent(href);
  } catch {
    /* keep raw */
  }
  if (h.startsWith("/")) return normalize(h.slice(1));
  const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "";
  return normalize(dir + h);
}

function normalize(p) {
  const parts = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}
