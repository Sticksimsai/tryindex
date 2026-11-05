"use strict";
/* Tiny JSON-file store for launches. Good enough for v1; swap for Postgres when
   the feed needs real volume. */
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DATA_DIR, "launches.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}
function save(all) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, FILE);
}

module.exports = {
  list() {
    return load();
  },
  get(mint) {
    return load().find((l) => l.mint === mint) || null;
  },
  upsert(entry) {
    const all = load();
    const i = all.findIndex((l) => l.mint === entry.mint);
    if (i >= 0) all[i] = { ...all[i], ...entry };
    else all.unshift(entry);
    save(all);
    return entry;
  },
};
