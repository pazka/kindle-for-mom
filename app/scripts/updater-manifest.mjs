// Writes latest.json, the file the app's updater reads (ADR-0007), next to
// the signed installer of a release:
//   node scripts/updater-manifest.mjs <dir> <tag> <owner/repo>
// <dir> holds exactly one *-setup.exe and its .sig (made by `tauri build`
// with TAURI_SIGNING_PRIVATE_KEY). The installer is renamed without spaces
// so its download URL is predictable.
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function manifest({ version, notes, date, signature, url }) {
  return {
    version,
    notes,
    pub_date: date,
    platforms: { "windows-x86_64": { signature: signature.trim(), url } },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, tag, repo] = process.argv.slice(2);
  const exes = readdirSync(dir).filter((f) => f.endsWith("-setup.exe"));
  if (exes.length !== 1 || !/^v\d+\.\d+\.\d+$/.test(tag || "") || !repo) {
    console.error("usage: updater-manifest.mjs <dir> <vX.Y.Z> <owner/repo>, with one *-setup.exe + .sig in <dir>");
    process.exit(1);
  }
  const version = tag.slice(1);
  const name = `Ma-liseuse_${version}_x64-setup.exe`;
  const signature = readFileSync(join(dir, `${exes[0]}.sig`), "utf8");
  renameSync(join(dir, exes[0]), join(dir, name));
  renameSync(join(dir, `${exes[0]}.sig`), join(dir, `${name}.sig`));
  const m = manifest({
    version,
    notes: `Ma liseuse ${version}`,
    date: new Date().toISOString(),
    signature,
    url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
  });
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(m, null, 2)}\n`);
  console.log("latest.json for", version);
}
