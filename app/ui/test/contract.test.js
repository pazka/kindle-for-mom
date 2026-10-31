// The UI, the fake backend and the Rust shell must agree on the command
// list: a renamed command would otherwise only break on Mom's PC.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const rust = read("../../src-tauri/src/main.rs");
const handler = rust.match(/generate_handler!\[([\s\S]*?)\]/)[1].split(",").map((s) => s.trim()).filter(Boolean).sort();
const definedInRust = [...rust.matchAll(/#\[tauri::command\]\s*async fn (\w+)/g)].map((m) => m[1]).sort();
const usedByUi = [...new Set([...read("../js/api.js").matchAll(/invoke\("(\w+)"/g)].map((m) => m[1]))].sort();
const fakeBlock = read("./fake-backend.js").match(/const commands = \{([\s\S]*?)\n  \};/)[1];
const fake = [...fakeBlock.matchAll(/^    (\w+)[:,]/gm)].map((m) => m[1]).sort();

test("every Rust command is registered", () => assert.deepEqual(handler, definedInRust));
test("the UI only calls registered commands", () => assert.deepEqual(usedByUi.filter((c) => !handler.includes(c)), []));
test("every registered command is used by the UI", () => assert.deepEqual(handler.filter((c) => !usedByUi.includes(c)), []));
test("the fake backend implements exactly the registered commands", () => assert.deepEqual(fake, handler));
