/** Builds EPUB files in memory: the self-test book the server converts at start-up (/healthz), the
 *  in-container smoke and the unit tests. Node only (zlib). */

import { deflateRawSync } from "node:zlib";

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export function makeZip(files) {
  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = typeof content === "string" ? enc.encode(content) : content;
    const stored = name === "mimetype";
    const body = stored ? data : deflateRawSync(data);
    const nb = enc.encode(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x800, 6);
    h.writeUInt16LE(stored ? 0 : 8, 8);
    h.writeUInt32LE(crc32(data), 14);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nb.length, 26);
    local.push(h, nb, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(stored ? 0 : 8, 10);
    c.writeUInt32LE(crc32(data), 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nb.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nb);
    offset += 30 + nb.length + body.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(files.length, 8);
  e.writeUInt16LE(files.length, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, cd, e]));
}

// 1×1 white JPEG
export const TINY_JPEG = Uint8Array.from(Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
));

/** A small but realistic EPUB 3 (nav + NCX, CSS classes, cover, footnote link, accents). */
export function sampleEpub({ chapters = 3, paragraphs = 40, epub2 = false } = {}) {
  const files = [
    ["mimetype", "application/epub+zip"],
    ["META-INF/container.xml", `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`],
  ];
  const items = [];
  const refs = [];
  const navLis = [];
  const ncx = [];
  for (let c = 1; c <= chapters; c++) {
    const paras = Array.from({ length: paragraphs }, (_, p) =>
      `<p class="txt">Chapitre ${c}, paragraphe ${p} : l’été à Noël, « déjà vu » — naïve façade… <span class="it">en italique</span> et <em>emphase</em>.</p>`).join("\n");
    files.push([`OEBPS/text/ch${c}.xhtml`, `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Ch ${c}</title>
<link rel="stylesheet" type="text/css" href="../styles/book.css"/></head>
<body><section id="c${c}"><h1 class="center">Chapitre&#160;${c}</h1>
${c === 1 ? '<p>Voir la <a epub:type="noteref" href="ch2.xhtml#note">note</a> et <a href="https://example.org/">un site</a>.</p><p><img src="../images/pic.jpg" alt=""/></p>' : ""}
${c === 2 ? '<p id="note">La note.</p>' : ""}
${paras}
<script>alert(1)</script><p style="display:none">caché</p>
</section></body></html>`]);
    items.push(`<item id="ch${c}" href="text/ch${c}.xhtml" media-type="application/xhtml+xml"/>`);
    refs.push(`<itemref idref="ch${c}"/>`);
    navLis.push(`<li><a href="text/ch${c}.xhtml">Chapitre ${c}</a></li>`);
    ncx.push(`<navPoint id="n${c}" playOrder="${c}"><navLabel><text>Chapitre ${c}</text></navLabel><content src="text/ch${c}.xhtml"/></navPoint>`);
  }
  files.push(["OEBPS/styles/book.css", ".it { font-style: italic } h1.center { text-align: center } @media print { p { color: red } }"]);
  files.push(["OEBPS/images/cover.jpg", TINY_JPEG]);
  files.push(["OEBPS/images/pic.jpg", TINY_JPEG]);
  files.push(["OEBPS/nav.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>${navLis.join("")}</ol></nav></body></html>`]);
  files.push(["OEBPS/toc.ncx", `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>${ncx.join("")}</navMap></ncx>`]);
  files.push(["OEBPS/content.opf", `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${epub2 ? "2.0" : "3.0"}" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>Le Livre d’Été</dc:title><dc:creator>Émile Auteur</dc:creator><dc:language>fr</dc:language>
<dc:identifier id="id">urn:isbn:9782070360024</dc:identifier><dc:publisher>Éditions Test</dc:publisher>
<dc:description>&lt;p&gt;Un résumé.&lt;/p&gt;</dc:description>
${epub2 ? '<meta name="cover" content="cover"/>' : ""}
</metadata>
<manifest>
${epub2 ? "" : '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'}
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="cover" href="images/cover.jpg" media-type="image/jpeg"${epub2 ? "" : ' properties="cover-image"'}/>
<item id="pic" href="images/pic.jpg" media-type="image/jpeg"/>
<item id="css" href="styles/book.css" media-type="text/css"/>
${items.join("\n")}
</manifest>
<spine toc="ncx">${refs.join("")}</spine>
</package>`]);
  return makeZip(files);
}
