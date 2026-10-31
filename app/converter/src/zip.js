/**
 * Minimal ZIP reader for EPUB files (no dependency). Reads the central
 * directory, supports "stored" and "deflate" entries (the only two methods an
 * EPUB may use) and inflates with the platform's DecompressionStream, which
 * exists in every current browser and in Node >= 18.
 */

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

export class ZipError extends Error {}

/** CP437 high half, used when an entry name is not flagged as UTF-8. */
const CP437 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

function decodeName(bytes, utf8) {
  if (utf8) return new TextDecoder("utf-8").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    let s = "";
    for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80];
    return s;
  }
}

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {Uint8Array} buf the whole .zip/.epub file
 * @returns {{ names: string[], has(name): boolean, read(name): Promise<Uint8Array>, text(name): Promise<string> }}
 */
export function openZip(buf) {
  if (!(buf instanceof Uint8Array)) buf = new Uint8Array(buf);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: last 22 bytes + up to 64 KiB of comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip file");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (p === 0xffffffff || count === 0xffff) throw new ZipError("zip64 archives are not supported");

  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== SIG_CEN) throw new ZipError("corrupt central directory");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = decodeName(buf.subarray(p + 46, p + 46 + nlen), (flags & 0x800) !== 0);
    if (!name.endsWith("/")) entries.set(name, { method, csize, usize, local, encrypted: (flags & 1) !== 0 });
    p += 46 + nlen + xlen + clen;
  }

  // EPUBs made on Windows sometimes differ in case only: keep a case-insensitive index too.
  const lower = new Map();
  for (const k of entries.keys()) if (!lower.has(k.toLowerCase())) lower.set(k.toLowerCase(), k);
  const resolve = (name) => (entries.has(name) ? name : lower.get(String(name).toLowerCase()));

  async function read(name) {
    const key = resolve(name);
    if (key === undefined) throw new ZipError(`missing file in book: ${name}`);
    const e = entries.get(key);
    if (e.encrypted) throw new ZipError("encrypted zip entry");
    if (dv.getUint32(e.local, true) !== SIG_LOC) throw new ZipError(`corrupt entry: ${key}`);
    const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
    const raw = buf.subarray(start, start + e.csize);
    if (e.method === 0) return raw.slice();
    if (e.method === 8) return inflateRaw(raw);
    throw new ZipError(`unsupported compression method ${e.method} for ${key}`);
  }

  return {
    names: [...entries.keys()],
    has: (name) => resolve(name) !== undefined,
    read,
    text: async (name) => new TextDecoder("utf-8").decode(await read(name)).replace(/^﻿/, ""),
  };
}
