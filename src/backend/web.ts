// The browser backend: the same surface as the Rust commands (see tauri.ts),
// built on an HTML5 <video>, the File APIs and localStorage. It runs Beyt in a
// plain web page, and is what other apps get when they embed Beyt as a package.
//
// Not available in a browser: embedded subtitle tracks and extra audio tracks
// (they need ffmpeg), subtitle matching against the soundtrack, the offline
// dictionary, renaming and trashing files, and clips on vocabulary cards.

import type {
  AnkiResult,
  Candidate,
  FileInfo,
  Folder,
  Media,
  Playback,
  SeriesSettings,
  Track,
  VocabItem,
} from "../types";
import { bus, engine, VIDEO_BRIGHTNESS } from "./engine";
import type { AnkiConfig, Brightness } from "./shared";
import { store } from "./store";
import {
  baseName,
  folderTitle,
  getFile,
  getPlayable,
  isKnownRoot,
  restored,
  listDir,
  parentOf,
} from "./vfs";
import {
  isRtlLang,
  isSubtitleName,
  isVideoName,
  langFromFileName,
  loadSubtitles,
  naturalCompare,
} from "./subtitles";

let wakeLockSentinel: WakeLockSentinel | null = null;

const RESUME_MARGIN_START = 30;
const RESUME_MARGIN_END = 60;

const unsupported = (what: string) => Promise.reject(new Error(`${what} isn't available in the browser version of Beyt.`));

const stemOf = (name: string) => name.replace(/\.[^.]+$/, "");

// ---------- tracks ----------

async function fileTrack(path: string, videoStem: string | undefined): Promise<Track> {
  const name = baseName(path);
  const tagged = langFromFileName(name, videoStem);
  const track: Track = {
    id: 0,
    key: "",
    lang: tagged ?? "und",
    detail: name,
    rtl: tagged ? isRtlLang(tagged) : false,
    source: { kind: "file", path },
    status: "ready",
    error: null,
    defaultEnabled: false,
    added: false,
    cues: [],
  };
  try {
    const loaded = loadSubtitles(new Uint8Array(await (await getFile(path)).arrayBuffer()));
    track.cues = loaded.cues;
    track.rtl = loaded.rtl;
    // An untagged file: guess from the script.
    if (!tagged) track.lang = loaded.rtl ? "fa" : "en";
  } catch (e) {
    track.status = "failed";
    track.error = e instanceof Error ? e.message : String(e);
  }
  return track;
}

function assignKeys(tracks: Track[]): void {
  const seen = new Map<string, number>();
  for (const track of tracks) {
    const base = `${track.lang}:${track.source.kind}`;
    const n = seen.get(base) ?? 0;
    track.key = `${base}:${n}`;
    seen.set(base, n + 1);
  }
}

/** One text track per preferred language, else the first usable one. */
function pickDefaults(tracks: Track[], preferred: string[]): void {
  const usable = (t: Track) => t.status === "ready";
  let picked = false;
  for (const lang of preferred) {
    const best = tracks.find((t) => t.lang === lang && usable(t));
    if (best) {
      best.defaultEnabled = true;
      picked = true;
    }
  }
  if (!picked) {
    const first = tracks.find(usable);
    if (first) first.defaultEnabled = true;
  }
}

// ---------- current video ----------

interface Current {
  path: string;
  tracks: Track[];
}
let current: Current | null = null;
let saveTimer: number | undefined;

function savePosition(): void {
  if (!current || !engine.loaded) return;
  const { time } = engine.snapshot();
  if (time > 1 && engine.duration > 0) store.saveWatch(current.path, time, engine.duration);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", savePosition);
  saveTimer = window.setInterval(savePosition, 5000);
  void saveTimer;
}

// ---------- folders ----------

async function folderOf(path: string, wanted: (name: string) => boolean, withProgress: boolean): Promise<Folder> {
  const entries = await listDir(path, wanted);
  return {
    path,
    parent: parentOf(path),
    entries: entries.map((e) => {
      const w = withProgress && !e.isDir ? store.watchState(e.path) : null;
      return { path: e.path, name: e.name, isDir: e.isDir, ...(w ? { position: w.position, duration: w.duration } : {}) };
    }),
  };
}

// ---------- thumbnails ----------

