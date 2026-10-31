import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeEntities, elements, escapeAttr, escapeText, resolvePath, textOf, tokenize } from "../src/markup.js";

test("decodeEntities: named, decimal, hex, unknown and invalid", () => {
  assert.equal(decodeEntities("a&amp;b &lt;&gt; &quot;&apos;"), "a&b <> \"'");
  assert.equal(decodeEntities("&eacute;t&eacute; &#233; &#xE9; &#XE9;"), "été é é é");
  assert.equal(decodeEntities("&nbsp;&mdash;&hellip;&laquo;&raquo;"), " —…«»");
  assert.equal(decodeEntities("&unknown; &; & alone"), "&unknown; &; & alone");
  assert.equal(decodeEntities("&#0; &#xD800; &#x110000;"), "� � �");
  assert.equal(decodeEntities("&#x1F600;"), "😀");
  assert.equal(decodeEntities("no entity"), "no entity");
  assert.equal(decodeEntities("&constructor;"), "&constructor;", "no prototype lookup");
});

test("escapeText / escapeAttr", () => {
  assert.equal(escapeText(`<a href="x">&</a>`), `&lt;a href="x"&gt;&amp;&lt;/a&gt;`);
  assert.equal(escapeAttr(`"<&>`), "&quot;&lt;&amp;&gt;");
});

test("tokenize: tags, attributes, self-closing, namespaces", () => {
  const t = tokenize(`<p class="a" id='b' data-x=y hidden><epub:switch/><BR/>Hi &amp; bye</p>`);
  assert.deepEqual(t[0], { type: "start", name: "p", local: "p", attrs: { class: "a", id: "b", "data-x": "y", hidden: "" }, selfClosing: false });
  assert.equal(t[1].name, "epub:switch");
  assert.equal(t[1].local, "switch");
  assert.equal(t[1].selfClosing, true);
  assert.equal(t[2].name, "br", "names are lower-cased");
  assert.deepEqual(t[3], { type: "text", text: "Hi &amp; bye" });
  assert.deepEqual(t[4], { type: "end", name: "p", local: "p" });
});

test("tokenize: comments, PIs, doctype, CDATA, stray '<', '>' inside quotes", () => {
  const t = tokenize(`<?xml version="1.0"?><!DOCTYPE html><!-- <p>no</p> --><a title="x > y">1 < 2</a><![CDATA[<b>&]]>`);
  assert.deepEqual(t.map((x) => x.type), ["start", "text", "text", "text", "end", "text"]);
  assert.equal(t[0].attrs.title, "x > y");
  assert.equal(t[1].text, "1 ");
  assert.equal(t[2].text, "&lt;", "stray < becomes text");
  assert.equal(t[5].text, "&lt;b>&amp;", "CDATA is escaped text");
});

test("tokenize: unterminated constructs do not hang or throw", () => {
  for (const src of ["<!-- open", "<![CDATA[ open", "<p class='open", "<?pi", "<", "text <"]) {
    assert.ok(Array.isArray(tokenize(src)), src);
  }
});

test("attribute values are entity-decoded, first duplicate wins", () => {
  const [t] = tokenize(`<a href="a&amp;b&#47;c" href="ignored">`);
  assert.equal(t.attrs.href, "a&b/c");
});

test("elements / textOf", () => {
  const t = tokenize("<m><dc:title> Le  <i>Titre</i>\n</dc:title><dc:title/><x>no</x></m>");
  assert.deepEqual(elements(t, "title"), [{ attrs: {}, text: "Le Titre" }, { attrs: {}, text: "" }]);
  assert.equal(textOf(tokenize("a &amp; <b>b</b>")), "a & b");
});

test("resolvePath: relative, parent, absolute, percent-encoding", () => {
  assert.equal(resolvePath("OEBPS/text/ch1.xhtml", "../images/a.jpg"), "OEBPS/images/a.jpg");
  assert.equal(resolvePath("OEBPS/text/ch1.xhtml", "./ch2.xhtml"), "OEBPS/text/ch2.xhtml");
  assert.equal(resolvePath("OEBPS/content.opf", "/root.xhtml"), "root.xhtml");
  assert.equal(resolvePath("a.opf", "b%20c.xhtml"), "b c.xhtml");
  assert.equal(resolvePath("a.opf", "bad%zz.xhtml"), "bad%zz.xhtml");
  assert.equal(resolvePath("x/y.xhtml", "../../../z.xhtml"), "z.xhtml", "cannot climb out of the zip");
});
