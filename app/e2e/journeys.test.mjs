// Mom's journeys, end to end in a real browser engine (Chromium, like
// WebView2), against the fake backend. If one of these breaks, a release
// must not ship. Run: npm run e2e (after npm run build:ui).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { makeZip, sampleEpub } from "../converter/test/fixtures.js";
import { chromium, openApp, startServer } from "./harness.mjs";

let browser, server, url;
before(async () => {
  ({ server, url } = await startServer());
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});

/** Guide already seen, tips acknowledged: the everyday screen. */
const everyday = (f) => {
  f.state.ui = { guideDone: true, tips: ["kindle", "firstPut", "take"] };
};

async function withApp(seeds, fn) {
  const { page, context, errors } = await openApp(browser, url, seeds);
  try {
    await page.waitForSelector("#pc-list");
    await fn(page);
    assert.deepEqual(errors.map(String), [], "no JavaScript error on the page");
  } finally {
    await context.close();
  }
}

const fakeState = (page) => page.evaluate(() => JSON.parse(JSON.stringify({ ...window.__fake.state, seen: [...window.__fake.state.seen], trash: [] })));
const toastText = (page) => page.locator("#toasts").innerText();

test("first start shows the guide once, and Aide replays it", async () => {
  await withApp([], async (page) => {
    await page.waitForSelector("#guide:not([hidden])");
    assert.equal(await page.locator("#g-title").innerText(), "Bienvenue !");
    for (let i = 0; i < 6; i++) await page.click("#g-next");
    assert.equal(await page.locator("#g-next").innerText(), "C'est parti !");
    await page.click("#g-next");
    await page.waitForSelector("#guide", { state: "hidden" });
    await page.waitForFunction(() => window.__fake.state.ui.guideDone === true);
    await page.click("#btn-help");
    await page.waitForSelector("#guide:not([hidden])");
  });
});

test("plugging the Kindle is detected without any choice", async () => {
  await withApp([everyday, (f) => f.addPcBook("Germinal - Émile Zola", "mobi", 900_000)], async (page) => {
    assert.equal(await page.locator("#k-off").isVisible(), true);
    assert.equal(await page.locator(".book-action").count(), 0, "no transfer button while unplugged");
    await page.evaluate(() => window.__fake.plug());
    await page.waitForSelector("#k-detected:not([hidden])", { timeout: 5000 });
    assert.match(await page.locator("#k-detected").innerText(), /Liseuse détectée/);
    assert.match(await page.locator("#gauge-text").innerText(), /place/);
    await page.evaluate(() => window.__fake.unplug());
    await page.waitForSelector("#k-off:not([hidden])", { timeout: 5000 });
  });
});

test("put a book on the Kindle, then take it back", async () => {
  await withApp([everyday, (f) => { f.plug(); f.addPcBook("Germinal - Émile Zola", "mobi", 900_000); }], async (page) => {
    await page.click(".book-action");
    await page.waitForSelector(".k-item");
    assert.match(await page.locator(".k-title").innerText(), /Germinal/);
    assert.match(await page.locator("#pc-list").innerText(), /Dans la liseuse/);
    assert.match(await toastText(page), /est dans la liseuse/);

    await page.click(".k-item button");
    await page.waitForSelector("#k-empty:not([hidden])");
    assert.match(await toastText(page), /rangé.*page est gardée/s);
    assert.equal((await fakeState(page)).pc.length, 1, "still on the PC, no duplicate");
  });
});

test("a book only on the Kindle is saved on the PC when taken off", async () => {
  await withApp([everyday, (f) => { f.plug(); f.addKindleBook("B00ABC_EBOK.azw", "Le Petit Prince", "Saint-Exupéry", 900_000, "azw"); }], async (page) => {
    await page.click(".k-item button");
    await page.waitForSelector("li.book");
    assert.match(await page.locator("li.book").innerText(), /Le Petit Prince/);
    assert.match(await toastText(page), /mis sur l'ordinateur/);
  });
});

test("a full Kindle explains what to do instead of failing", async () => {
  await withApp([everyday, (f) => { f.plug(40 * 1024 * 1024); f.addPcBook("Atlas", "pdf", 30 * 1024 * 1024); }], async (page) => {
    await page.click(".book-action");
    await page.waitForSelector(".toast.error");
    assert.match(await toastText(page), /plus assez de place/);
    assert.equal(await page.locator(".k-item").count(), 0);
  });
});

test("preparing a trip tells whether the books fit, then copies them", async () => {
  const seed = (f) => {
    f.plug(60 * 1024 * 1024);
    f.addPcBook("A - X", "mobi", 10 * 1024 * 1024);
    f.addPcBook("B - Y", "mobi", 10 * 1024 * 1024);
    f.addPcBook("C - Z", "pdf", 30 * 1024 * 1024);
  };
  await withApp([everyday, seed], async (page) => {
    await page.click("#trip-start");
    await page.click("li.book >> nth=0");
    await page.click("li.book >> nth=1");
    assert.match(await page.locator("#trip-info").innerText(), /2 livres.*ça rentre/);
    await page.click("li.book >> nth=2");
    assert.match(await page.locator("#trip-info").innerText(), /il manque/);
    assert.equal(await page.locator("#trip-go").isDisabled(), true);
    await page.click("li.book >> nth=2");
    await page.click("#trip-go");
    await page.waitForFunction(() => document.querySelectorAll(".k-item").length === 2);
    assert.match(await toastText(page), /Bon voyage/);
  });
});

test("a new download is offered once; 'Non merci' is remembered", async () => {
  await withApp([everyday, (f) => { f.addDownload("Candide - Voltaire.mobi"); f.addDownload("Zadig.pdf"); }], async (page) => {
    await page.waitForSelector(".offer >> nth=1", { timeout: 5000 });
    await page.click(".offer:has-text('Candide') >> text=L'ajouter");
    await page.waitForSelector("li.book:has-text('Candide')");
    await page.click(".offer:has-text('Zadig') >> text=Non merci");
    await page.waitForFunction(() => window.__fake.state.seen.size === 2);
    const st = await fakeState(page);
    assert.equal(st.pc.length, 1);
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".offer").count(), 0);
  });
});

