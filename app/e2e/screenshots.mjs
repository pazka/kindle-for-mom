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
    f.plug(); f.addKindleBook("Hugo, Victor/Les Miserables.mobi", "Les Misérables", "Hugo, Victor", 2_600_000);
    f.addKindleBook("Asimov, Isaac/L'aube de Fondation.mobi", "L'aube de Fondation", "Asimov, Isaac", 600_000);
    f.addKindleBook("Saint-Exupery, Antoine de/Le Petit Prince.azw", "Le Petit Prince", "Saint-Exupéry, Antoine de", 900_000, "azw");
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
// ticking books for a trip, on a laptop screen
{
  const { page, context } = await openApp(browser, url, [library, (f) => {
    f.plug();
    for (let i = 1; i <= 60; i++) f.addPcBook(`Roman numéro ${i} - Auteur ${i % 9}`, "mobi", 350_000 + i * 1000);
    for (let i = 1; i <= 25; i++) f.addKindleBook(`k${i}.mobi`, `Livre déjà dans la liseuse ${i}`, `Auteur ${i % 5}`, 500_000);
  }], { viewport: { width: 1366, height: 768 } });
  await page.waitForTimeout(600);
  for (let n = 0; n < 4; n++) await page.locator("li.book input[type=checkbox]").nth(n).click();
  await page.screenshot({ path: `${out}6-cocher-pour-un-voyage-portable.png` });
  await context.close();
}
{
  const { page, context } = await openApp(browser, url, [library, (f) => f.plug()], { viewport: { width: 1024, height: 600 } });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}7-petit-portable-1024x600.png` });
  await context.close();
}
await browser.close();
server.close();
console.log("screenshots in", out);
