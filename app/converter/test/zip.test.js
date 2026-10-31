import assert from "node:assert/strict";
import { test } from "node:test";

import { openZip, ZipError } from "../src/zip.js";
import { makeZip } from "./fixtures.js";

test("reads stored and deflated entries, case-insensitively", async () => {
  const z = openZip(makeZip([["mimetype", "application/epub+zip"], ["OEBPS/Ch1.xhtml", "é".repeat(5000)]]));
  assert.deepEqual(z.names, ["mimetype", "OEBPS/Ch1.xhtml"]);
  assert.equal(await z.text("mimetype"), "application/epub+zip");
  assert.equal(await z.text("oebps/ch1.XHTML"), "é".repeat(5000));
  assert.equal(z.has("OEBPS/ch1.xhtml"), true);
  assert.equal(z.has("nope"), false);
  await assert.rejects(z.read("nope"), ZipError);
});

test("strips a UTF-8 BOM in text()", async () => {
  const z = openZip(makeZip([["a.xml", "﻿<x/>"]]));
  assert.equal(await z.text("a.xml"), "<x/>");
});

test("rejects garbage, truncated and zip64 archives", () => {
  assert.throws(() => openZip(new TextEncoder().encode("hello")), ZipError);
  const zip = makeZip([["a", "b"]]);
  assert.throws(() => openZip(zip.subarray(0, zip.length - 30)), ZipError);
  const z64 = zip.slice();
  const dv = new DataView(z64.buffer);
  dv.setUint32(z64.length - 22 + 16, 0xffffffff, true);
  assert.throws(() => openZip(z64), /zip64/);
});

test("refuses encrypted entries and unknown compression", async () => {
  const zip = makeZip([["a.txt", "secret"], ["b.txt", "x"]]);
  const dv = new DataView(zip.buffer);
  const cd = dv.getUint32(zip.length - 22 + 16, true);
  dv.setUint16(cd + 8, dv.getUint16(cd + 8, true) | 1, true); // a.txt: encrypted flag
  const nameLen = dv.getUint16(cd + 28, true);
  const second = cd + 46 + nameLen;
  dv.setUint16(second + 10, 14, true); // b.txt: LZMA
  const z = openZip(zip);
  await assert.rejects(z.read("a.txt"), /encrypted/);
  await assert.rejects(z.read("b.txt"), /unsupported compression/);
});

test("non-UTF-8 names fall back to CP437", () => {
  const zip = makeZip([["café.txt", "x"]]);
  const dv = new DataView(zip.buffer);
  const cd = dv.getUint32(zip.length - 22 + 16, true);
  dv.setUint16(cd + 8, 0, true); // clear the UTF-8 flag
  // replace the 2-byte UTF-8 "é" with CP437 0x82 + pad: rebuild name bytes "caf\x82.txt" is shorter,
  // so check the fatal-decoder path instead: invalid UTF-8 byte 0x82 alone
  const nameAt = cd + 46;
  zip[nameAt + 3] = 0x82;
  zip[nameAt + 4] = 0x2e; // "."
  const names = openZip(zip).names;
  assert.ok(names[0].startsWith("café."), names[0]);
});
