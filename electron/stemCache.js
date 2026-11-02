"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// The app's private store of separated songs, so opening one twice only costs
// one separation. An entry is keyed by the audio's bytes plus the model, so a
// renamed file still matches and Fast and Best stay separate. The oldest entries
// are deleted past maxBytes; keeping stems for good is what Export is for.
//
//   <dir>/<id>/meta.json    { title, model, lastUsed }
//   <dir>/<id>/stems/*.wav
//
// A run writes into a temp folder and is renamed into place once it has
// finished, so an interrupted separation can never look like a complete entry.

const STEM_FILES = ["vocals", "drums", "bass", "instrumental"];
const ID_PATTERN = /^[0-9a-f]{32}-[a-z_]+$/;
const TEMP_PREFIX = ".tmp-";

function createStemCache(dir, maxBytes) {
  const entryPath = (id) => path.join(dir, id);
  const metaPath = (id) => path.join(entryPath(id), "meta.json");
  const tempPath = (id) => path.join(dir, `${TEMP_PREFIX}${id}`);

  function read(id) {
    if (!ID_PATTERN.test(id)) return null;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath(id), "utf8"));
    } catch {
      return null;
    }
    const stems = {};
    for (const name of STEM_FILES) {
      const file = path.join(entryPath(id), "stems", `${name}.wav`);
      if (!fs.existsSync(file)) return null;
      stems[name] = file;
    }
    return { id, ...meta, stems };
  }

  /** Every complete entry, most recently used first. */
  function list() {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .map(read)
      .filter(Boolean)
      .sort((a, b) => b.lastUsed - a.lastUsed);
  }

  function sizeOf(entry) {
    return Object.values(entry.stems).reduce((sum, file) => sum + fs.statSync(file).size, 0);
  }

  return {
    idFor(inputPath, model) {
      return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        fs.createReadStream(inputPath)
          .on("data", (chunk) => hash.update(chunk))
          .on("error", reject)
          .on("end", () => resolve(`${hash.digest("hex").slice(0, 32)}-${model}`));
      });
    },

    list,

    /** The entry with its last-used time refreshed, or null. */
    touch(id) {
      const entry = read(id);
      if (!entry) return null;
      entry.lastUsed = Date.now();
      const { title, model, lastUsed } = entry;
      fs.writeFileSync(metaPath(id), JSON.stringify({ title, model, lastUsed }));
      return entry;
    },

    /** A clean temp folder for a run's stems. */
    begin(id) {
      const stemsDir = path.join(tempPath(id), "stems");
      fs.rmSync(tempPath(id), { recursive: true, force: true });
      fs.mkdirSync(stemsDir, { recursive: true });
      return stemsDir;
    },

    commit(id, title, model) {
      const lastUsed = Date.now();
      fs.writeFileSync(
        path.join(tempPath(id), "meta.json"),
        JSON.stringify({ title, model, lastUsed })
      );
      fs.rmSync(entryPath(id), { recursive: true, force: true });
      fs.renameSync(tempPath(id), entryPath(id));
      return read(id);
    },

    abandon(id) {
      fs.rmSync(tempPath(id), { recursive: true, force: true });
    },

    /** Delete the oldest entries past the size limit, never `keepId`. */
    prune(keepId) {
      const entries = list();
      let total = entries.reduce((sum, entry) => sum + sizeOf(entry), 0);
      for (const entry of entries.reverse()) {
        if (total <= maxBytes) return;
        if (entry.id === keepId) continue;
        total -= sizeOf(entry);
        fs.rmSync(entryPath(entry.id), { recursive: true, force: true });
      }
    },

    /** Remove whatever an interrupted run left behind. */
    clearTemp() {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (name.startsWith(TEMP_PREFIX)) {
          fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        }
      }
    },
  };
}

module.exports = { createStemCache };
