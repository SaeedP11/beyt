// What the desktop keeps in SQLite (watch history, series settings, app
// settings, saved words), kept in localStorage in the browser.

import type { NewVocab, Recent, VocabItem } from "../types";

interface Watch {
  position: number;
  duration: number;
  updatedAt: number;
}

interface Data {
  watch: Record<string, Watch>;
  addedSubtitles: Record<string, string[]>;
  series: Record<string, unknown>;
  settings: Record<string, unknown>;
  vocab: VocabItem[];
  nextVocabId: number;
}

const KEY = "beyt:data";
const empty = (): Data => ({ watch: {}, addedSubtitles: {}, series: {}, settings: {}, vocab: [], nextVocabId: 1 });

let cache: Data | null = null;

function data(): Data {
  if (cache) return cache;
  try {
    cache = { ...empty(), ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Data>) };
  } catch {
    cache = empty();
  }
  return cache;
}

function commit(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data()));
  } catch {
    // Storage full or blocked: this session keeps working from memory.
  }
}

export const store = {
  watchState: (path: string): Watch | null => data().watch[path] ?? null,
  saveWatch(path: string, position: number, duration: number): void {
    data().watch[path] = { position, duration, updatedAt: Math.floor(Date.now() / 1000) };
    commit();
  },
  forgetWatch(path: string): void {
    delete data().watch[path];
    commit();
  },
  clearWatchHistory(): void {
    data().watch = {};
    commit();
  },
  recent(limit: number): Recent[] {
    return Object.entries(data().watch)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map(([path, w]) => ({
        path,
        title: (path.split("/").pop() ?? path).replace(/\.[^.]+$/, ""),
        position: w.position,
        duration: w.duration,
        updatedAt: w.updatedAt,
      }));
  },

  addedSubtitles: (video: string): string[] => data().addedSubtitles[video] ?? [],
  addSubtitle(video: string, path: string): void {
    const list = data().addedSubtitles[video] ?? [];
    if (!list.includes(path)) data().addedSubtitles[video] = [...list, path];
    commit();
  },
  removeSubtitle(video: string, path: string): void {
    data().addedSubtitles[video] = (data().addedSubtitles[video] ?? []).filter((p) => p !== path);
    commit();
  },

  seriesSettings: (folder: string): unknown => data().series[folder] ?? null,
  saveSeriesSettings(folder: string, settings: unknown): void {
    data().series[folder] = settings;
    commit();
  },

  appSettings: (): Record<string, unknown> => ({ ...data().settings }),
  setAppSetting(key: string, value: unknown): void {
    data().settings[key] = value;
    commit();
  },

  addVocab(item: NewVocab): VocabItem {
    const saved: VocabItem = {
      ...item,
      id: data().nextVocabId++,
      screenshot: null,
      audio: null,
      createdAt: Math.floor(Date.now() / 1000),
      exported: false,
    };
    data().vocab.unshift(saved);
    commit();
    return saved;
  },
  vocab: (): VocabItem[] => [...data().vocab],
  deleteVocab(id: number): void {
    data().vocab = data().vocab.filter((v) => v.id !== id);
    commit();
  },
  markExported(ids: number[]): void {
    for (const v of data().vocab) if (ids.includes(v.id)) v.exported = true;
    commit();
  },
};