async function thumbnail(path: string, at: number | null): Promise<string> {
  const media = await getPlayable(path);
  const url = media.url;
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "metadata";
  v.src = url;
  try {
    await new Promise<void>((res, rej) => {
      v.onloadedmetadata = () => res();
      v.onerror = () => rej(new Error("no frame"));
    });
    v.currentTime = at ?? (Number.isFinite(v.duration) ? v.duration * 0.15 : 0);
    await new Promise<void>((res, rej) => {
      v.onseeked = () => res();
      v.onerror = () => rej(new Error("no frame"));
    });
    return engine.frame(v, 480);
  } finally {
    media.release();
    v.removeAttribute("src");
    v.load();
  }
}

// ---------- vocabulary ----------

function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Downloads `text` as a file, since a page can't write to a path. */
export function download(name: string, text: string, type = "text/csv"): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function anki(cfg: AnkiConfig, action: string, params: unknown = {}): Promise<unknown> {
  let reply: { result: unknown; error: string | null };
  try {
    const res = await fetch(cfg.url, { method: "POST", body: JSON.stringify({ action, version: 6, params }) });
    reply = await res.json();
  } catch {
    throw new Error(
      "Anki is not reachable. Open Anki with the AnkiConnect add-on, and add this page's address to its webCorsOriginList.",
    );
  }
  if (reply.error) throw new Error(reply.error);
  return reply.result;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

// ---------- the API ----------

export const webApi = {
  initialFile: async (): Promise<string | null> => null,

  async openMedia(path: string, options: { preferredLanguages: string[]; resume: boolean }): Promise<Media> {
    const media = await getPlayable(path);
    if (!isVideoName(media.name)) {
      media.release();
      throw new Error(`not a video: ${media.name}`);
    }
    savePosition();

    const w = store.watchState(path);
    const resumedAt =
      options.resume &&
      w &&
      w.position > RESUME_MARGIN_START &&
      (w.duration <= 0 || w.position < w.duration - RESUME_MARGIN_END)
        ? w.position
        : null;

    const folder = parentOf(path) ?? path;
    const stem = stemOf(media.name);
    const sidecars = (await listDir(folder, isSubtitleName).catch(() => []))
      .filter((e) => !e.isDir && e.name.startsWith(stem))
      .map((e) => e.path);
    const added = store.addedSubtitles(path).filter((p) => isKnownRoot(p) && !sidecars.includes(p));

    const tracks = await Promise.all([
      ...sidecars.map((p) => fileTrack(p, stem)),
      ...added.map(async (p) => ({ ...(await fileTrack(p, stem)), added: true })),
    ]);
    tracks.forEach((t, i) => (t.id = i));
    assignKeys(tracks);
    pickDefaults(tracks, options.preferredLanguages);

    try {
      await engine.load(media, resumedAt);
    } catch (e) {
      media.release();
      throw e;
    }
    current = { path, tracks };

    return {
      path,
      title: stem,
      folder,
      tracks,
      resumedAt,
      series: store.seriesSettings(folder) as SeriesSettings | null,
    };
  },

  async addSubtitle(path: string): Promise<Track> {
    if (!current) throw new Error("no video is open");
    if (current.tracks.some((t) => t.source.kind === "file" && t.source.path === path)) {
      throw new Error("This subtitle file is already loaded.");
    }
    const track = await fileTrack(path, stemOf(baseName(current.path)));
    if (track.status === "failed") throw new Error(track.error ?? "unreadable subtitle file");
    store.addSubtitle(current.path, path);
    // Ids are never reused, since removing a track leaves a gap.
    track.id = current.tracks.reduce((n, t) => Math.max(n, t.id + 1), 0);
    track.added = true;
    current.tracks.push(track);
    assignKeys(current.tracks);
    return track;
  },

  async removeSubtitle(id: number): Promise<{ id: number; key: string }[]> {
    if (!current) throw new Error("no video is open");
    const i = current.tracks.findIndex((t) => t.id === id && t.added);
    if (i < 0) throw new Error("not an added subtitle");
    const src = current.tracks[i]!.source;
    if (src.kind === "file") store.removeSubtitle(current.path, src.path);
    current.tracks.splice(i, 1);
    assignKeys(current.tracks);
    return current.tracks.map((t) => ({ id: t.id, key: t.key }));
  },

  async fileInfo(path: string): Promise<FileInfo> {
    const media = await getPlayable(path);
    media.release();
    const playing = current?.path === path;
    const v = engine.video;
    return {
      name: media.name,
      folder: parentOf(path) ?? "",
      size: media.size ?? 0,
      container: media.name.split(".").pop()?.toLowerCase() ?? null,
      duration: playing ? engine.duration : null,
      bitrate: playing && engine.duration && media.size ? Math.round((media.size * 8) / engine.duration) : null,
      titleTag: null,
      release: { title: null, year: null, season: null, episode: null, resolution: null, source: null, group: null },
      hash: null,
      video: playing && v.videoWidth
        ? [{ codec: "unknown", profile: null, width: v.videoWidth, height: v.videoHeight, fps: null, bitDepth: null, hdr: false }]
        : [],
      audio: [],
      subtitles: [],
    };
  },

  matchSubtitles: (_path: string, _files: string[]): Promise<Candidate[]> => unsupported("Matching subtitles to the soundtrack"),

  async stop(): Promise<void> {
    savePosition();
    current = null;
    engine.unload();
  },

  lookupWord: (_word: string, _lang: string) => Promise.reject(new Error("dictionary-missing")),
  installDictionary: (): Promise<number> => unsupported("The offline dictionary"),

  async saveVocab(item: Parameters<typeof store.addVocab>[0], capture: { padding: number; screenshot: boolean }): Promise<VocabItem> {
    const saved = store.addVocab(item);
    if (capture.screenshot && engine.loaded) {
      try {
        // Only the frame on screen can be captured; the audio clip needs ffmpeg.
        saved.screenshot = engine.frame(engine.video, 640);
      } catch {
        // A tainted or empty frame: the card is saved without a picture.
      }
    }
    return saved;
  },
  listVocab: async (): Promise<VocabItem[]> => store.vocab(),
  deleteVocab: async (id: number): Promise<void> => store.deleteVocab(id),

  async exportAnki(cfg: AnkiConfig): Promise<AnkiResult> {
    const pending = store.vocab().filter((v) => !v.exported);
    const notes = pending.map((v) => ({
      deckName: cfg.deck,
      modelName: "Basic",
      fields: {
        Front: v.word ? `<b>${escapeHtml(v.word)}</b><br>${escapeHtml(v.sentence)}` : escapeHtml(v.sentence),
        Back: [v.meaning, v.translation].filter(Boolean).map((s) => escapeHtml(s!)).join("<br>"),
      },
      options: { allowDuplicate: false },
      tags: ["beyt"],
    }));
    if (!notes.length) return { added: [], skipped: 0 };
    await anki(cfg, "createDeck", { deck: cfg.deck });
    const ids = (await anki(cfg, "addNotes", { notes })) as (number | null)[];
    store.markExported(pending.filter((_, i) => ids[i] != null).map((v) => v.id));
    return { added: ids.filter((n): n is number => n != null), skipped: ids.filter((n) => n == null).length };
  },
  async testAnki(cfg: AnkiConfig): Promise<number> {
    return (await anki(cfg, "version")) as number;
  },
  async exportCsv(name: string): Promise<string> {
    const rows = store.vocab().map((v) =>
      [v.word, v.meaning, v.sentence, v.translation, v.lang, baseName(v.video)].map(csvCell).join(","),
    );
    download(name, ["word,meaning,sentence,translation,language,video", ...rows].join("\n"));
    return name;
  },
  vocabMediaDir: async (): Promise<string> => "",

  listFolder: (path: string): Promise<Folder> => folderOf(path, isVideoName, true),
  listSubtitleFolder: (path: string): Promise<Folder> => folderOf(path, isSubtitleName, false),
  storageAccess: async () => ({ granted: true, root: null }),
  requestStorageAccess: async (): Promise<void> => {},
  moveToBackground: async (): Promise<void> => {},
  translateExternally: (_text: string, _to: string): Promise<void> => unsupported("Translation"),
  hardKeyboard: async (): Promise<boolean> => true,
  async recentFiles() {
    await restored;
    return store.recent(30).filter((r) => isKnownRoot(r.path)).slice(0, 12);
  },
  thumbnail,
  async videoSidecars(path: string): Promise<string[]> {
    const stem = stemOf(baseName(path));
    return (await listDir(parentOf(path) ?? path, isSubtitleName)).filter((e) => e.name.startsWith(stem)).map((e) => e.path);
  },
  renameVideo: (_path: string, _name: string): Promise<string> => unsupported("Renaming files"),
  trashVideo: (_path: string, _subtitles: boolean): Promise<void> => unsupported("Moving files to the trash"),
  async forgetRecent(path: string): Promise<void> {
    store.forgetWatch(path);
  },
  showInFolder: (_path: string): Promise<void> => unsupported("Showing a file in its folder"),
  async nextVideo(path: string): Promise<string | null> {
    const name = baseName(path);
    const siblings = await listDir(parentOf(path) ?? path, isVideoName);
    return siblings.find((e) => !e.isDir && naturalCompare(e.name, name) > 0)?.path ?? null;
  },
  async saveSeriesSettings(folder: string, settings: SeriesSettings): Promise<void> {
    store.saveSeriesSettings(folder, settings);
  },
  appSettings: async (): Promise<Record<string, unknown>> => store.appSettings(),
  async setAppSetting(key: string, value: unknown): Promise<void> {
    store.setAppSetting(key, value);
  },

  async togglePause(): Promise<void> {
    engine.setPause(!engine.video.paused);
  },
  async setPause(paused: boolean): Promise<void> {
    engine.setPause(paused);
  },
  async seekAbsolute(time: number): Promise<void> {
    engine.seek(time);
  },
  // Picture-based subtitles come only from video files, which a browser can't read.
  setMpvSubtitle: async (_sid: number | null): Promise<void> => {},
  audioTracks: async () => [],
  selectAudio: (_id: number): Promise<void> => unsupported("Choosing an audio track"),
  addAudio: (_path: string): Promise<void> => unsupported("Adding an audio file"),
  removeAudio: (_id: number): Promise<void> => unsupported("Removing an audio file"),
  async setAspect(aspect: Parameters<typeof engine.setAspect>[0]): Promise<void> {
    engine.setAspect(aspect);
  },
  async setLocked(locked: boolean): Promise<void> {
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    try {
      if (locked && !wakeLockSentinel) {
        wakeLockSentinel = await navigator.wakeLock.request("screen");
        wakeLockSentinel.addEventListener("release", () => {
          wakeLockSentinel = null;
        });
      } else if (!locked && wakeLockSentinel) {
        await wakeLockSentinel.release();
        wakeLockSentinel = null;
      }
    } catch {
      // Ignored if wake lock is unavailable or rejected
    }
  },
  async toggleFullscreen(): Promise<void> {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  },
  async quit(): Promise<void> {
    savePosition();
    window.close();
  },

  async setMpvOption(name: "hwdec" | "speed" | "volume", value: string): Promise<void> {
    if (name === "speed") engine.setSpeed(Number(value) || 1);
    if (name === "volume") engine.setVolume(Number(value));
  },
  async adjustProperty(name: "volume" | "speed", delta: number): Promise<number> {
    if (name === "volume") return engine.setVolume(engine.volume + delta);
    return engine.setSpeed(engine.video.playbackRate + delta);
  },
  async toggleMute(): Promise<boolean> {
    engine.video.muted = !engine.video.muted;
    return engine.video.muted;
  },
  async getBrightness(): Promise<Brightness> {
    return { level: engine.pictureBrightness, source: "video" };
  },
  async setBrightness(level: number): Promise<Brightness> {
    return { level: engine.setBrightness(level), source: "video" };
  },
  async clearWatchHistory(): Promise<void> {
    store.clearWatchHistory();
  },
  async clearSubtitleCache(): Promise<void> {},
  dataInfo: async () => ({ dataDir: "Browser storage", dictionaryEntries: null as number | null }),
  async logError(message: string): Promise<void> {
    console.error(`[beyt] ${message}`);
  },
  async isDefaultPlayer(): Promise<boolean> {
    return false;
  },
  async setDefaultPlayer(): Promise<void> {},
};

export const webEvents = {
  playback: async (cb: (p: Playback) => void) => bus.on("playback", cb),
  trackUpdated: async (_cb: (u: never) => void) => () => {},
  audioTracks: async (_cb: (u: never) => void) => () => {},
  matchProgress: async (_cb: (f: number) => void) => () => {},
  dictionaryProgress: async (_cb: (f: number | null) => void) => () => {},
  hardKeyboard: async (_cb: (attached: boolean) => void) => () => {},
  openUrl: async (_cb: (url: string) => void) => () => {},
  playbackError: async (_cb: (error: string) => void) => () => {},
};

void VIDEO_BRIGHTNESS;
void folderTitle;
