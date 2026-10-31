// Mom's journeys, end to end in a real browser engine (Chromium, like
// WebView2), against the fake backend. If one of these breaks, a release
// must not ship. Run: npm run e2e (after npm run build:ui).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { makeZip, sampleEpub } from "../converter/test/fixtures.js";
import { GUIDE_STEPS } from "../ui/js/guide.js";
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
    for (let i = 0; i < GUIDE_STEPS.length - 1; i++) await page.click("#g-next");
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

test("her sorted Kindle: everything only on the Kindle is backed up in one click, the Kindle unchanged", async () => {
  const seed = (f) => {
    f.plug();
    f.addKindleBook("Hugo, Victor/Les Miserables.mobi", "Les Misérables", "Hugo, Victor", 1_200_000);
    for (let i = 1; i <= 24; i++) f.addKindleBook(`Asimov, Isaac/Fondation ${i}.mobi`, `Fondation ${i}`, "Asimov, Isaac", 500_000);
    f.addPcBook("Les Misérables - Hugo, Victor", "mobi", 1_200_000);
  };
  await withApp([everyday, seed], async (page) => {
    await page.waitForSelector("#k-save:not([hidden])");
    assert.match(await page.locator("#k-save-text").innerText(), /24 livres ne sont que sur la liseuse/);
    await page.click("#k-save-go");
    await page.waitForFunction(() => document.querySelector("#k-save").hidden, null, { timeout: 15000 });
    assert.match(await toastText(page), /24 livres sauvegardés sur l'ordinateur\. La liseuse n'a pas changé/);
    const st = await fakeState(page);
    assert.equal(st.kindle.books.length, 25, "nothing removed from the Kindle");
    assert.equal(st.pc.length, 25);
    // the book that was already on the PC is recognised, not copied twice
    assert.equal(st.pc.filter((b) => b.title === "Les Misérables").length, 1);
  });
});

test("a new version is installed at start with a calm message, before anything else", async () => {
  const { page, context } = await openApp(browser, url, [everyday, (f) => { f.state.update = "0.3.0"; f.plug(); f.addPcBook("Candide - Voltaire", "mobi", 400_000); }]);
  try {
    await page.waitForSelector("#updating:not([hidden])");
    assert.match(await page.locator("#updating").innerText(), /se met à jour.*se rouvrir toute seule/s);
    assert.equal(await page.evaluate(() => window.__fake.installed), "0.3.0");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#updating").isVisible(), true, "can't be dismissed");
    assert.equal(await page.locator("li.book").count(), 0, "nothing else starts during the update");
  } finally {
    await context.close();
  }
});

test("no update, or no internet: the app starts as usual", async () => {
  await withApp([everyday, (f) => { f.addPcBook("Candide - Voltaire", "mobi", 400_000); }], async (page) => {
    await page.waitForSelector("li.book");
    assert.equal(await page.locator("#updating").isVisible(), false);
  });
});

test("a Kindle with many books: she's told it is detected while its list is read", async () => {
  await withApp([everyday], async (page) => {
    await page.evaluate(() => { window.__fake.state.overviewDelay = 3000; window.__fake.plug(); window.__fake.addKindleBook("Hugo, Victor/Les Miserables.mobi", "Les Misérables", "Hugo, Victor"); });
    await page.waitForSelector("#k-reading:not([hidden])");
    assert.match(await page.locator("#k-reading").innerText(), /Liseuse détectée.*première fois/s);
    assert.equal(await page.locator("#k-off").isVisible(), false, "no longer asks to plug it in");
    await page.waitForSelector(".k-item", { timeout: 10000 });
    assert.equal(await page.locator("#k-reading").isVisible(), false);
  });
});

