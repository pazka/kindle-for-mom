import assert from "node:assert/strict";
import { test } from "node:test";

import { computeStyle, parseCss, parseDecls } from "../src/css.js";

test("parseDecls maps what an old Kindle can show", () => {
  assert.deepEqual(parseDecls("font-style: italic; font-weight: 700; text-align: CENTER !important"), { italic: true, bold: true, align: "center" });
  assert.deepEqual(parseDecls("font-style: oblique; font-weight: bolder"), { italic: true, bold: true });
  assert.deepEqual(parseDecls("font-weight: 400; font-style: normal"), { italic: false, bold: false });
  assert.deepEqual(parseDecls("font: italic bold 12px serif"), { italic: true, bold: true });
  assert.deepEqual(parseDecls("text-decoration: underline line-through"), { underline: true, strike: true });
  assert.deepEqual(parseDecls("text-decoration: none"), { underline: false, strike: false });
  assert.deepEqual(parseDecls("display: none"), { hidden: true });
  assert.deepEqual(parseDecls("visibility: hidden"), { hidden: true });
  assert.deepEqual(parseDecls("vertical-align: super"), { sup: true });
  assert.deepEqual(parseDecls("vertical-align: sub"), { sub: true });
  assert.deepEqual(parseDecls("page-break-before: always"), { pageBreak: true });
  assert.deepEqual(parseDecls("break-before: page"), { pageBreak: true });
  assert.deepEqual(parseDecls("color: red; margin: 0; garbage; text-align: start"), {});
  assert.deepEqual(parseDecls(""), {});
});

test("parseCss: simple selectors only, at-rules and comments skipped", () => {
  const rules = parseCss(`
    /* comment { } */
    @font-face { font-family: x; src: url(a.ttf) }
    @media screen { .it { font-style: italic } p { color: red } }
    p.center, h1 { text-align: center }
    .it { font-style: italic }
    div .b { font-weight: bold }
    #id { font-weight: bold }
    a:hover { font-weight: bold }
    p > span { font-style: italic }
    [lang] { font-style: italic }
    * { font-style: italic }
    p span { font-weight: bold }
    .nothing { color: blue }
    broken { font-style: italic
  `);
  assert.deepEqual(rules.map((r) => [r.tag, r.classes.join(".")]), [
    ["p", "center"],
    ["h1", ""],
    [null, "it"],
    [null, "b"],
  ]);
});

test("computeStyle: tag < class < inline", () => {
  const rules = parseCss("p { text-align: right } .c { text-align: center } p.x.y { font-weight: bold } .it { font-style: italic }");
  assert.deepEqual(computeStyle(rules, "p", "", ""), { align: "right" });
  assert.deepEqual(computeStyle(rules, "p", "c", ""), { align: "center" });
  assert.deepEqual(computeStyle(rules, "p", "x", ""), { align: "right" }, "needs every class");
  assert.deepEqual(computeStyle(rules, "p", "y x", ""), { align: "right", bold: true });
  assert.deepEqual(computeStyle(rules, "div", "x y", ""), {}, "tag-qualified class rule");
  assert.deepEqual(computeStyle(rules, "span", "it", "font-style: normal"), { italic: false });
});
