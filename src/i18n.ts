// UI text in English and Persian. Persian also flips the page layout to RTL.

export type Lang = "en" | "fa";

const en = {
  appTagline: "Watch with two subtitles at once",
  openFile: "Open video…",
  openFolder: "Open folder…",
  recent: "Continue watching",
  noRecent: "Nothing watched yet. Open a video to start.",
  folder: "Folder",
  up: "Up",
  emptyFolder: "No videos or folders here.",
  back: "Back to library",
  watched: "Watched",
  tracks: "Subtitles",
  addSubtitle: "Add subtitle file…",
  noTracks: "This video has no subtitles. Add a file.",
  position: "Position",
  top: "Top",
  bottom: "Bottom",
  size: "Size",
  color: "Color",
  mode: "Display",
  show: "Show",
  blur: "Blur",
  hide: "Hide",
  boxed: "Background box",
  offset: "Offset",
  embedded: "embedded",
  forced: "forced",
  loading: "loading…",
  imageTrack: "picture-based, drawn by mpv",
  failed: "failed",
  resumed: "Resumed at {time}. Press Home to start over.",
  upNext: "Up next",
  playingIn: "Playing in {n}s",
  playNow: "Play now",
  cancel: "Cancel",
  minutesLeft: "{n} min left",
  fullscreen: "Fullscreen",
  info: "Info",
  play: "Play",
  pause: "Pause",
  dropHint: "Open a video or a folder to get started.",
  lastEpisode: "That was the last video in this folder.",
  selected: "Selected: {name}",
  offsetToast: "{name}: offset {ms} ms",
  uiLanguage: "Interface language",
  autoplayNext: "Play next episode automatically",
  settings: "Settings",
  close: "Close",
  paused: "paused",
  keys:
    "Space pause · ←/→ seek 5s · A/D prev/next line · S replay · Tab select track · [ ] offset · B show/blur/hide · T top/bottom · L subtitles · F fullscreen · Esc library · I info",
};

type Strings = typeof en;

const fa: Strings = {
  appTagline: "تماشا با دو زیرنویس هم‌زمان",
  openFile: "باز کردن ویدیو…",
  openFolder: "باز کردن پوشه…",
  recent: "ادامهٔ تماشا",
  noRecent: "هنوز چیزی تماشا نکرده‌اید. یک ویدیو باز کنید.",
  folder: "پوشه",
  up: "بالا",
  emptyFolder: "اینجا ویدیو یا پوشه‌ای نیست.",
  back: "بازگشت به کتابخانه",
  watched: "دیده‌شده",
  tracks: "زیرنویس‌ها",
  addSubtitle: "افزودن فایل زیرنویس…",
  noTracks: "این ویدیو زیرنویس ندارد. یک فایل اضافه کنید.",
  position: "جایگاه",
  top: "بالا",
  bottom: "پایین",
  size: "اندازه",
  color: "رنگ",
  mode: "نمایش",
  show: "نمایش",
  blur: "محو",
  hide: "پنهان",
  boxed: "کادر پس‌زمینه",
  offset: "جابه‌جایی زمان",
  embedded: "درون فایل",
  forced: "اجباری",
  loading: "در حال بارگذاری…",
  imageTrack: "تصویری، با mpv نمایش داده می‌شود",
  failed: "ناموفق",
  resumed: "از {time} ادامه یافت. برای شروع از اول Home را بزنید.",
  upNext: "قسمت بعد",
  playingIn: "پخش تا {n} ثانیهٔ دیگر",
  playNow: "پخش کن",
  cancel: "لغو",
  minutesLeft: "{n} دقیقه مانده",
  fullscreen: "تمام‌صفحه",
  info: "اطلاعات",
  play: "پخش",
  pause: "مکث",
  dropHint: "برای شروع یک ویدیو یا پوشه باز کنید.",
  lastEpisode: "این آخرین ویدیوی این پوشه بود.",
  selected: "انتخاب‌شده: {name}",
  offsetToast: "{name}: جابه‌جایی {ms} میلی‌ثانیه",
  uiLanguage: "زبان رابط",
  autoplayNext: "پخش خودکار قسمت بعد",
  settings: "تنظیمات",
  close: "بستن",
  paused: "مکث",
  keys:
    "فاصله: مکث · ←/→ پنج ثانیه · A/D خط قبل/بعد · S تکرار خط · Tab انتخاب زیرنویس · [ ] جابه‌جایی زمان · B نمایش/محو/پنهان · T بالا/پایین · L زیرنویس‌ها · F تمام‌صفحه · Esc کتابخانه · I اطلاعات",
};

const STRINGS: Record<Lang, Strings> = { en, fa };

let current: Lang = "en";
const listeners = new Set<() => void>();

export function setLang(lang: Lang): void {
  current = lang;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";
  for (const fn of listeners) fn();
}

/** For React's `useSyncExternalStore`. */
export function subscribeLang(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getLang(): Lang {
  return current;
}

export function defaultLang(): Lang {
  return navigator.language.toLowerCase().startsWith("fa") ? "fa" : "en";
}

export type StringKey = keyof Strings;

/** Translated text, with `{name}` placeholders filled from `vars`. */
export function t(key: StringKey, vars: Record<string, string | number> = {}): string {
  return STRINGS[current][key].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
}

/** A language code's name in the UI language ("fa" → "Persian" / "فارسی"). */
export function languageName(code: string): string {
  if (code === "und") return current === "fa" ? "نامشخص" : "Unknown";
  try {
    return new Intl.DisplayNames([current], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
