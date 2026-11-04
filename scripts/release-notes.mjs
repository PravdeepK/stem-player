// Prints one version's section of CHANGELOG.md, which the release workflow
// publishes as that release's notes. Exits 1 when the version has no section,
// so a release can't go out without saying what's new.
//
//   node scripts/release-notes.mjs 0.1.1
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The body under "## <version>", trimmed, or null if it's missing or empty. */
export function notesFor(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return null;
  let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body || null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = String(process.argv[2] || "").replace(/^v/, "");
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const notes = version && notesFor(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), version);
  if (!notes) {
    console.error(`CHANGELOG.md has no notes for ${version || "(no version given)"}. Add a "## ${version || "x.y.z"}" section.`);
    process.exit(1);
  }
  console.log(notes);
}