test("an EPUB is converted in the background and renamed from its metadata", async () => {
  const epub = Buffer.from(sampleEpub()).toString("base64");
  await withApp(
    [everyday, new Function("f", `f.addPcBook("pg12345-images", "epub", 20000, { bytes: Uint8Array.from(atob("${epub}"), c => c.charCodeAt(0)) });`)],
    async (page) => {
      await page.waitForFunction(() => window.__fake.state.pc[0]?.ready === true && !window.__fake.state.pc[0].id.startsWith("pg"), null, { timeout: 15000 });
      const b = (await fakeState(page)).pc[0];
      assert.equal(b.title, "Le Livre d’Été");
      assert.ok(b.author, "author taken from the EPUB");
      assert.ok(b.kindle_size > 1000, "a real MOBI was saved");
      assert.ok((await page.evaluate(() => window.__fake.calls)).includes("save_kindle_copy"));
    },
  );
});

test("a DRM-protected EPUB is marked red with a kind message", async () => {
  const drm = Buffer.from(makeZip([
    ["mimetype", "application/epub+zip"],
    ["META-INF/container.xml", '<container><rootfiles><rootfile full-path="c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
    ["META-INF/encryption.xml", '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><CipherData><CipherReference URI="ch1.xhtml"/></CipherData></EncryptedData></encryption>'],
    ["c.opf", '<package version="2.0"><metadata><dc:title>x</dc:title></metadata><manifest><item id="a" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/></spine></package>'],
    ["ch1.xhtml", "garbage"],
  ])).toString("base64");
  await withApp(
    [everyday, new Function("f", `f.addPcBook("Acheté", "epub", 2000, { bytes: Uint8Array.from(atob("${drm}"), c => c.charCodeAt(0)) });`)],
    async (page) => {
      await page.waitForSelector(".light.rouge", { timeout: 10000 });
      assert.match(await toastText(page), /protégé contre la copie/);
      assert.equal((await fakeState(page)).pc[0].error, "drm");
    },
  );
});

test("deleting a book can be undone", async () => {
  await withApp([everyday, (f) => f.addPcBook("Germinal - Émile Zola", "mobi", 900_000)], async (page) => {
    await page.click("li.book");
    await page.click("#d-actions >> text=Supprimer de l'ordinateur");
    await page.waitForSelector("#pc-empty:not([hidden])");
    await page.click(".toast >> text=Annuler");
    await page.waitForSelector("li.book:has-text('Germinal')");
  });
});

test("'J'ai fini' ejects and tells her she can unplug", async () => {
  await withApp([everyday, (f) => f.plug()], async (page) => {
    await page.click("#btn-eject");
    await page.waitForSelector("#bigmsg:not([hidden])");
    assert.match(await page.locator("#bm-text").innerText(), /débrancher le câble/);
    assert.equal(await page.evaluate(() => window.__fake.ejected), true);
  });
});

test("dropping a file from File Explorer adds it", async () => {
  await withApp([everyday], async (page) => {
    await page.evaluate(() => window.__fake.drop(["C:\\Users\\Maman\\Bureau\\Les Fleurs du mal - Baudelaire.epub", "C:\\photo.jpg"]));
    await page.waitForSelector("li.book:has-text('Les Fleurs du mal')");
    assert.match(await toastText(page), /n'est pas un livre/);
  });
});

test("the first tip points at the transfer button, and is shown only once", async () => {
  await withApp([(f) => { f.state.ui = { guideDone: true, tips: ["kindle"] }; f.plug(); f.addPcBook("A - B", "mobi", 1000); }], async (page) => {
    await page.waitForSelector("#tip:not([hidden])");
    assert.match(await page.locator("#tip-text").innerText(), /mettre ce livre/);
    await page.click("#tip-ok");
    await page.waitForFunction(() => window.__fake.state.ui.tips?.includes("firstPut"));
  });
});
