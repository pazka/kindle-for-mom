import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("../../scripts/updater-manifest.mjs", import.meta.url).pathname;

test("latest.json points at the signed installer of the release", () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-"));
  writeFileSync(join(dir, "Ma liseuse_0.2.0_x64-setup.exe"), "exe");
  writeFileSync(join(dir, "Ma liseuse_0.2.0_x64-setup.exe.sig"), "SIGNATURE\n");
  execFileSync("node", [script, dir, "v0.2.0", "pazka/kindle-for-mom"]);
  const m = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  assert.equal(m.version, "0.2.0");
  assert.deepEqual(m.platforms["windows-x86_64"], {
    signature: "SIGNATURE",
    url: "https://github.com/pazka/kindle-for-mom/releases/download/v0.2.0/Ma-liseuse_0.2.0_x64-setup.exe",
  });
  assert.deepEqual(readdirSync(dir).sort(), ["Ma-liseuse_0.2.0_x64-setup.exe", "Ma-liseuse_0.2.0_x64-setup.exe.sig", "latest.json"]);
});

test("refuses a missing signature or a bad tag", () => {
  const dir = mkdtempSync(join(tmpdir(), "manifest-"));
  writeFileSync(join(dir, "x-setup.exe"), "exe");
  assert.throws(() => execFileSync("node", [script, dir, "v0.2.0", "a/b"], { stdio: "pipe" }));
  assert.throws(() => execFileSync("node", [script, dir, "latest", "a/b"], { stdio: "pipe" }));
});
