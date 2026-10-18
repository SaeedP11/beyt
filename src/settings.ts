// App settings: typed defaults, persistence, and the side effects that make
// each setting take hold right away (CSS variables, language, mpv options).

import { useSyncExternalStore } from "react";

import { api } from "./api";
import { type Lang, defaultLang, setLang } from "./i18n";
import type { Keymap } from "./keymap";
import { type Theme, setTheme } from "./theme";
import type { Position } from "./types";
import { debounce } from "./ui";

export interface SubtitleDefault {
  position: Position;
  size: number;
  color: string;
  boxed: boolean;
}

export interface Settings {
  // General
  /** null follows the system language. */
  uiLanguage: Lang | null;
  /** null follows the system theme. */
  theme: Theme | null;
  resumePlayback: boolean;
  autoplayNext: boolean;
  autoplayDelay: number;
  seekStep: number;
  controlsHideDelay: number;
  // Playback
  hwdec: "auto-safe" | "no";
  defaultSpeed: number;
  defaultVolume: number;
  // Subtitles
  preferredLanguages: string[];
  fontPersian: string;
  fontLatin: string;
  /** Outline thickness in px; 0 for none. */
  outline: number;
  /** Space between stacked tracks, in em. */
  trackGap: number;
  /** Distance of the bottom stack from the bottom edge, in % of height. */
  bottomMargin: number;
  subtitleDefaults: { fa: SubtitleDefault; en: SubtitleDefault; other: SubtitleDefault };
  // Learning
  autoPauseDefault: boolean;
  popupPauses: boolean;
  /** Milliseconds of audio kept around a saved line. */
  clipPadding: number;
  saveScreenshots: boolean;
  // Anki
  ankiUrl: string;
  ankiDeck: string;
  // Shortcuts
  keymap: Keymap;
}

export const DEFAULTS: Settings = {
  uiLanguage: null,
  theme: null,
  resumePlayback: true,
  autoplayNext: true,
  autoplayDelay: 5,
  seekStep: 5,
  controlsHideDelay: 2.5,
  hwdec: "auto-safe",
  defaultSpeed: 1,
  defaultVolume: 100,
  preferredLanguages: ["fa", "en"],
  fontPersian: "Vazirmatn",
  fontLatin: "Inter",
  outline: 2,
  trackGap: 0.35,
  bottomMargin: 6,
  subtitleDefaults: {
    fa: { position: "bottom", size: 34, color: "#ffffff", boxed: false },
    en: { position: "bottom", size: 30, color: "#ffe9a8", boxed: false },
    other: { position: "top", size: 28, color: "#d6f0ff", boxed: false },
  },
  autoPauseDefault: false,
  popupPauses: true,
  clipPadding: 250,
  saveScreenshots: true,
  ankiUrl: "http://127.0.0.1:8765",
  ankiDeck: "Beyt",
  keymap: {},
};

let current: Settings = DEFAULTS;
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return current;
}

export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, getSettings);
}

const persist = debounce((s: Settings) => void api.setAppSetting("settings", s), 300);

export function updateSettings(patch: Partial<Settings>): void {
  const prev = current;
  current = { ...current, ...patch };
  apply(current, prev);
  persist(current);
  for (const fn of listeners) fn();
}

export function resetSettings(): void {
  updateSettings(structuredClone(DEFAULTS));
}

/** Loads saved settings (merged over defaults, so new settings get their default). */
export function loadSettings(saved: Record<string, unknown>): Settings {
  const stored = (saved.settings ?? {}) as Partial<Settings>;
  // Settings from before this screen existed.
  if (saved.settings === undefined) {
    if (saved.uiLanguage === "en" || saved.uiLanguage === "fa") stored.uiLanguage = saved.uiLanguage;
    if (typeof saved.autoplayNext === "boolean") stored.autoplayNext = saved.autoplayNext;
  }
  current = {
    ...DEFAULTS,
    ...stored,
    subtitleDefaults: { ...DEFAULTS.subtitleDefaults, ...stored.subtitleDefaults },
  };
  apply(current, null);
  for (const fn of listeners) fn();
  return current;
}

function outlineShadow(px: number): string {
  if (px <= 0) return "none";
  const s = `${px}px`;
  return [
    `0 0 ${s} #000`,
    `0 0 ${s} #000`,
    `${s} 0 ${s} #000`,
    `-${s} 0 ${s} #000`,
    `0 ${s} ${s} #000`,
    `0 -${s} ${s} #000`,
  ].join(", ");
}

/** Makes settings take effect; `prev` is null on first load (apply everything). */
function apply(s: Settings, prev: Settings | null): void {
  const root = document.documentElement.style;
  root.setProperty("--sub-font-persian", `"${s.fontPersian}", "Vazirmatn", "Noto Naskh Arabic", sans-serif`);
  root.setProperty("--sub-font-latin", `"${s.fontLatin}", "Inter", "Noto Sans", sans-serif`);
  root.setProperty("--sub-outline", outlineShadow(s.outline));
  root.setProperty("--sub-gap", `${s.trackGap}em`);
  root.setProperty("--sub-bottom", `${s.bottomMargin}%`);

  if (!prev || prev.uiLanguage !== s.uiLanguage) setLang(s.uiLanguage ?? defaultLang());
  if (!prev || prev.theme !== s.theme) setTheme(s.theme);
  if (!prev || prev.hwdec !== s.hwdec) void api.setMpvOption("hwdec", s.hwdec);
  if (!prev || prev.defaultSpeed !== s.defaultSpeed) void api.setMpvOption("speed", String(s.defaultSpeed));
  if (!prev || prev.defaultVolume !== s.defaultVolume) void api.setMpvOption("volume", String(s.defaultVolume));
}
