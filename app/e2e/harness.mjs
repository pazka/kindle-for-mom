// Serves dist/ on a random local port and opens it in Chromium with the
// fake backend injected. Used by the end-to-end tests and the screenshot script.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const app = fileURLToPath(new URL("..", import.meta.url));
const dist = join(app, "dist");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

export async function startServer() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^([/\\])+/, "");
    try {
      const file = path || "index.html";
      const body = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

/** New page with the fake backend; `seed(fake)` (or an array of them) runs before the app starts. */
export async function openApp(browser, url, seed = () => {}, { viewport = { width: 1366, height: 768 } } = {}) {
  const context = await browser.newContext({ viewport, locale: "fr-FR" });
  await context.addInitScript({ path: join(app, "ui", "test", "fake-backend.js") });
  for (const fn of [seed].flat()) await context.addInitScript(`(${fn.toString()})(window.__fake)`);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  await page.goto(url);
  return { page, context, errors };
}

export { chromium };
