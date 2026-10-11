import { activeCues } from "./cues";
import type { Track, TrackStyle } from "./types";

const DEFAULT_STYLES: Record<string, Omit<TrackStyle, "offset">> = {
  fa: { position: "bottom", size: 34, color: "#ffffff", mode: "show", boxed: false },
  en: { position: "bottom", size: 30, color: "#ffe9a8", mode: "show", boxed: false },
  other: { position: "top", size: 28, color: "#d6f0ff", mode: "show", boxed: false },
};

/** One subtitle track drawn on the overlay. */
export class TrackView {
  readonly style: TrackStyle;
  private readonly el: HTMLDivElement;
  private shownKey = "";

  constructor(readonly track: Track) {
    const base = DEFAULT_STYLES[track.lang] ?? DEFAULT_STYLES.other!;
    this.style = { ...base, offset: 0 };
    this.el = document.createElement("div");
    this.el.className = "track";
    this.el.lang = track.lang;
    this.applyStyle();
  }

  applyStyle(): void {
    const s = this.style;
    const parent = document.getElementById(s.position === "top" ? "subs-top" : "subs-bottom")!;
    if (this.el.parentElement !== parent) parent.append(this.el);
    this.el.style.fontSize = `${s.size}px`;
    this.el.style.color = s.color;
    this.el.classList.toggle("rtl", this.track.rtl);
    this.el.classList.toggle("blur", s.mode === "blur");
    this.el.classList.toggle("boxed", s.boxed);
    this.el.hidden = s.mode === "hide";
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
    const idx = activeCues(this.track.cues, this.trackTime(videoTime));
    const key = idx.join(",");
    if (key === this.shownKey) return;
    this.shownKey = key;
    this.el.replaceChildren(
      ...idx.flatMap((i) => this.track.cues[i]!.text.split("\n").map(renderLine)),
    );
  }
}

/** One subtitle line, a span per word so the word popup can attach later. */
function renderLine(text: string): HTMLElement {
  const line = document.createElement("span");
  line.className = "line";
  line.dir = "auto";
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      line.append(part);
    } else {
      const word = document.createElement("span");
      word.textContent = part;
      line.append(word);
    }
  }
  return line;
}
