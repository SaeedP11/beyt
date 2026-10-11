// Typed wrappers around the Rust commands and events.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Folder, Media, Playback, Recent, SeriesSettings, Track, TrackUpdate } from "./types";

export const api = {
  initialFile: () => invoke<string | null>("initial_file"),
  openMedia: (path: string) => invoke<Media>("open_media", { path }),
  addSubtitle: (path: string) => invoke<Track>("add_subtitle", { path }),
  stop: () => invoke<void>("stop"),

  listFolder: (path: string) => invoke<Folder>("list_folder", { path }),
  recentFiles: () => invoke<Recent[]>("recent_files"),
  nextVideo: (path: string) => invoke<string | null>("next_video", { path }),
  saveSeriesSettings: (folder: string, settings: SeriesSettings) =>
    invoke<void>("save_series_settings", { folder, settings }),
  appSettings: () => invoke<Record<string, unknown>>("app_settings"),
  setAppSetting: (key: string, value: unknown) => invoke<void>("set_app_setting", { key, value }),

  togglePause: () => invoke<void>("toggle_pause"),
  seekAbsolute: (time: number) => invoke<void>("seek_absolute", { time }),
  setMpvSubtitle: (sid: number | null) => invoke<void>("set_mpv_subtitle", { sid }),
  toggleFullscreen: () => invoke<void>("toggle_fullscreen"),
  quit: () => invoke<void>("quit"),
};

export const events = {
  playback: (cb: (p: Playback) => void): Promise<UnlistenFn> =>
    listen<Playback>("playback", (e) => cb(e.payload)),
  trackUpdated: (cb: (u: TrackUpdate) => void): Promise<UnlistenFn> =>
    listen<TrackUpdate>("track-updated", (e) => cb(e.payload)),
};
