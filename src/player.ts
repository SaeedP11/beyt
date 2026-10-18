import { api, type Brightness } from "./api";
import * as clock from "./clock";
import { activeCues, cueIndexAt, neighbourCue } from "./cues";
import { languageName, t } from "./i18n";
import { TrackView, defaultStyle } from "./overlay";
import type {
  Aspect,
  AudioChoice,
  AudioTrack,
  AudioUpdate,
  Cue,
  Media,
  Mode,
  Playback,
  PickedWord,
  Track,
  TrackStyle,
  TrackUpdate,
} from "./types";
import type { Action } from "./keymap";
import { clampMargin, getSettings, marginKey, updateSettings } from "./settings";
import { debounce, fmtTime, toast } from "./ui";

const MODES: Mode[] = ["show", "blur", "hide"];

/** Picture shapes in the order the aspect key cycles through them. */
export const ASPECTS: Aspect[] = ["auto", "original", "16:9", "4:3", "fill", "stretch"];

export function aspectLabel(aspect: Aspect): string {
  if (aspect === "auto") return t("aspectAuto");
  if (aspect === "original") return t("aspectOriginal");
  if (aspect === "fill") return t("aspectFill");
  if (aspect === "stretch") return t("aspectStretch");
  return aspect;
}

/** A volume or brightness change, as the level indicator shows it. */
export interface LevelChange {
  kind: "volume" | "brightness";
  level: number;
  muted: boolean;
  at: number;
}

/** One line of one subtitle track. */
export interface PickedLine {
  view: TrackView;
  cue: Cue;
}

export function trackLabel(track: Track): string {
  const parts = [languageName(track.lang)];
  if (track.detail) parts.push(track.detail);
  return parts.join(" · ");
}

/** "English · Commentary · 5.1" */
export function audioLabel(track: AudioTrack): string {
  const parts = [languageName(track.lang)];
  if (track.detail) parts.push(track.detail);
  const ch = track.channels;
  if (ch) parts.push(ch === 1 ? t("mono") : ch === 2 ? t("stereo") : ch === 6 ? "5.1" : ch === 8 ? "7.1" : `${ch} ch`);
  return parts.join(" · ");
}