test("'Tout cocher' on the Kindle side puts everything back on the computer in one go", async () => {
  const seed = (f) => {
    f.plug();
    for (let i = 1; i <= 12; i++) f.addKindleBook(`Auteur, Un/Livre ${i}.mobi`, `Livre ${i}`, "Auteur, Un", 400_000);
  };
  await withApp([everyday, seed], async (page) => {
    await page.click("#k-all-box");
    assert.match(await page.locator("#k-bar-text").innerText(), /12 livres cochés/);
    await page.click("#k-bar-go");
    await page.waitForFunction(() => document.querySelectorAll(".k-item").length === 0, null, { timeout: 15000 });
    assert.match(await toastText(page), /12 livres rangés/);
    const st = await fakeState(page);
    assert.equal(st.pc.length, 12, "every book is on the computer");
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

test("ticking many books tells whether they fit, then copies them with a progress bar", async () => {
  const seed = (f) => {
    f.plug(60 * 1024 * 1024);
    f.addPcBook("A - X", "mobi", 10 * 1024 * 1024);
    f.addPcBook("B - Y", "mobi", 10 * 1024 * 1024);
    f.addPcBook("C - Z", "pdf", 30 * 1024 * 1024);
  };
  await withApp([everyday, seed], async (page) => {
    const box = (n) => page.locator("li.book input[type=checkbox]").nth(n);
    await box(0).click();
    await box(1).click();
    assert.match(await page.locator("#pc-bar-text").innerText(), /2 livres.*ça rentre/);
    await box(2).click();
    assert.match(await page.locator("#pc-bar-text").innerText(), /il manque/);
    assert.equal(await page.locator("#pc-bar-go").isDisabled(), true);
    await box(2).click();
    await page.click("#pc-bar-go");
    await page.waitForFunction(() => document.querySelectorAll(".k-item").length === 2);
    assert.match(await toastText(page), /2 livres sont dans la liseuse/);
    assert.equal(await page.locator("#progress").isHidden(), true);
  });
});

test("'Tout cocher' ticks every visible book, and the Kindle side unloads in bulk", async () => {
  const seed = (f) => {
    f.plug();
    for (let i = 1; i <= 30; i++) f.addPcBook(`Livre ${String(i).padStart(2, "0")} - Auteur`, "mobi", 400_000);
  };
  await withApp([everyday, seed], async (page) => {
    await page.click("#pc-all-box");
    assert.match(await page.locator("#pc-bar-go").innerText(), /ces 30 livres/);
    await page.click("#pc-bar-go");
    await page.waitForFunction(() => document.querySelectorAll(".k-item").length === 30, null, { timeout: 15000 });
    assert.match(await page.locator("#k-count").innerText(), /30 livres/);

    for (let n = 0; n < 3; n++) await page.locator(".k-item input").nth(n).click();
    assert.match(await page.locator("#k-bar-text").innerText(), /3 livres cochés/);
    await page.click("#k-bar-go");
    await page.waitForFunction(() => document.querySelectorAll(".k-item").length === 27);
    assert.match(await toastText(page), /3 livres rangés/);
  });
});

test("with hundreds of books, search and filters find a book fast", async () => {
  const seed = (f) => {
    f.plug();
    for (let i = 1; i <= 400; i++) f.addPcBook(`Roman ${i} - Auteur ${i % 37}`, "mobi", 300_000);
    f.addPcBook("Germinal - Émile Zola", "mobi", 900_000);
    f.addKindleBook("Germinal - Émile Zola.mobi", "Germinal", "Émile Zola", 900_000);
  };
  await withApp([everyday, seed], async (page) => {
    await page.waitForFunction(() => document.querySelectorAll("li.book").length === 401);
    await page.fill("#pc-search", "emile");
    await page.waitForFunction(() => document.querySelectorAll("li.book").length === 1);
    assert.match(await page.locator("li.book").innerText(), /Germinal/);
    await page.fill("#pc-search", "");
    await page.click("[data-filter=kindle]");
    assert.equal(await page.locator("li.book").count(), 1);
    assert.match(await page.locator("[data-filter=pc]").innerText(), /Pas dans la liseuse \(400\)/);
    await page.fill("#pc-search", "introuvable");
    assert.equal(await page.locator("#pc-none").isVisible(), true);
  });
});

test("'Envoyer à un ami' prepares the email and explains the last step", async () => {
  await withApp([everyday, (f) => f.addPcBook("Candide - Voltaire", "epub", 300_000, { ready: true, converting: false })], async (page) => {
    await page.click("li.book");
    await page.click("#d-actions >> text=Envoyer à un ami");
    await page.waitForSelector("#bigmsg:not([hidden])");
    assert.match(await page.locator("#bm-text").innerText(), /faites-le glisser dans le message/);
    assert.equal(await page.evaluate(() => window.__fake.shared), "Candide - Voltaire");
  });
});

test("the screen fits a small laptop (1024×600) without hiding the main buttons", async () => {
  const { page, context, errors } = await openApp(browser, url, [everyday, (f) => { f.plug(); for (let i = 0; i < 40; i++) f.addPcBook(`Livre ${i} - A`, "mobi", 400_000); }], { viewport: { width: 1024, height: 600 } });
  try {
    await page.waitForSelector("li.book");
    for (const sel of ["#btn-add", "#btn-help", "#btn-eject", "#pc-search", "#gauge"]) {
      const box = await page.locator(sel).boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= 600 && box.x + box.width <= 1024, `${sel} visible: ${JSON.stringify(box)}`);
    }
    const doc = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
    assert.ok(doc.w <= 1024 && doc.h <= 600, `no page scrollbars: ${JSON.stringify(doc)}`);
    assert.deepEqual(errors.map(String), []);
  } finally {
    await context.close();
  }
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

test("pictures are shrunk for the Kindle 4 screen (600×800, greys, ≤ 60 KB)", async () => {
  await withApp([everyday], async (page) => {
    const r = await page.evaluate(async () => {
      const { kindle4Image, kindleImage } = await import("./converter/images.js");
      const c = Object.assign(document.createElement("canvas"), { width: 2000, height: 1500 });
      const g = c.getContext("2d");
      for (let i = 0; i < 4000; i++) {
        g.fillStyle = `hsl(${i % 360} 80% 50%)`;
        g.fillRect((i * 37) % 2000, (i * 91) % 1500, 60, 40);
      }
      const png = new Uint8Array(await (await new Promise((res) => c.toBlob(res, "image/png"))).arrayBuffer());
      const k4 = await kindle4Image(png, "image/png");
      const gen = await kindleImage(png, "image/png");
      const img = await createImageBitmap(new Blob([k4.bytes], { type: "image/jpeg" }));
      return { k4: k4.bytes.length, gen: gen.bytes.length, w: img.width, h: img.height };
    });
    assert.ok(r.k4 <= 60 * 1024, `kindle4 image is ${r.k4} bytes`);
    assert.ok(r.w <= 600 && r.h <= 800, `${r.w}×${r.h}`);
    assert.ok(r.k4 < r.gen, "smaller than the generic profile");
  });
});

test("a book bought on Amazon is labelled and can't be sent to a friend", async () => {
  const advice = "Acheté sur Amazon : ce livre se lit seulement sur votre liseuse.";
  await withApp([everyday, new Function("f", `f.addPcBook("L'Étranger - Albert Camus", "azw", 600000, { protected: true, advice: ${JSON.stringify(advice)} });`)], async (page) => {
    assert.match(await page.locator("li.book").innerText(), /Acheté sur Amazon/);
    await page.click("li.book");
    assert.match(await page.locator("#d-light").innerText(), /seulement sur votre liseuse/);
    assert.equal(await page.locator("#d-actions >> text=Envoyer à un ami").count(), 0);
  });
});
