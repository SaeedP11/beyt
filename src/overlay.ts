import { activeCues } from "./cues";
import { getSettings } from "./settings";
import type { Track, TrackStyle } from "./types";

/** The style a track starts with when its series has nothing saved for it. */
export function defaultStyle(track: Track): TrackStyle {
  const defaults = getSettings().subtitleDefaults;
  const base = track.lang === "fa" || track.lang === "en" ? defaults[track.lang] : defaults.other;
  return { ...base, enabled: track.defaultEnabled, mode: "show", offset: 0 };
}

/** One subtitle track drawn on the overlay. */
export class TrackView {
  private readonly el: HTMLDivElement;
  private shownKey = "";

  constructor(
    public track: Track,
    readonly style: TrackStyle,
  ) {
    this.el = document.createElement("div");
    this.el.className = "track";
    this.applyStyle();
  }

  /** Drawn by the overlay (text tracks), not by mpv (picture-based ones). */
  get isText(): boolean {
    return this.track.status !== "image";
  }

  /** Replaces the track data, e.g. when an embedded track finishes extracting. */
  setTrack(track: Track): void {
    this.track = track;
    this.applyStyle();
    this.invalidate();
  }

  applyStyle(): void {
    const s = this.style;
    const parent = document.getElementById(s.position === "top" ? "subs-top" : "subs-bottom")!;
    if (this.el.parentElement !== parent) parent.append(this.el);
    this.el.lang = this.track.lang;
    this.el.dataset.track = String(this.track.id);
    // The size is set for a 1280×720 window; --sub-scale follows the window.
    this.el.style.fontSize = `calc(${s.size}px * var(--sub-scale))`;
    this.el.style.color = s.color;
    this.el.classList.toggle("rtl", this.track.rtl);
    this.el.classList.toggle("blur", s.mode === "blur");
    this.el.classList.toggle("boxed", s.boxed);
    this.el.hidden = !s.enabled || s.mode === "hide" || !this.isText;
  }

  /** Forces a redraw on the next frame (after an offset change, for example). */
  invalidate(): void {
    this.shownKey = "";
  }

  /** Track time for a video time, after the offset. */
  trackTime(videoTime: number): number {
    return videoTime - this.style.offset;
  }

  render(videoTime: number): void {
    if (this.el.hidden) return;
    const idx = activeCues(this.track.cues, this.trackTime(videoTime));
    const key = idx.join(",");
    if (key === this.shownKey) return;
    this.shownKey = key;
    this.el.replaceChildren(
      ...idx.flatMap((i) => this.track.cues[i]!.text.split("\n").map((text) => renderLine(text, i))),
    );
  }

  remove(): void {
    this.el.remove();
  }
}

/** Punctuation around a word, kept outside its span so the highlight and
 *  the lookup cover only the word ("hello," → "hello"). */
const EDGES = /^([^\p{L}\p{M}\p{N}]*)(.*?)([^\p{L}\p{M}\p{N}]*)$/su;

/** One subtitle line, a span per word so the word popup can attach later. */
function renderLine(text: string, cueIndex: number): HTMLElement {
  const line = document.createElement("span");
  line.className = "line";
  line.dir = "auto";
  line.dataset.cue = String(cueIndex);
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    const [, lead = "", core = "", trail = ""] = EDGES.exec(part) ?? [];
    if (!core) {
      line.append(part);
      continue;
    }
    const word = document.createElement("span");
    word.className = "word";
    word.textContent = core;
    line.append(lead, word, trail);
  }
  return line;
}
