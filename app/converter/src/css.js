/**
 * Just enough CSS to keep what an old Kindle can show: italic, bold,
 * underline, strike, alignment, small super/subscript, hidden elements and
 * page breaks. MOBI 6 readers ignore stylesheets, so these become tags.
 * Only simple selectors are honoured (tag, .class, tag.class, comma lists);
 * the last compound of a descendant selector is used as an approximation
 * only for class selectors, which is how most EPUB styles are written.
 */

/** @returns {Array<{tag:string|null, classes:string[], props:object}>} */
export function parseCss(text) {
  const rules = [];
  const src = String(text || "").replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) break;
    const head = src.slice(i, open).trim();
    // skip at-rule blocks (@media, @font-face, @page …) including nested braces
    if (head.startsWith("@") || head.includes("@")) {
      let depth = 1;
      let j = open + 1;
      for (; j < src.length && depth; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
      }
      i = j;
      continue;
    }
    const close = src.indexOf("}", open);
    if (close < 0) break;
    const props = parseDecls(src.slice(open + 1, close));
    if (Object.keys(props).length) {
      for (const sel of head.split(",")) {
        const parsed = parseSelector(sel.trim());
        if (parsed) rules.push({ ...parsed, props });
      }
    }
    i = close + 1;
  }
  return rules;
}

function parseSelector(sel) {
  // attribute, pseudo, id, child/sibling and universal selectors are ignored (too risky to apply broadly)
  if (!sel || /[\[\]:>+~*#]/.test(sel)) return null;
  const parts = sel.split(/\s+/);
  const last = parts[parts.length - 1];
  if (parts.length > 1 && !last.includes(".")) return null;
  const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)$/.exec(last);
  if (!m || (!m[1] && !m[2])) return null;
  return { tag: m[1] ? m[1].toLowerCase() : null, classes: m[2] ? m[2].slice(1).split(".") : [] };
}

/** "font-style: italic; text-align:center" → {italic:true, align:"center"} */
export function parseDecls(text) {
  const props = {};
  for (const decl of String(text || "").split(";")) {
    const c = decl.indexOf(":");
    if (c < 0) continue;
    const name = decl.slice(0, c).trim().toLowerCase();
    const value = decl.slice(c + 1).replace(/!important/i, "").trim().toLowerCase();
    switch (name) {
      case "font-style":
        props.italic = value === "italic" || value === "oblique";
        break;
      case "font-weight":
        props.bold = value === "bold" || value === "bolder" || (/^\d+$/.test(value) && Number(value) >= 600);
        break;
      case "font":
        if (/\b(italic|oblique)\b/.test(value)) props.italic = true;
        if (/\b(bold|bolder|[6-9]00)\b/.test(value)) props.bold = true;
        break;
      case "text-decoration":
      case "text-decoration-line":
        if (/underline/.test(value)) props.underline = true;
        if (/line-through/.test(value)) props.strike = true;
        if (value === "none") props.underline = props.strike = false;
        break;
      case "text-align":
        if (/^(center|right|left|justify)$/.test(value)) props.align = value;
        break;
      case "display":
        props.hidden = value === "none";
        break;
      case "visibility":
        props.hidden = value === "hidden";
        break;
      case "vertical-align":
        if (value === "super") props.sup = true;
        if (value === "sub") props.sub = true;
        break;
      case "page-break-before":
      case "break-before":
        if (/^(always|page|left|right)$/.test(value)) props.pageBreak = true;
        break;
      default:
    }
  }
  return props;
}

/** Computed props for one element: tag rules < class rules < inline style. */
export function computeStyle(rules, tag, classAttr, styleAttr) {
  const classes = String(classAttr || "").split(/\s+/).filter(Boolean);
  const out = {};
  const apply = (p) => Object.assign(out, p);
  // specificity: tag-only rules first, then rules with classes; document order inside each group
  for (const r of rules) if (!r.classes.length && r.tag === tag) apply(r.props);
  if (classes.length) {
    for (const r of rules) {
      if (!r.classes.length) continue;
      if (r.tag && r.tag !== tag) continue;
      if (r.classes.every((c) => classes.includes(c))) apply(r.props);
    }
  }
  if (styleAttr) apply(parseDecls(styleAttr));
  return out;
}