/** The track that best fits a series' saved choice: same language and title, else same language. */
function preferredAudio(tracks: AudioTrack[], choice: AudioChoice): AudioTrack | undefined {
  const usable = tracks.filter((a) => a.supported);
  return (
    usable.find((a) => a.lang === choice.lang && a.detail === choice.detail) ??
    (choice.lang === "und" ? undefined : usable.find((a) => a.lang === choice.lang))
  );
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
  /** The picture's shape; every video starts on the best fit. */
  aspect: Aspect = "auto";
  /** The video's audio tracks; empty until it has loaded. */
  audio: AudioTrack[] = [];
  /** The audio track chosen for the series, picked again in its other episodes. */
  private audioChoice: AudioChoice | undefined;
  /** The series' choice has been looked for in this video's tracks. */
  private audioRestored = false;
  /** An audio file just added, whose track becomes the series' choice once it shows up. */
  private addedAudio: string | null = null;
  private pendingLineEnd: number | null = null;
  /** The next episode, counting down to autoplay. */
  upNext: { path: string; name: string; seconds: number; total: number } | null = null;
  /** The last volume or brightness change, for the level indicator. `at`
      changes on every step, so the indicator stays up while a key is held. */
  level: LevelChange | null = null;
  /** Bumped on every change the UI should show (tracks, styles, up next). */
  version = 0;

  private listeners = new Set<() => void>();
  private selected = 0;
  private eofHandled = false;
  private countdown: number | undefined;
  private volume: { level: number; muted: boolean } | null = null;
  /** Where the next brightness step should go, from the current level.
      Steps made while one is being set are combined into the next. */
  private brightnessTarget: ((now: number) => number) | null = null;
  private brightnessBusy = false;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private showVolume(change: { level?: number; muted?: boolean }): void {
    this.volume = { level: getSettings().defaultVolume, muted: false, ...this.volume, ...change };
    this.level = { kind: "volume", ...this.volume, at: performance.now() };
    this.changed();
  }

  /** Changes the volume by `delta` percent and shows the indicator. */
  adjustVolume(delta: number): void {
    void api.adjustProperty("volume", delta).then((n) => this.showVolume({ level: Math.round(n) }));
  }

  /** Changes the brightness by `delta` percent and shows the indicator. */
  adjustBrightness(delta: number): void {
    const prev = this.brightnessTarget;
    this.brightnessTarget = (now) => (prev ? prev(now) : now) + delta;
    void this.flushBrightness(true);
  }

  /** Sets the brightness to `level` percent; resolves to what was set. */
  async setBrightness(level: number): Promise<Brightness | null> {
    this.brightnessTarget = () => level;
    return this.flushBrightness(false);
  }

  private async flushBrightness(show: boolean): Promise<Brightness | null> {
    if (this.brightnessBusy) return null;
    this.brightnessBusy = true;
    let last: Brightness | null = null;
    try {
      while (this.brightnessTarget) {
        const target = this.brightnessTarget;
        this.brightnessTarget = null;
        const now = await api.getBrightness();
        last = await api.setBrightness(target(now.level));
        if (show) {
          this.level = { kind: "brightness", level: last.level, muted: false, at: performance.now() };
          this.changed();
        }
      }
    } catch (e) {
      this.brightnessTarget = null;
      toast(String(e), 5000);
    } finally {
      this.brightnessBusy = false;
    }
    return last;
  }

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
    this.aspect = "auto";
    void api.setAspect(this.aspect);
    this.audio = [];
    this.audioChoice = media.series?.audio;
    this.audioRestored = false;
    this.addedAudio = null;
    // In case `audio-tracks` came before this file was set; later changes come as events.
    void api.audioTracks().then((tracks) => this.onAudioTracks({ path: media.path, tracks }), () => {});
    document.title = `${media.title} · Beyt`;
    if (media.resumedAt) {
      toast(t("resumed", { time: fmtTime(media.resumedAt) }), 6000, {
        label: t("act_restart"),
        run: () => this.seekTo(0),
      });
    }
    this.changed();
    return media;
  }

  async close(): Promise<void> {
    this.cancelCountdown();
    this.clearViews();
    this.media = null;
    this.audio = [];
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

  /** Shows a subtitle file at `offset`, adding it first unless it is loaded already. */
  async useSubtitle(path: string, offset: number): Promise<void> {
    const loaded = () => this.views.find((v) => v.track.source.kind === "file" && v.track.source.path === path);
    if (!loaded()) await this.addSubtitle(path);
    const view = loaded();
    if (view) this.updateStyle(view, { enabled: true, offset });
  }

  /** Removes a subtitle file the user added; it won't load next time either. */
  async removeSubtitle(view: TrackView): Promise<void> {
    const selected = this.selectedView();
    const keys = await api.removeSubtitle(view.track.id);
    view.remove();
    this.views = this.views.filter((v) => v !== view);
    // Tracks after it may have moved up a key; keep their styles with them.
    for (const { id, key } of keys) {
      const v = this.views.find((v) => v.track.id === id);
      if (v) v.track = { ...v.track, key };
    }
    const stillSelected = selected && selected !== view ? this.textViews().indexOf(selected) : -1;
    this.selected = Math.max(0, stillSelected);
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

  /** Changes the picture's shape until the next video opens. */
  setAspect(aspect: Aspect): void {
    this.aspect = aspect;
    api.setAspect(aspect).then(
      () => toast(t("aspectToast", { name: aspectLabel(aspect) })),
      (e) => toast(String(e), 5000),
    );
    this.changed();
  }

  // ---------- audio tracks ----------

  onAudioTracks(u: AudioUpdate): void {
    if (!this.media || u.path !== this.media.path) return;
    this.audio = u.tracks;
    // Once the tracks are known, switch to the one chosen in other episodes.
    if (!this.audioRestored && u.tracks.length) {
      this.audioRestored = true;
      const pick = this.audioChoice && preferredAudio(u.tracks, this.audioChoice);
      if (pick && !pick.selected) void api.selectAudio(pick.id).catch(() => {});
    }
    const added = this.addedAudio && u.tracks.find((a) => a.file === this.addedAudio);
    if (added) {
      this.addedAudio = null;
      this.audioChoice = { lang: added.lang, detail: added.detail };
      this.save();
    }
    this.changed();
  }

  selectedAudio(): AudioTrack | undefined {
    return this.audio.find((a) => a.selected);
  }

  /** Switches to an audio track, for this video and the rest of its series. */
  selectAudio(track: AudioTrack): void {
    if (track.selected) return;
    // Shown at once; the next `audio-tracks` event confirms it.
    this.audio = this.audio.map((a) => ({ ...a, selected: a.id === track.id }));
    this.audioChoice = { lang: track.lang, detail: track.detail };
    api.selectAudio(track.id).then(
      () => toast(t("audioToast", { name: audioLabel(track) })),
      (e) => toast(String(e), 5000),
    );
    this.save();
    this.changed();
  }

  /** Plays an audio file alongside the video and switches to it. */
  async addAudio(path: string): Promise<void> {
    if (!this.media) return;
    this.addedAudio = path;
    try {
      await api.addAudio(path);
    } catch (e) {
      this.addedAudio = null;
      throw e;
    }
    toast(t("audioAdded"));
  }

  /** Removes an audio file the user added; it won't load next time either. */
  async removeAudio(track: AudioTrack): Promise<void> {
    await api.removeAudio(track.id);
    toast(t("audioRemoved", { name: audioLabel(track) }));
  }

  /** Moves to the next audio track the player can play. */
  private cycleAudio(): void {
    const usable = this.audio.filter((a) => a.supported);
    if (usable.length < 2) {
      toast(usable.length ? t("audioOnlyOne") : t("noAudio"));
      return;
    }
    const at = usable.findIndex((a) => a.selected);
    this.selectAudio(usable[(at + 1) % usable.length]!);
  }

  /** Saves every track's style under its key, keeping keys from other
      episodes, and the audio track. */
  private save = debounce(() => {
    const media = this.media;
    if (!media) return;
    const tracks = { ...(media.series?.tracks ?? {}) };
    for (const v of this.views) tracks[v.track.key] = { ...v.style };
    media.series = { tracks, ...(this.audioChoice && { audio: this.audioChoice }) };
    void api.saveSeriesSettings(media.folder, media.series);
  }, 400);

  render(time: number): void {
    for (const v of this.views) v.render(time);
    this.checkAutoPause(time);
  }

  // ---------- auto-pause ----------

  toggleAutoPause(): void {
    // It pauses at the end of the selected track's lines, so it needs one.
    if (!this.selectedView()) {
      toast(t("autoPauseNeedsTrack"));
      return;
    }
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

  /** The subtitle line an element belongs to (a word or the line itself). */
  lineAt(el: HTMLElement): PickedLine | null {
    const trackId = el.closest<HTMLElement>(".track")?.dataset.track;
    const cueIndex = Number(el.closest<HTMLElement>(".line")?.dataset.cue);
    const view = this.views.find((v) => String(v.track.id) === trackId);
    const cue = view?.track.cues[cueIndex];
    return view && cue ? { view, cue } : null;
  }

  /** A clicked word element (inside a TrackView line) with its line and translation. */
  wordContext(wordEl: HTMLElement): PickedWord | null {
    const line = this.lineAt(wordEl);
    if (!line) return null;
    return { word: wordEl.textContent ?? "", ...this.lineContext(line.view, line.cue) };
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
    if (!v) return;
    const cue = v.track.cues[cueIndexAt(v.track.cues, v.trackTime(clock.now()))];
    if (cue) await this.saveLine({ view: v, cue });
  }

  /** Saves a line to the vocabulary, with the other language's line as its translation. */
  async saveLine({ view, cue }: PickedLine): Promise<void> {
    if (!this.media) return;
    const { rtl: _rtl, ...line } = this.lineContext(view, cue);
    try {
      await api.saveVocab({ ...line, word: null, meaning: null, video: this.media.path }, captureOptions());
      toast(t("lineSaved"));
    } catch (e) {
      toast(String(e), 5000);
    }
  }

  /** Plays a line from its start. */
  playLine({ view, cue }: PickedLine): void {
    this.seekTo(cue.start + view.style.offset);
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
        this.adjustVolume(action === "volumeUp" ? 5 : -5);
        break;
      case "mute":
        void api.toggleMute().then((muted) => this.showVolume({ muted }));
        break;
      case "brightnessUp":
      case "brightnessDown":
        this.adjustBrightness(action === "brightnessUp" ? 5 : -5);
        break;
      case "speedUp":
      case "speedDown":
        void api
          .adjustProperty("speed", action === "speedUp" ? 0.1 : -0.1)
          .then((n) => toast(t("speedToast", { n: n.toFixed(2).replace(/0$/, "") })));
        break;
      case "aspect":
        this.setAspect(ASPECTS[(ASPECTS.indexOf(this.aspect) + 1) % ASPECTS.length]!);
        break;
      case "cycleAudio":
        this.cycleAudio();
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
      case "subsUp":
      case "subsDown": {
        const position = v?.style.position ?? "bottom";
        const key = marginKey(position);
        // Up is further from the bottom edge but closer to the top one.
        const step = (action === "subsUp") === (position === "bottom") ? 1 : -1;
        const n = clampMargin(getSettings()[key] + step);
        updateSettings({ [key]: n });
        toast(t(position === "top" ? "topMarginToast" : "bottomMarginToast", { n }));
        break;
      }
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
