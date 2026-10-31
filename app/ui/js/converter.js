/**
 * Background EPUB → MOBI conversion, one book at a time, so Mom never
 * waits on it: books show "Préparation…" until their Kindle copy exists.
 * Dependencies are injected (unit-tested in ui/test/converter.test.js).
 */

import { bookName, shouldRename } from "./text.js";

const KNOWN_ERRORS = new Set(["drm", "not_epub", "empty"]);

export class Converter {
  /**
   * @param {{ api: object, convert: Function, processImage?: Function, onDone?: Function }} deps
   */
  constructor({ api, convert, processImage, onDone }) {
    this.api = api;
    this.convert = convert;
    this.processImage = processImage;
    this.onDone = onDone || (() => {});
    this.queue = [];
    this.running = null;
    this.failed = new Set();
  }

  /** Queue ids not already queued or running. */
  enqueue(ids) {
    for (const id of ids) {
      if (id !== this.current && !this.queue.includes(id) && !this.failed.has(id)) this.queue.push(id);
    }
    if (!this.running) this.running = this.#loop().finally(() => { this.running = null; });
    return this.running;
  }

  async #loop() {
    while (this.queue.length) {
      const id = (this.current = this.queue.shift());
      let result;
      try {
        result = await this.#convertOne(id);
      } catch {
        // the backend itself failed (file vanished…): don't retry in a loop
        this.failed.add(id);
        result = { id, ok: false, code: "io" };
      }
      this.current = null;
      await this.onDone(result);
    }
  }

  async #convertOne(id) {
    const bytes = await this.api.readBook(id);
    let out;
    try {
      out = await this.convert(bytes, { processImage: this.processImage });
    } catch (e) {
      const code = KNOWN_ERRORS.has(e?.code) ? e.code : "convert";
      await this.api.saveConversionError(id, code);
      return { id, ok: false, code };
    }
    await this.api.saveKindleCopy(id, out.mobi);
    const wanted = bookName(out.meta);
    const finalId = shouldRename(id, wanted) ? await this.api.renameBook(id, wanted) : id;
    return { id: finalId, ok: true, warnings: out.warnings || [] };
  }
}
