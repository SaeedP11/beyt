import { api } from "./api";
import * as clock from "./clock";
import { activeCues, cueIndexAt, neighbourCue } from "./cues";
import { languageName, t } from "./i18n";
import { TrackView, defaultStyle } from "./overlay";
import type { Cue, Media, Mode, Playback, PickedWord, Track, TrackStyle, TrackUpdate } from "./types";
import type { Action } from "./keymap";
import { getSettings } from "./settings";
import { debounce, fmtTime, toast } from "./ui";

const MODES: Mode[] = ["show", "blur", "hide"];

export function trackLabel(track: Track): string {
  const parts = [languageName(track.lang)];
  if (track.detail) parts.push(track.detail);
  return parts.join(" · ");
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** The open video, its subtitle tracks and the keys that act on them. */
export class Player {
  media: Media | null = null;
  views: TrackView[] = [];
  /** Pause at the end of every line of the selected track (shadowing practice). */
  autoPause = false;
  private pendingLineEnd: number | null = null;
  /** The next episode, counting down to autoplay. */
  upNext: { path: string; name: string; seconds: number; total: number } | null = null;
  /** Bumped on every change the UI should show (tracks, styles, up next). */
  version = 0;

  private listeners = new Set<() => void>();
  private selected = 0;
  private eofHandled = false;
  private countdown: number | undefined;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private changed(): void {
    this.version += 1;
    for (const fn of this.listeners) fn();
  }

  async open(path: string): Promise<Media> {
    this.cancelCountdown();
    const settings = getSettings();
    const media = await api.openMedia(path, {
      preferredLanguages: settings.preferredLanguages,
      resume: settings.resumePlayback,
    });
    this.autoPause = settings.autoPauseDefault;
    this.clearViews();
    this.media = media;
    clock.jump(media.resumedAt ?? 0);
    this.views = media.tracks.map(
      (tr) => new TrackView(tr, { ...defaultStyle(tr), ...media.series?.tracks[tr.key] }),
    );
    this.selected = Math.max(0, this.views.findIndex((v) => v.style.enabled && v.isText));
    this.eofHandled = false;
    this.syncMpvSubtitle();
    document.title = `${media.title} · Beyt`;
    if (media.resumedAt) toast(t("resumed", { time: fmtTime(media.resumedAt) }), 4000);
    this.changed();
    return media;
  }

  async close(): Promise<void> {
    this.cancelCountdown();
    this.clearViews();
    this.media = null;
    document.title = "Beyt";
    await api.stop();
  }

  private clearViews(): void {
    for (const v of this.views) v.remove();
    this.views = [];
  }

  onTrackUpdated(u: TrackUpdate): void {
    if (!this.media || u.path !== this.media.path) return;
    const view = this.views.find((v) => v.track.id === u.track.id);
    if (!view) return;
    view.setTrack(u.track);
    this.changed();
  }

  async addSubtitle(path: string): Promise<void> {
    if (!this.media) return;
    const track = await api.addSubtitle(path);
    const saved = this.media.series?.tracks[track.key];
    const view = new TrackView(track, { ...defaultStyle(track), enabled: true, ...saved });
    this.views.push(view);
    this.save();
    this.changed();
  }

  /**
   * Changes a track's style. Switching a track on or off counts as a change
   * to the track list; other changes only restyle it.
   */
  updateStyle(view: TrackView, patch: Partial<TrackStyle>): void {
    Object.assign(view.style, patch);
    if (patch.enabled !== undefined && !view.isText) {
      // mpv can only draw one picture-based track at a time.
      if (patch.enabled) {
        for (const other of this.views) {
          if (other !== view && !other.isText) other.style.enabled = false;
        }
      }
      this.syncMpvSubtitle();
    }
    view.applyStyle();
    view.invalidate();
    this.save();
    this.changed();
  }

  private syncMpvSubtitle(): void {
    const img = this.views.find((v) => !v.isText && v.style.enabled);
    const sid = img?.track.source.kind === "embedded" ? img.track.source.sid : null;
    void api.setMpvSubtitle(sid);
  }

  /** Saves every track's style under its key, keeping keys from other episodes. */
  private save = debounce(() => {
    const media = this.media;
    if (!media) return;
    const tracks = { ...(media.series?.tracks ?? {}) };
    for (const v of this.views) tracks[v.track.key] = { ...v.style };
    media.series = { tracks };
    void api.saveSeriesSettings(media.folder, media.series);
  }, 400);

  render(time: number): void {
    for (const v of this.views) v.render(time);
    this.checkAutoPause(time);
  }

  // ---------- auto-pause ----------

  toggleAutoPause(): void {
    this.autoPause = !this.autoPause;
    this.pendingLineEnd = null;
    toast(this.autoPause ? t("autoPauseOn") : t("autoPauseOff"));
    this.changed();
  }

  /** Pauses right after the selected track's current line ends. */
  private checkAutoPause(time: number): void {
    const v = this.selectedView();
    if (!this.autoPause || !v || clock.snapshot().paused) {
      this.pendingLineEnd = null;
      return;
    }
    const tt = v.trackTime(time);
    const cue = v.track.cues[cueIndexAt(v.track.cues, tt)];
    if (cue && tt < cue.end) {
      this.pendingLineEnd = cue.end;
    } else if (this.pendingLineEnd !== null) {
      // Only when playback ran past the end, not when a seek jumped over it.
      const ranPast = tt - this.pendingLineEnd < 0.5;
      this.pendingLineEnd = null;
      if (ranPast) void api.setPause(true);
    }
  }

  // ---------- end of file ----------

  onPlayback(p: Playback): void {
    if (!this.media) return;
    if (!p.eof) {
      this.eofHandled = false;
    } else if (!this.eofHandled) {
      this.eofHandled = true;
      void this.playNextSoon();
    }
  }

  private async playNextSoon(): Promise<void> {
    if (!getSettings().autoplayNext || !this.media) return;
    const next = await api.nextVideo(this.media.path);
    if (!next) {
      toast(t("lastEpisode"), 4000);
      return;
    }
    const seconds = getSettings().autoplayDelay;
    this.upNext = { path: next, name: baseName(next).replace(/\.[^.]+$/, ""), seconds, total: seconds };
    this.changed();
    this.countdown = window.setInterval(() => {
      if (!this.upNext) return;
      this.upNext = { ...this.upNext, seconds: this.upNext.seconds - 1 };
      if (this.upNext.seconds > 0) this.changed();
      else void this.playUpNext();
    }, 1000);
  }

  /** Plays the next episode now instead of waiting for the countdown. */
  async playUpNext(): Promise<void> {
    const next = this.upNext?.path;
    this.cancelCountdown();
    if (next) await this.open(next).catch((e) => toast(String(e), 4000));
  }

  /** Stops a pending autoplay; returns whether one was pending. */
  cancelCountdown(): boolean {
    if (this.countdown === undefined && !this.upNext) return false;
    clearInterval(this.countdown);
    this.countdown = undefined;
    this.upNext = null;
    this.changed();
    return true;
  }

  // ---------- keys ----------

  private textViews(): TrackView[] {
    return this.views.filter((v) => v.isText && v.style.enabled);
  }

  selectedView(): TrackView | undefined {
    const views = this.textViews();
    return views[this.selected % Math.max(views.length, 1)];
  }

  /** A clicked word element (inside a TrackView line) with its line and translation. */
  wordContext(wordEl: HTMLElement): PickedWord | null {
    const trackId = wordEl.closest<HTMLElement>(".track")?.dataset.track;
    const cueIndex = Number(wordEl.closest<HTMLElement>(".line")?.dataset.cue);
    const view = this.views.find((v) => String(v.track.id) === trackId);
    const cue = view?.track.cues[cueIndex];
    if (!view || !cue) return null;
    return { word: wordEl.textContent ?? "", ...this.lineContext(view, cue) };
  }

  /** A line in video time, with the other language's line shown alongside it. */
  private lineContext(view: TrackView, cue: Cue): Omit<PickedWord, "word"> {
    const start = cue.start + view.style.offset;
    const end = cue.end + view.style.offset;
    const other = this.views.find((v) => v !== view && v.isText && v.style.enabled);
    const otherCues = other ? activeCues(other.track.cues, other.trackTime((start + end) / 2)) : [];
    const translation = otherCues.map((i) => other!.track.cues[i]!.text).join("\n") || null;
    return { lang: view.track.lang, rtl: view.track.rtl, sentence: cue.text, translation, start, end };
  }

  /** Saves the selected track's current line (W) to the vocabulary. */
  async saveCurrentLine(): Promise<void> {
    const v = this.selectedView();
    if (!v || !this.media) return;
    const cue = v.track.cues[cueIndexAt(v.track.cues, v.trackTime(clock.now()))];
    if (!cue) return;
    const { rtl: _rtl, ...line } = this.lineContext(v, cue);
    try {
      await api.saveVocab({ ...line, word: null, meaning: null, video: this.media.path }, captureOptions());
      toast(t("lineSaved"));
    } catch (e) {
      toast(String(e), 5000);
    }
  }

  seekTo(time: number): void {
    const target = Math.max(0, time);
    clock.jump(target);
    void api.seekAbsolute(target);
  }

  private jumpLine(delta: -1 | 1): void {
    const v = this.selectedView();
    if (!v) return;
    const i = neighbourCue(v.track.cues, v.trackTime(clock.now()), delta);
    if (i >= 0) this.seekTo(v.track.cues[i]!.start + v.style.offset);
  }

  private replayLine(): void {
    const v = this.selectedView();
    if (!v) return;
    const i = cueIndexAt(v.track.cues, v.trackTime(clock.now()));
    if (i >= 0) this.seekTo(v.track.cues[i]!.start + v.style.offset);
  }

  /** Runs a playback or subtitle action; returns false if it isn't one. */
  runAction(action: Action): boolean {
    const v = this.selectedView();
    const { seekStep } = getSettings();
    switch (action) {
      case "togglePause":
        void api.togglePause();
        break;
      case "seekBack":
        this.seekTo(clock.now() - seekStep);
        break;
      case "seekForward":
        this.seekTo(clock.now() + seekStep);
        break;
      case "restart":
        this.seekTo(0);
        break;
      case "volumeUp":
      case "volumeDown":
        void api
          .adjustProperty("volume", action === "volumeUp" ? 5 : -5)
          .then((n) => toast(t("volumeToast", { n: Math.round(n) })));
        break;
      case "mute":
        void api.toggleMute().then((muted) => toast(muted ? t("muted") : t("unmuted")));
        break;
      case "speedUp":
      case "speedDown":
        void api
          .adjustProperty("speed", action === "speedUp" ? 0.1 : -0.1)
          .then((n) => toast(t("speedToast", { n: n.toFixed(2).replace(/0$/, "") })));
        break;
      case "speedReset":
        void api.setMpvOption("speed", "1").then(() => toast(t("speedToast", { n: "1.0" })));
        break;
      case "prevLine":
        this.jumpLine(-1);
        break;
      case "nextLine":
        this.jumpLine(1);
        break;
      case "replayLine":
        this.replayLine();
        break;
      case "autoPause":
        this.toggleAutoPause();
        break;
      case "saveLine":
        void this.saveCurrentLine();
        break;
      case "nextTrack": {
        const views = this.textViews();
        if (!views.length) break;
        this.selected = (this.selected + 1) % views.length;
        toast(t("selected", { name: trackLabel(this.selectedView()!.track) }));
        break;
      }
      case "offsetMinus":
      case "offsetPlus": {
        if (!v) break;
        const offset = Math.round((v.style.offset + (action === "offsetPlus" ? 0.1 : -0.1)) * 10) / 10;
        this.updateStyle(v, { offset });
        toast(t("offsetToast", { name: trackLabel(v.track), ms: Math.round(offset * 1000) }));
        break;
      }
      case "cycleMode":
        if (!v) break;
        this.updateStyle(v, { mode: MODES[(MODES.indexOf(v.style.mode) + 1) % MODES.length]! });
        toast(`${trackLabel(v.track)}: ${t(v.style.mode)}`);
        break;
      case "togglePosition":
        if (!v) break;
        this.updateStyle(v, { position: v.style.position === "top" ? "bottom" : "top" });
        toast(`${trackLabel(v.track)}: ${t(v.style.position)}`);
        break;
      default:
        return false;
    }
    return true;
  }
}

/** Vocabulary capture options from the Learning settings. */
export function captureOptions(): { padding: number; screenshot: boolean } {
  const s = getSettings();
  return { padding: s.clipPadding / 1000, screenshot: s.saveScreenshots };
}
