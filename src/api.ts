// Typed wrappers around the Rust commands and events.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AnkiResult,
  Candidate,
  FileInfo,
  Folder,
  Lookup,
  Media,
  NewVocab,
  Playback,
  Recent,
  SeriesSettings,
  Track,
  TrackUpdate,
  VocabItem,
} from "./types";

export const api = {
  initialFile: () => invoke<string | null>("initial_file"),
  openMedia: (path: string, options: { preferredLanguages: string[]; resume: boolean }) =>
    invoke<Media>("open_media", { path, options }),
  addSubtitle: (path: string) => invoke<Track>("add_subtitle", { path }),
  /** Returns every remaining track's key, as removing one can renumber others. */
  removeSubtitle: (id: number) => invoke<{ id: number; key: string }[]>("remove_subtitle", { id }),
  fileInfo: (path: string) => invoke<FileInfo>("file_info", { path }),
  /** Best fit first. Sends `matchProgress` while the audio is sampled. */
  matchSubtitles: (path: string, files: string[]) => invoke<Candidate[]>("match_subtitles", { path, files }),
  stop: () => invoke<void>("stop"),
  lookupWord: (word: string, lang: string) => invoke<Lookup>("lookup_word", { word, lang }),

  saveVocab: (item: NewVocab, capture: { padding: number; screenshot: boolean }) =>
    invoke<VocabItem>("save_vocab", { item, capture }),
  listVocab: () => invoke<VocabItem[]>("list_vocab"),
  deleteVocab: (id: number) => invoke<void>("delete_vocab", { id }),
  exportAnki: (anki: AnkiConfig) => invoke<AnkiResult>("export_anki", { anki }),
  testAnki: (anki: AnkiConfig) => invoke<number>("test_anki", { anki }),
  exportCsv: (path: string) => invoke<string>("export_csv", { path }),
  vocabMediaDir: () => invoke<string>("vocab_media_dir"),

  listFolder: (path: string) => invoke<Folder>("list_folder", { path }),
  recentFiles: () => invoke<Recent[]>("recent_files"),
  nextVideo: (path: string) => invoke<string | null>("next_video", { path }),
  saveSeriesSettings: (folder: string, settings: SeriesSettings) =>
    invoke<void>("save_series_settings", { folder, settings }),
  appSettings: () => invoke<Record<string, unknown>>("app_settings"),
  setAppSetting: (key: string, value: unknown) => invoke<void>("set_app_setting", { key, value }),

  togglePause: () => invoke<void>("toggle_pause"),
  setPause: (paused: boolean) => invoke<void>("set_pause", { paused }),
  seekAbsolute: (time: number) => invoke<void>("seek_absolute", { time }),
  setMpvSubtitle: (sid: number | null) => invoke<void>("set_mpv_subtitle", { sid }),
  toggleFullscreen: () => invoke<void>("toggle_fullscreen"),
  quit: () => invoke<void>("quit"),

  setMpvOption: (name: "hwdec" | "speed" | "volume", value: string) =>
    invoke<void>("set_mpv_option", { name, value }),
  adjustProperty: (name: "volume" | "speed", delta: number) => invoke<number>("adjust_property", { name, delta }),
  toggleMute: () => invoke<boolean>("toggle_mute"),
  clearWatchHistory: () => invoke<void>("clear_watch_history"),
  clearSubtitleCache: () => invoke<void>("clear_subtitle_cache"),
  dataInfo: () => invoke<{ dataDir: string; dictionaryEntries: number | null }>("data_info"),
  logError: (message: string) => invoke<void>("log_error", { message }),
};

export interface AnkiConfig {
  url: string;
  deck: string;
}

export const events = {
  playback: (cb: (p: Playback) => void): Promise<UnlistenFn> =>
    listen<Playback>("playback", (e) => cb(e.payload)),
  trackUpdated: (cb: (u: TrackUpdate) => void): Promise<UnlistenFn> =>
    listen<TrackUpdate>("track-updated", (e) => cb(e.payload)),
  matchProgress: (cb: (fraction: number) => void): Promise<UnlistenFn> =>
    listen<number>("match-progress", (e) => cb(e.payload)),
};
