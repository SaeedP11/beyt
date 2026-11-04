// Beyt's data (watch history, settings, saved words) in one JSON file.
// Same shape as the browser's own copy, so GET /state is the file itself.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const empty = () => ({ watch: {}, addedSubtitles: {}, series: {}, settings: {}, vocab: [], nextVocabId: 1 });

export async function openState(dir) {
  await mkdir(dir, { recursive: true });
  const file = join(dir, "state.json");
  let data;
  try {
    data = { ...empty(), ...JSON.parse(await readFile(file, "utf8")) };
  } catch (e) {
    if (e.code !== "ENOENT") throw e; // A corrupt file must not be silently replaced.
    data = empty();
  }
  let queue = Promise.resolve();
  const save = () => {
    queue = queue.then(async () => {
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(data));
      await rename(tmp, file);
    });
    return queue;
  };
  return { data, save, flush: () => queue };
}
