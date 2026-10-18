// Typed wrappers around the Rust commands and events.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AnkiResult,
  Aspect,
  AudioTrack,
  AudioUpdate,
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

/** Android's file pickers return content:// links, not paths, so there the
 *  library browses the phone's storage itself. */
export const isAndroid = navigator.userAgent.includes("Android");

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
  /** Fails with "dictionary-missing" until the dictionary is installed. */
  lookupWord: (word: string, lang: string) => invoke<Lookup>("lookup_word", { word, lang }),
  /** Downloads and builds the dictionary; returns its entry count. Sends `dictionaryProgress`. */
  installDictionary: () => invoke<number>("install_dictionary"),

  saveVocab: (item: NewVocab, capture: { padding: number; screenshot: boolean }) =>
    invoke<VocabItem>("save_vocab", { item, capture }),
  listVocab: () => invoke<VocabItem[]>("list_vocab"),
  deleteVocab: (id: number) => invoke<void>("delete_vocab", { id }),
  exportAnki: (anki: AnkiConfig) => invoke<AnkiResult>("export_anki", { anki }),
  testAnki: (anki: AnkiConfig) => invoke<number>("test_anki", { anki }),
  exportCsv: (path: string) => invoke<string>("export_csv", { path }),
  vocabMediaDir: () => invoke<string>("vocab_media_dir"),

  listFolder: (path: string) => invoke<Folder>("list_folder", { path }),
  /** Subfolders and .srt/.vtt files, for picking subtitles on Android. */
  listSubtitleFolder: (path: string) => invoke<Folder>("list_subtitle_folder", { path }),
  /** Android: whether videos can be read by path, and where shared storage starts. */
  storageAccess: () => invoke<{ granted: boolean; root: string | null }>("storage_access"),
  requestStorageAccess: () => invoke<void>("request_storage_access"),
  /** Android: sends Beyt to the background, as Back does in other apps. */
  moveToBackground: () => invoke<void>("move_to_background"),
  /** Android: shows `text` in the Google Translate app's popup (or on its website), translated into `to`. */
  translateExternally: (text: string, to: string) => invoke<void>("translate_externally", { text, to }),
  /** A physical keyboard is attached (always true on the desktop). */
  hardKeyboard: () => invoke<boolean>("hard_keyboard"),
  recentFiles: () => invoke<Recent[]>("recent_files"),
  /** Path of a cached JPEG of the frame at `at` seconds (null: 15% in). */
  thumbnail: (path: string, at: number | null) => invoke<string>("thumbnail", { path, at }),
  /** Subtitle files that are renamed and trashed along with the video. */
  videoSidecars: (path: string) => invoke<string[]>("video_sidecars", { path }),
  /** Returns the new path. Fails with "name-taken" if the name is in use. */
  renameVideo: (path: string, name: string) => invoke<string>("rename_video", { path, name }),
  trashVideo: (path: string, subtitles: boolean) => invoke<void>("trash_video", { path, subtitles }),
  forgetRecent: (path: string) => invoke<void>("forget_recent", { path }),
  showInFolder: (path: string) => invoke<void>("show_in_folder", { path }),
  nextVideo: (path: string) => invoke<string | null>("next_video", { path }),
  saveSeriesSettings: (folder: string, settings: SeriesSettings) =>
    invoke<void>("save_series_settings", { folder, settings }),
  appSettings: () => invoke<Record<string, unknown>>("app_settings"),
  setAppSetting: (key: string, value: unknown) => invoke<void>("set_app_setting", { key, value }),

  togglePause: () => invoke<void>("toggle_pause"),
  setPause: (paused: boolean) => invoke<void>("set_pause", { paused }),
  seekAbsolute: (time: number) => invoke<void>("seek_absolute", { time }),
  setMpvSubtitle: (sid: number | null) => invoke<void>("set_mpv_subtitle", { sid }),
  audioTracks: () => invoke<AudioTrack[]>("audio_tracks"),
  selectAudio: (id: number) => invoke<void>("select_audio", { id }),
  /** Adds an audio file to the open video and switches to it; remembered for the video. */
  addAudio: (path: string) => invoke<void>("add_audio", { path }),
  removeAudio: (id: number) => invoke<void>("remove_audio", { id }),
  setAspect: (aspect: Aspect) => invoke<void>("set_aspect", { aspect }),
  toggleFullscreen: () => invoke<void>("toggle_fullscreen"),
  quit: () => invoke<void>("quit"),

  setMpvOption: (name: "hwdec" | "speed" | "volume", value: string) =>
    invoke<void>("set_mpv_option", { name, value }),
  adjustProperty: (name: "volume" | "speed", delta: number) => invoke<number>("adjust_property", { name, delta }),
  toggleMute: () => invoke<boolean>("toggle_mute"),
  /** The backlight, or mpv's picture brightness on screens without one. */
  getBrightness: () => invoke<Brightness>("get_brightness"),
  /** Clamped to what the source allows; returns the level actually set. */
  setBrightness: (level: number) => invoke<Brightness>("set_brightness", { level }),
  clearWatchHistory: () => invoke<void>("clear_watch_history"),
  clearSubtitleCache: () => invoke<void>("clear_subtitle_cache"),
  dataInfo: () => invoke<{ dataDir: string; dictionaryEntries: number | null }>("data_info"),
  logError: (message: string) => invoke<void>("log_error", { message }),
};

export interface Brightness {
  level: number;
  source: "backlight" | "video";
}

export interface AnkiConfig {
  url: string;
  deck: string;
}

export const events = {
  playback: (cb: (p: Playback) => void): Promise<UnlistenFn> =>
    listen<Playback>("playback", (e) => cb(e.payload)),
  trackUpdated: (cb: (u: TrackUpdate) => void): Promise<UnlistenFn> =>
    listen<TrackUpdate>("track-updated", (e) => cb(e.payload)),
  /** The open video's audio tracks, whenever they change. */
  audioTracks: (cb: (u: AudioUpdate) => void): Promise<UnlistenFn> =>
    listen<AudioUpdate>("audio-tracks", (e) => cb(e.payload)),
  matchProgress: (cb: (fraction: number) => void): Promise<UnlistenFn> =>
    listen<number>("match-progress", (e) => cb(e.payload)),
  /** Fraction downloaded, or null when the size isn't known. */
  dictionaryProgress: (cb: (fraction: number | null) => void): Promise<UnlistenFn> =>
    listen<number | null>("dictionary-progress", (e) => cb(e.payload)),
  /** Android: a physical keyboard was plugged in (true) or removed (false). */
  hardKeyboard: (cb: (attached: boolean) => void): Promise<UnlistenFn> =>
    listen<boolean>("hard-keyboard", (e) => cb(e.payload)),
};
