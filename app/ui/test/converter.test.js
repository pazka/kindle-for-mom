import assert from "node:assert/strict";
import { test } from "node:test";
import { Converter } from "../js/converter.js";

function fakeApi() {
  const calls = [];
  return {
    calls,
    readBook: async (id) => { calls.push(["read", id]); if (id === "gone") throw new Error("missing"); return new Uint8Array([1]); },
    saveKindleCopy: async (id) => calls.push(["save", id]),
    saveConversionError: async (id, code) => calls.push(["error", id, code]),
    renameBook: async (id, name) => { calls.push(["rename", id, name]); return name; },
  };
}

test("converts, saves and renames, one at a time", async () => {
  const api = fakeApi();
  const done = [];
  let running = 0;
  const conv = new Converter({
    api,
    convert: async () => {
      running++;
      assert.equal(running, 1, "never two conversions at once");
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { mobi: new Uint8Array([9]), meta: { title: "Candide", creators: ["Voltaire"] }, warnings: [] };
    },
    onDone: (r) => done.push(r),
  });
  conv.enqueue(["pg1", "pg2"]);
  await conv.enqueue(["pg1"]); // duplicate ignored
  assert.deepEqual(done.map((d) => d.id), ["Candide - Voltaire", "Candide - Voltaire"]);
  assert.equal(api.calls.filter((c) => c[0] === "read").length, 2);
});

test("maps converter errors to codes and never retries a broken book", async () => {
  const api = fakeApi();
  const done = [];
  const conv = new Converter({
    api,
    convert: async (bytes) => { throw Object.assign(new Error("x"), { code: bytes.length ? "drm" : "internal" }); },
    onDone: (r) => done.push(r),
  });
  await conv.enqueue(["a", "gone"]);
  assert.deepEqual(api.calls.find((c) => c[0] === "error"), ["error", "a", "drm"]);
  assert.deepEqual(done.map((d) => [d.id, d.ok, d.code]), [["a", false, "drm"], ["gone", false, "io"]]);
  await conv.enqueue(["gone"]);
  assert.equal(api.calls.filter((c) => c[1] === "gone").length, 1, "failed book not retried in the same session");
});

test("unknown converter errors are stored as 'convert'", async () => {
  const api = fakeApi();
  const conv = new Converter({ api, convert: async () => { throw new Error("weird"); } });
  await conv.enqueue(["b"]);
  assert.deepEqual(api.calls.at(-1), ["error", "b", "convert"]);
});
