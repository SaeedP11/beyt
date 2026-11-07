// Subtitle text in the browser: decoding legacy encodings, parsing SRT and
// WebVTT into cues, and fixing common Persian text problems. This mirrors
// src-tauri/src/subs.rs, so a file reads the same on every platform.

import type { Cue } from "../types";

export const VIDEO_EXTENSIONS = ["mkv", "mp4", "m4v", "webm", "avi", "mov", "ts", "m2ts", "wmv", "flv", "ogv", "m3u8"];
export const SUBTITLE_EXTENSIONS = ["srt", "vtt"];

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export const isVideoName = (name: string) => VIDEO_EXTENSIONS.includes(extensionOf(name));
export const isSubtitleName = (name: string) => SUBTITLE_EXTENSIONS.includes(extensionOf(name));

/** Compares names with digit runs as numbers: "Episode 2" < "Episode 10". */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const pa = a.match(re) ?? [];
  const pb = b.match(re) ?? [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i]!;
    const y = pb[i]!;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const tx = x.replace(/^0+/, "");
      const ty = y.replace(/^0+/, "");
      const d = tx.length - ty.length || (tx < ty ? -1 : tx > ty ? 1 : 0);
      if (d) return d;
    } else {
      const lx = x.toLowerCase();
      const ly = y.toLowerCase();
      if (lx !== ly) return lx < ly ? -1 : 1;
    }
  }
  return pa.length - pb.length;
}

// ---------- decoding ----------

const arabicShare = (text: string): number => {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const arabic = text.match(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g)?.length ?? 0;
  return letters ? arabic / letters : 0;
};

/** UTF-8/UTF-16 with a BOM, plain UTF-8, else a legacy encoding: Windows-1256
 *  for Persian and Arabic files, Windows-1252 for the rest. */
export function decode(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    const arabic = new TextDecoder("windows-1256").decode(bytes);
    return arabicShare(arabic) > 0.4 ? arabic : new TextDecoder("windows-1252").decode(bytes);
  }
}

// ---------- parsing ----------

function parseTime(raw: string): number | null {
  const parts = raw.replace(",", ".").split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [h, m, s] = (parts.length === 3 ? nums : [0, ...nums]) as [number, number, number];
  return h * 3600 + m * 60 + s;
}

/** Removes HTML-style tags (`<i>`, `<font …>`) and ASS override blocks (`{\an8}`). */
function stripMarkup(line: string): string {
  let out = "";
  let angle = false;
  let brace = false;
  for (const ch of line) {
    if (ch === "<" && !brace) angle = true;
    else if (ch === ">" && angle) angle = false;
    else if (ch === "{" && !angle) brace = true;
    else if (ch === "}" && brace) brace = false;
    else if (!angle && !brace) out += ch;
  }
  return out.trim();
}

/** Parses SRT or WebVTT text. Cues come back sorted by start time. */
export function parseSubtitles(input: string): Cue[] {
  const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const cues: Cue[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n").map((l) => l.trim());
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [from = "", rest = ""] = lines[at]!.split("-->", 2);
    const to = rest.trim().split(/\s+/)[0] ?? "";
    const start = parseTime(from.trim());
    const end = parseTime(to);
    if (start === null || end === null || end <= start) continue;
    const body = lines
      .slice(at + 1)
      .map(stripMarkup)
      .filter(Boolean);
    if (body.length) cues.push({ start, end, text: body.join("\n") });
  }
  return cues.sort((a, b) => a.start - b.start);
}

// ---------- Persian ----------

const ARABIC_SCRIPT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
const FLIPPABLE = new Set([".", "!", "?", "؟", "،", "؛", ":", "…"]);

export function isMostlyRtl(texts: string[]): boolean {
  let rtl = 0;
  let ltr = 0;
  for (const ch of texts.join("")) {
    if (ARABIC_SCRIPT.test(ch)) rtl++;
    else if (/\p{L}/u.test(ch)) ltr++;
  }
  return rtl > ltr;
}

/** Arabic letter forms to Persian ones, and punctuation typed at the start of a
 *  line moved back to its end. */
export function fixPersian(text: string): string {
  return text
    .split("\n")
    .map((raw) => {
      const line = raw.replace(/[يى]/g, "ی").replace(/ك/g, "ک");
      const chars = [...line];
      let n = 0;
      while (n < chars.length && FLIPPABLE.has(chars[n]!)) n++;
      const lead = chars.slice(0, n).join("");
      const rest = chars.slice(n).join("");
      return lead && rest && ARABIC_SCRIPT.test(rest[0]!) ? rest + lead : line;
    })
    .join("\n");
}

export interface LoadedSubtitles {
  cues: Cue[];
  rtl: boolean;
}

export function loadSubtitles(bytes: Uint8Array): LoadedSubtitles {
  const cues = parseSubtitles(decode(bytes));
  if (!cues.length) throw new Error("no subtitle lines found");
  const rtl = isMostlyRtl(cues.map((c) => c.text));
  return { cues: rtl ? cues.map((c) => ({ ...c, text: fixPersian(c.text) })) : cues, rtl };
}

// ---------- language ----------

const LANGS: Record<string, string> = {};
for (const [code, names] of Object.entries({
  fa: "fa fas per persian farsi",
  en: "en eng english",
  ar: "ar ara arabic",
  tr: "tr tur turkish",
  fr: "fr fra fre french",
  de: "de deu ger german",
  es: "es spa spanish",
  it: "it ita italian",
  ru: "ru rus russian",
  ja: "ja jpn japanese",
  ko: "ko kor korean",
  zh: "zh zho chi chinese",
  he: "he heb hebrew",
  ur: "ur urd urdu",
})) {
  for (const n of names.split(" ")) LANGS[n] = code;
}

export const normalizeLang = (tag: string): string | null => LANGS[tag.toLowerCase()] ?? null;
export const isRtlLang = (code: string): boolean => ["fa", "ar", "he", "ur"].includes(code);

/** Language code from a subtitle name like `Movie.fa.srt` or `Movie.English.srt`. */
export function langFromFileName(name: string, videoStem?: string): string | null {
  const dot = name.lastIndexOf(".");
  const stem = dot < 0 ? name : name.slice(0, dot);
  const split = (s: string) => s.split(/[._\- ]/);
  const tags = videoStem && stem.startsWith(videoStem) ? stem.slice(videoStem.length) : (split(stem).pop() ?? "");
  for (const tag of split(tags).reverse()) {
    const code = normalizeLang(tag);
    if (code) return code;
  }
  return null;
}
