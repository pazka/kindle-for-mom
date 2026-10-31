import assert from "node:assert/strict";
import { test } from "node:test";

import { BookError, convertEpub, mobiFileName } from "../src/convert.js";
import { palmdocCompress, palmdocDecompress, readMobi } from "../src/mobi.js";
import { makeZip, sampleEpub } from "./fixtures.js";

test("PalmDOC round-trips text, binary and UTF-8", () => {
  const enc = new TextEncoder();
  const samples = [
    enc.encode("Hello world. Hello world. Hello world! <p>abc</p><p>abc</p>"),
    enc.encode("l’été à Noël, « déjà vu » — ".repeat(150)).subarray(0, 4096),
    Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919) & 0xff),
    new Uint8Array(4096),
    enc.encode(" @ A z ~ \t\n"),
    new Uint8Array(0),
  ];
  for (const s of samples) {
    const c = palmdocCompress(s);
    assert.deepEqual(palmdocDecompress(c), s);
  }
  const text = enc.encode("<p>Some repetitive paragraph text.</p>".repeat(200)).subarray(0, 4096);
  assert.ok(palmdocCompress(text).length < text.length / 3, "compresses repetitive HTML");
});

test("converts an EPUB 3 into a readable MOBI 6", async () => {
  const { mobi, meta, stats, warnings } = await convertEpub(sampleEpub(), { now: 1_700_000_000, uid: 42 });
  assert.equal(meta.title, "Le Livre d’Été");
  assert.deepEqual(warnings, []);
  assert.equal(new TextDecoder().decode(mobi.subarray(60, 68)), "BOOKMOBI");
  const back = readMobi(mobi);
  assert.equal(back.title, "Le Livre d’Été");
  assert.equal(back.encoding, 65001);
  assert.equal(back.compression, 2);
  assert.equal(back.images.length, 2, "cover + one picture");
  assert.equal(stats.cover, true);
  const dec = (k) => back.exth.get(k)?.map((b) => new TextDecoder().decode(b));
  assert.deepEqual(dec(100), ["Émile Auteur"]);
  assert.deepEqual(dec(524), ["fr"]);
  assert.deepEqual(dec(104), ["9782070360024"]);
  assert.equal(dec(103)[0], "Un résumé.");
  assert.ok(back.exth.has(201), "cover offset record");

  const html = back.html;
  assert.match(html, /^<html><head><guide><reference type="toc" title="Table des matières" filepos=\d{10}\/>/);
  assert.ok(html.includes("l’été à Noël, « déjà vu » — naïve façade…"), "accents survive");
  assert.ok(html.includes("<i>en italique</i>"), "CSS class italic → <i>");
  assert.ok(html.includes("<i>emphase</i>"));
  assert.ok(html.includes('<h1 align="center">Chapitre 1</h1>'), "CSS alignment → align attribute");
  assert.equal((html.match(/<mbp:pagebreak\/>/g) || []).length >= 3, true);
  assert.ok(!html.includes("alert(1)"), "scripts dropped");
  assert.ok(!html.includes("caché"), "display:none dropped");
  assert.ok(!/class=|style=|<section|<span/.test(html), "no CSS, no HTML5 tags");
  assert.ok(html.includes('<a href="https://example.org/">un site</a>'));
  assert.match(html, /<img recindex="00002"\/>/);
  assert.match(html, /<img recindex="00001"\/>/, "cover page");

  // every filepos points at a real place: the note link lands on "La note."
  const bytes = back.text;
  const fileposAt = (re) => Number(re.exec(html)[1]);
  const noteLink = fileposAt(/<a filepos=(\d{10})>note<\/a>/);
  const tail = new TextDecoder().decode(bytes.subarray(noteLink, noteLink + 30));
  assert.ok(tail.startsWith("<p>La note."), `note link lands on: ${tail}`);
  const toc = fileposAt(/type="toc"[^>]*filepos=(\d{10})/);
  assert.ok(new TextDecoder().decode(bytes.subarray(toc, toc + 40)).includes("Table des matières"));
  for (const m of html.matchAll(/filepos=(\d{10})/g)) assert.ok(Number(m[1]) < bytes.length);
  const ch3 = [...html.matchAll(/<a filepos=(\d{10})>Chapitre 3<\/a>/g)][0];
  assert.ok(new TextDecoder().decode(bytes.subarray(Number(ch3[1]), Number(ch3[1]) + 40)).startsWith("<div><h1"));
});

test("multi-record books: 4096-byte records, multibyte overlap, large text", async () => {
  const { mobi, stats } = await convertEpub(sampleEpub({ chapters: 12, paragraphs: 300 }));
  assert.ok(stats.textBytes > 400_000);
  const back = readMobi(mobi); // throws if any record is not exactly 4096 bytes or the length differs
  assert.ok(back.records > 120);
  assert.ok(mobi.length < stats.textBytes / 2, `compressed ${mobi.length} vs ${stats.textBytes}`);
});

test("EPUB 2 (NCX + meta cover) works too", async () => {
  const { mobi, stats } = await convertEpub(sampleEpub({ epub2: true }));
  const back = readMobi(mobi);
  assert.equal(stats.tocEntries, 3);
  assert.equal(stats.cover, true);
  assert.match(back.html, /<a filepos=\d{10}>Chapitre 2<\/a>/);
});

test("refuses non-EPUB and DRM books with a clear code", async () => {
  await assert.rejects(convertEpub(new TextEncoder().encode("not a zip")), (e) => e instanceof BookError && e.code === "not_epub");
  const drm = makeZip([
    ["mimetype", "application/epub+zip"],
    ["META-INF/container.xml", '<container><rootfiles><rootfile full-path="c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ["META-INF/encryption.xml", '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><CipherData><CipherReference URI="ch1.xhtml"/></CipherData></EncryptedData></encryption>'],
    ["c.opf", '<package version="2.0"><metadata><dc:title>x</dc:title></metadata><manifest><item id="a" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>'],
    ["ch1.xhtml", "garbage"],
  ]);
  await assert.rejects(convertEpub(drm), (e) => e.code === "drm");
});

test("file names are safe for the Kindle's FAT32 drive", () => {
  assert.equal(mobiFileName({ title: 'Qui a peur? "Moi": 1/2', creators: ["A. B."] }), "Qui a peur Moi 1 2 - A. B.mobi");
  assert.equal(mobiFileName({ title: "con" }), "con_.mobi");
  assert.equal(mobiFileName({ title: "" }), "Livre.mobi");
});
