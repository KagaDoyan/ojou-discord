// jsonStore.js
// Small persistence factory shared by dnd.js and dndMechanics.js: each store keeps a
// plain object in memory and writes it through to a JSON file under data/. Writes are
// serialized through a promise chain (so concurrent channels saving around the same time
// can't interleave into a corrupted file) and land via temp-file + rename (atomic on the
// same filesystem, so a crash mid-write can't corrupt the file either — worst case is
// losing the very last unsaved change, never a garbled file).

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.join(import.meta.dir, "data");

export function createJsonStore(fileName) {
  const filePath = path.join(DATA_DIR, fileName);
  const data = new Map();
  let writeQueue = Promise.resolve();

  async function persistToDisk() {
    const tmpPath = `${filePath}.tmp`;
    const serialized = JSON.stringify(Object.fromEntries(data));
    await writeFile(tmpPath, serialized);
    await rename(tmpPath, filePath);
  }

  function scheduleSave() {
    writeQueue = writeQueue.then(persistToDisk).catch((err) => console.error(`Failed to save ${fileName}:`, err));
    return writeQueue;
  }

  async function load() {
    await mkdir(DATA_DIR, { recursive: true });
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return; // normal first run, nothing to load
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error(`${fileName} is corrupt, starting fresh:`, err.message || err);
      await rename(filePath, `${filePath}.bak-${Date.now()}`).catch(() => {});
      return;
    }

    for (const [key, value] of Object.entries(parsed)) {
      data.set(key, value);
    }
  }

  return { data, load, scheduleSave };
}
