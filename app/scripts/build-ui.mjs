// Assembles the web view into dist/: the UI sources plus the converter
// module. No bundler, no dependencies: plain ES modules copied as-is.
import { cpSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(app, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
cpSync(join(app, "ui"), dist, { recursive: true, filter: (src) => !src.includes(`${join(app, "ui", "test")}`) });
cpSync(join(app, "converter", "src"), join(dist, "converter"), { recursive: true });
console.log("UI assembled in", dist);
