/**
 * MOBI 6 writer (PalmDB "BOOKMOBI"), the format every Kindle reads, including
 * the oldest e-ink models that predate KF8/AZW3. Layout follows what
 * kindlegen 1.x and calibre write: record 0 (PalmDOC + MOBI + EXTH headers),
 * 4096-byte text records with PalmDOC compression and multibyte trailing
 * entries, image records, FLIS, FCIS, EOF.
 */

const RECORD_SIZE = 4096;
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// PalmDOC (LZ77 variant) compression

/** Compress one ≤ 4096-byte text record. */
export function palmdocCompress(data) {
  const n = data.length;
  const out = new Uint8Array(n + Math.ceil(n / 8) + 16);
  let o = 0;
  // hash chains of 3-byte prefixes for match search in the 2047-byte window
  const head = new Map();
  const prev = new Int32Array(n).fill(-1);
  const key = (i) => (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
  let indexed = 0;
  const indexUpTo = (end) => {
    for (; indexed < end && indexed + 2 < n; indexed++) {
      const k = key(indexed);
      const h = head.get(k);
      prev[indexed] = h === undefined ? -1 : h;
      head.set(k, indexed);
    }
  };

  let i = 0;
  while (i < n) {
    indexUpTo(i);
    // 1. back-reference of 3..10 bytes, source fully inside the window (no overlap)
    if (i + 2 < n && i > 0) {
      let best = 0;
      let bestDist = 0;
      let cand = head.get(key(i));
      const maxLen = Math.min(10, n - i);
      let tries = 0;
      while (cand !== undefined && cand >= 0 && i - cand <= 2047 && tries++ < 64) {
        let len = 0;
        const lim = Math.min(maxLen, i - cand);
        while (len < lim && data[cand + len] === data[i + len]) len++;
        if (len > best) {
          best = len;
          bestDist = i - cand;
          if (len === maxLen) break;
        }
        cand = prev[cand];
      }
      if (best >= 3) {
        const v = 0x8000 | (bestDist << 3) | (best - 3);
        out[o++] = v >> 8;
        out[o++] = v & 0xff;
        i += best;
        continue;
      }
    }
    const c = data[i];
    // 2. space + printable ASCII 0x40–0x7f packed in one byte
    if (c === 0x20 && i + 1 < n && data[i + 1] >= 0x40 && data[i + 1] <= 0x7f) {
      out[o++] = data[i + 1] ^ 0x80;
      i += 2;
      continue;
    }
    // 3. literal
    if (c === 0 || (c >= 0x09 && c <= 0x7f)) {
      out[o++] = c;
      i++;
      continue;
    }
    // 4. run of up to 8 "binary" bytes (0x01–0x08, 0x80–0xff) behind a count byte
    let j = i;
    while (j < n && j - i < 8 && (data[j] >= 0x80 || (data[j] >= 1 && data[j] <= 8))) j++;
    out[o++] = j - i;
    out.set(data.subarray(i, j), o);
    o += j - i;
    i = j;
  }
  return out.slice(0, o);
}

export function palmdocDecompress(data) {
  const out = [];
  for (let i = 0; i < data.length; ) {
    const c = data[i++];
    if (c >= 1 && c <= 8) {
      for (let k = 0; k < c; k++) out.push(data[i++]);
    } else if (c < 0x80) out.push(c);
    else if (c >= 0xc0) out.push(0x20, c ^ 0x80);
    else {
      const v = (c << 8) | data[i++];
      const dist = (v >> 3) & 0x7ff;
      const len = (v & 7) + 3;
      const from = out.length - dist;
      if (dist === 0 || from < 0) throw new Error("bad PalmDOC back-reference");
      for (let k = 0; k < len; k++) out.push(out[from + k]);
    }
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// helpers

class Bytes {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  push(u8) {
    this.chunks.push(u8);
    this.length += u8.length;
    return this;
  }
  u8(v) {
    return this.push(Uint8Array.of(v & 0xff));
  }
  u16(v) {
    return this.push(Uint8Array.of((v >>> 8) & 0xff, v & 0xff));
  }
  u32(v) {
    return this.push(Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff));
  }
  str(s) {
    return this.push(enc.encode(s));
  }
  zeros(n) {
    return this.push(new Uint8Array(n));
  }
  done() {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

/** UTF-8: bytes needed after the record end to finish the last character */
function overlapAt(text, end) {
  if (end >= text.length) return 0;
  // walk back to the start of the character that contains byte end-1
  let s = end - 1;
  while (s > 0 && (text[s] & 0xc0) === 0x80 && end - s < 4) s--;
  const b = text[s];
  const len = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
  return Math.max(0, Math.min(s + len, text.length) - end);
}

// language → Windows LCID primary language id, as MOBI stores it
const LOCALES = { en: 9, fr: 12, de: 7, es: 10, it: 16, nl: 19, pt: 22, sv: 29, da: 6, fi: 11, no: 20, nb: 20,
  pl: 21, ru: 25, ja: 17, zh: 4, ca: 3, cs: 5, el: 8, hu: 14, ro: 24, tr: 31, ar: 1, he: 13, ko: 18 };

function palmName(title) {
  const s = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^-A-Za-z0-9]+/g, "_").slice(0, 31);
  return s || "book";
}

// ---------------------------------------------------------------------------

/**
 * @param {object} book
 * @param {Uint8Array} book.text  the whole MOBI HTML, UTF-8
 * @param {Uint8Array[]} book.images  in recindex order (recindex 1 = images[0])
 * @param {object} book.meta  {title, creators[], publisher, language, description, date, subjects[], isbn}
 * @param {number|null} book.coverIndex  0-based index into images, or null
 * @param {boolean} [book.compress=true]
 * @param {number} [book.now]  seconds since 1970 (tests pass a fixed value)
 * @param {number} [book.uid]
 * @returns {Uint8Array} the .mobi file
 */
export function writeMobi({ text, images = [], meta, coverIndex = null, compress = true, now, uid }) {
  const time = now ?? Math.floor(Date.now() / 1000);
  const uniqueId = (uid ?? Math.floor(Math.random() * 0xffffffff)) >>> 0;

  // text records
  const records = [null]; // record 0 is built last
  for (let p = 0; p < text.length; p += RECORD_SIZE) {
    const end = Math.min(p + RECORD_SIZE, text.length);
    const chunk = text.subarray(p, end);
    const extra = overlapAt(text, end);
    const body = compress ? palmdocCompress(chunk) : chunk;
    const rec = new Uint8Array(body.length + extra + 1);
    rec.set(body, 0);
    rec.set(text.subarray(end, end + extra), body.length);
    rec[body.length + extra] = extra; // multibyte trailing entry: size byte (low 2 bits)
    records.push(rec);
  }
  if (records.length === 1) records.push(Uint8Array.of(0)); // empty book: one empty text record
  const textRecordCount = records.length - 1;
  const firstNonBook = records.length;
  const firstImage = images.length ? records.length : 0xffffffff;
  for (const img of images) records.push(img);
  const lastContent = records.length - 1;

  const flisIndex = records.length;
  records.push(Uint8Array.from([0x46, 0x4c, 0x49, 0x53, 0, 0, 0, 8, 0, 0x41, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff,
    0, 1, 0, 3, 0, 0, 0, 3, 0, 0, 0, 1, 0xff, 0xff, 0xff, 0xff]));
  const fcisIndex = records.length;
  records.push(new Bytes()
    .push(Uint8Array.from([0x46, 0x43, 0x49, 0x53, 0, 0, 0, 0x14, 0, 0, 0, 0x10, 0, 0, 0, 2, 0, 0, 0, 0]))
    .u32(text.length)
    .push(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0x28, 0, 0, 0, 0, 0, 0, 0, 0x28, 0, 0, 0, 8, 0, 1, 0, 1, 0, 0, 0, 0]))
    .done());
  records.push(Uint8Array.of(0xe9, 0x8e, 0x0d, 0x0a)); // EOF

  // EXTH
  const exthRecs = [];
  const add = (type, data) => exthRecs.push([type, typeof data === "string" ? enc.encode(data) : data]);
  const u32 = (v) => new Bytes().u32(v).done();
  for (const c of meta.creators || []) add(100, c);
  if (meta.publisher) add(101, meta.publisher);
  if (meta.description) add(103, meta.description.slice(0, 4000));
  if (meta.isbn) add(104, meta.isbn);
  for (const s of meta.subjects || []) add(105, s);
  if (meta.date) add(106, meta.date);
  add(503, meta.title);
  add(524, meta.language || "en");
  add(501, "EBOK");
  if (coverIndex !== null && coverIndex !== undefined) {
    add(201, u32(coverIndex));
    add(203, u32(0));
  }
  add(204, u32(201)); // creator software: "kindlegen (Windows)"-compatible id
  add(205, u32(2));
  add(206, u32(9));
  add(207, u32(0));
  const exthBody = new Bytes();
  for (const [type, data] of exthRecs) exthBody.u32(type).u32(data.length + 8).push(data);
  const exth = new Bytes().str("EXTH").u32(exthBody.length + 12).u32(exthRecs.length).push(exthBody.done());
  exth.zeros(4 - (exth.length % 4));
  const exthBytes = exth.done();

  // record 0
  const title = enc.encode(meta.title || "Untitled");
  const MOBI_LEN = 0xe8;
  const lang = String(meta.language || "en").toLowerCase().split(/[-_]/)[0];
  const r0 = new Bytes()
    // PalmDOC header
    .u16(compress ? 2 : 1).u16(0).u32(text.length).u16(textRecordCount).u16(RECORD_SIZE).u16(0).u16(0)
    // MOBI header
    .str("MOBI").u32(MOBI_LEN).u32(2).u32(65001).u32(uniqueId).u32(6);
  for (let k = 0; k < 10; k++) r0.u32(0xffffffff); // ortho/inflection/names/keys/extra 0-5 indexes
  r0.u32(firstNonBook)
    .u32(16 + MOBI_LEN + exthBytes.length).u32(title.length)
    .u32(LOCALES[lang] ?? 0).u32(0).u32(0)
    .u32(6) // min reader version
    .u32(firstImage)
    .u32(0).u32(0).u32(0).u32(0) // huffman
    .u32(0x50) // EXTH present
    .zeros(32)
    .u32(0xffffffff).u32(0xffffffff).u32(0).u32(0) // no DRM
    .zeros(12)
    .u16(1).u16(lastContent)
    .u32(1)
    .u32(fcisIndex).u32(1).u32(flisIndex).u32(1)
    .zeros(8)
    .u32(0xffffffff).u32(0).u32(0xffffffff).u32(0xffffffff)
    .u32(1) // extra record data flags: multibyte trailing entries
    .u32(0xffffffff) // no INDX
    .push(exthBytes)
    .push(title)
    .zeros(4 - (title.length % 4))
    .zeros(8192); // room kindlegen leaves for publishing tools
  records[0] = r0.done();

  // PalmDB container
  const n = records.length;
  const db = new Bytes();
  const name = enc.encode(palmName(meta.title || "book"));
  db.push(name).zeros(32 - name.length)
    .u16(0).u16(0).u32(time).u32(time).u32(0).u32(0).u32(0).u32(0)
    .str("BOOK").str("MOBI")
    .u32(2 * n - 1).u32(0).u16(n);
  let offset = 78 + 8 * n + 2;
  for (let k = 0; k < n; k++) {
    db.u32(offset).u32(2 * k); // attributes 0 + 24-bit unique id
    offset += records[k].length;
  }
  db.zeros(2);
  for (const r of records) db.push(r);
  return db.done();
}

