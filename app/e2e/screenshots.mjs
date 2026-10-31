// Renders the main screens to e2e/screenshots/ (for review, not a test).
import { mkdirSync } from "node:fs";
import { chromium, openApp, startServer } from "./harness.mjs";

const out = new URL("./screenshots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const { server, url } = await startServer();
const browser = await chromium.launch();

const library = (f) => {
  f.state.ui = { guideDone: true, tips: ["kindle", "firstPut"] };
  f.addPcBook("Le Comte de Monte-Cristo - Alexandre Dumas", "epub", 1_800_000, { ready: true, converting: false, kindle_size: 2_300_000 });
  f.addPcBook("Les Misérables - Victor Hugo", "mobi", 2_600_000);
  f.addPcBook("Recettes de grand-mère", "pdf", 31_000_000);
  f.addPcBook("Germinal - Émile Zola", "epub", 900_000, { ready: true, converting: false, kindle_size: 1_100_000 });
  f.addPcBook("Madame Bovary - Gustave Flaubert", "azw3", 700_000);
  f.addPcBook("Livre acheté protégé", "epub", 500_000, { converting: false, error: "drm", light: "rouge", advice: "Ce livre est protégé contre la copie : il ne peut pas aller sur cette liseuse." });
};

const shots = [
  ["1-guide-premier-demarrage", (f) => {}],
  ["2-bibliotheque-sans-liseuse", library],
  ["3-liseuse-branchee", [library, (f) => {
    f.plug(); f.addKindleBook("Les Misérables - Victor Hugo.mobi", "Les Misérables", "Victor Hugo", 2_600_000);
    f.addKindleBook("B00ABC_EBOK.azw", "Le Petit Prince", "Antoine de Saint-Exupéry", 900_000);
  }]],
  ["4-presque-pleine", [library, (f) => { f.plug(160 * 1024 * 1024); f.addKindleBook("Gros.pdf", "Atlas du monde", null, 125 * 1024 * 1024, "pdf"); }]],
  ["5-nouveau-telechargement", [library, (f) => { f.addDownload("Candide - Voltaire.epub"); }]],
];

for (const [name, seed] of shots) {
  const { page, context, errors } = await openApp(browser, url, seed);
  await page.waitForTimeout(name.startsWith("5") ? 2500 : 900);
  await page.screenshot({ path: `${out}${name}.png` });
  if (errors.length) console.error(name, errors);
  await context.close();
}
// trip mode
{
  const { page, context } = await openApp(browser, url, (f) => {
    f.state.ui = { guideDone: true, tips: ["kindle", "firstPut"] };
    f.addPcBook("Le Comte de Monte-Cristo - Alexandre Dumas", "mobi", 2_300_000);
    f.addPcBook("Germinal - Émile Zola", "mobi", 900_000);
    f.addPcBook("Madame Bovary - Gustave Flaubert", "azw3", 700_000);
    f.plug();
  });
  await page.waitForTimeout(600);
  await page.click("#trip-start");
  await page.click("li.book >> nth=0");
  await page.click("li.book >> nth=1");
  await page.screenshot({ path: `${out}6-preparer-un-voyage.png` });
  await context.close();
}
await browser.close();
server.close();
console.log("screenshots in", out);
