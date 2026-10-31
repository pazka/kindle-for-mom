// Fails unless package.json, Cargo.toml and tauri.conf.json carry the same
// version, and (when given) it matches the release tag: `node check-version.mjs v1.2.3`.
import { readFileSync } from "node:fs";

const app = new URL("..", import.meta.url);
const read = (p) => readFileSync(new URL(p, app), "utf8");
const versions = {
  "Cargo.toml": read("Cargo.toml").match(/\[workspace\.package\][^[]*?version = "([^"]+)"/)[1],
  "tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version,
  "package.json": JSON.parse(read("package.json")).version,
};
const tag = process.argv[2]?.replace(/^v/, "");
const all = new Set(Object.values(versions));
if (all.size !== 1 || (tag && !all.has(tag))) {
  console.error("Version mismatch:", versions, tag ? `tag ${tag}` : "");
  process.exit(1);
}
console.log("version", [...all][0], "ok");