/**
 * Reads a MOBI file back (used by the tests, the in-container smoke and the
 * page's own self-check after each conversion).
 */
export function readMobi(file) {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const type = new TextDecoder().decode(file.subarray(60, 68));
  if (type !== "BOOKMOBI") throw new Error(`not a MOBI file (${type})`);
  const n = dv.getUint16(76);
  const offs = [];
  for (let k = 0; k < n; k++) offs.push(dv.getUint32(78 + 8 * k));
  offs.push(file.length);
  const rec = (k) => file.subarray(offs[k], offs[k + 1]);
  const r0 = rec(0);
  const h = new DataView(r0.buffer, r0.byteOffset, r0.byteLength);
  const compression = h.getUint16(0);
  const textLength = h.getUint32(4);
  const textRecords = h.getUint16(8);
  if (new TextDecoder().decode(r0.subarray(16, 20)) !== "MOBI") throw new Error("no MOBI header");
  const headerLen = h.getUint32(20);
  const encoding = h.getUint32(28);
  const firstImage = h.getUint32(16 + 0x5c);
  const exthFlags = h.getUint32(16 + 0x70);
  const extraFlags = headerLen >= 0xe4 ? h.getUint16(16 + 0xe2) : 0;
  const nameOff = h.getUint32(16 + 0x44);
  const nameLen = h.getUint32(16 + 0x48);
  const title = new TextDecoder().decode(r0.subarray(nameOff, nameOff + nameLen));
  const exth = new Map();
  if (exthFlags & 0x40) {
    const e = 16 + headerLen;
    if (new TextDecoder().decode(r0.subarray(e, e + 4)) !== "EXTH") throw new Error("EXTH missing");
    const count = h.getUint32(e + 8);
    let p = e + 12;
    for (let k = 0; k < count; k++) {
      const t = h.getUint32(p);
      const l = h.getUint32(p + 4);
      const data = r0.subarray(p + 8, p + l);
      if (!exth.has(t)) exth.set(t, []);
      exth.get(t).push(data);
      p += l;
    }
  }
  const parts = [];
  let total = 0;
  for (let k = 1; k <= textRecords; k++) {
    let r = rec(k);
    // strip trailing entries (only the multibyte one is written by this tool; others are size-coded)
    for (let bit = 15; bit >= 1; bit--) {
      if (!(extraFlags & (1 << bit))) continue;
      let size = 0;
      for (let q = r.length - 1, shift = 0; q >= Math.max(0, r.length - 4); q--, shift += 7) {
        size |= (r[q] & 0x7f) << shift;
        if (r[q] & 0x80) break;
      }
      r = r.subarray(0, r.length - size);
    }
    if (extraFlags & 1) r = r.subarray(0, r.length - ((r[r.length - 1] & 3) + 1));
    const t = compression === 2 ? palmdocDecompress(r) : r;
    if (k < textRecords && t.length !== RECORD_SIZE) throw new Error(`text record ${k} is ${t.length} bytes`);
    parts.push(t);
    total += t.length;
  }
  if (total !== textLength) throw new Error(`text length ${total} ≠ header ${textLength}`);
  const text = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    text.set(p, o);
    o += p.length;
  }
  const images = [];
  if (firstImage !== 0xffffffff) {
    for (let k = firstImage; k < n; k++) {
      const r = rec(k);
      const sig = new TextDecoder().decode(r.subarray(0, 4));
      if (sig === "FLIS" || sig === "FCIS" || sig === "SRCS" || sig === "DATP" || (r.length === 4 && r[0] === 0xe9)) break;
      images.push(r);
    }
  }
  return { title, encoding, compression, text, html: new TextDecoder().decode(text), images, exth, records: n };
}
