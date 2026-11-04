// The browser's stand-in for mpv: one <video> element, and the same
// `playback` events the Rust core sends, so the overlay and the controls
// behave identically.

import type { Aspect, Playback } from "../types";

type Listener<T> = (payload: T) => void;

/** A tiny event bus with the same shape as Tauri's `listen`. */
export class Bus {
  private listeners = new Map<string, Set<Listener<never>>>();

  on<T>(name: string, cb: Listener<T>): () => void {
    const set = this.listeners.get(name) ?? new Set();
    set.add(cb as Listener<never>);
    this.listeners.set(name, set);
    return () => set.delete(cb as Listener<never>);
  }

  emit<T>(name: string, payload: T): void {
    for (const cb of this.listeners.get(name) ?? []) (cb as Listener<T>)(payload);
  }
}

export const bus = new Bus();

/** Brightness range of the picture, in percent (the desktop's mpv range). */
export const VIDEO_BRIGHTNESS = { min: 50, max: 115 };

class Engine {
  readonly video: HTMLVideoElement;
  private objectUrl: string | null = null;
  private releaseUrl: (() => void) | null = null;
  private brightness = 100;
  private aspect: Aspect = "auto";
  private volumeLevel = 100;
  private lastEmit = 0;

  constructor() {
    const v = document.createElement("video");
    v.playsInline = true;
    v.preload = "auto";
    v.style.cssText = "width:100%;height:100%;background:#000;display:block";
    this.video = v;
    const emit = () => this.emit();
    for (const e of ["play", "pause", "seeked", "ratechange", "durationchange", "loadedmetadata", "ended", "volumechange"]) {
      v.addEventListener(e, emit);
    }
    // The desktop core reports a few times a second; the overlay extrapolates between.
    v.addEventListener("timeupdate", () => {
      if (performance.now() - this.lastEmit > 250) this.emit();
    });
  }

  snapshot(): Playback {
    const v = this.video;
    return {
      time: v.currentTime || 0,
      paused: v.paused,
      speed: v.playbackRate,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      eof: v.ended,
    };
  }

  private emit(): void {
    this.lastEmit = performance.now();
    bus.emit("playback", this.snapshot());
  }

  /** Loads a file and starts playing at `start` seconds. Resolves once the headers are read. */
  async load(media: { name: string; url: string; release: () => void }, start: number | null): Promise<void> {
    this.unload();
    this.objectUrl = media.url;
    this.releaseUrl = media.release;
    const v = this.video;
    v.src = media.url;
    this.applyAspect();
    await new Promise<void>((resolve, reject) => {
      const ok = () => (cleanup(), resolve());
      const bad = () => (cleanup(), reject(new Error(`This browser can't play ${media.name}. Try an MP4 or WebM file.`)));
      const cleanup = () => {
        v.removeEventListener("loadedmetadata", ok);
        v.removeEventListener("error", bad);
      };
      v.addEventListener("loadedmetadata", ok);
      v.addEventListener("error", bad);
    });
    if (start) v.currentTime = start;
    void v.play().catch(() => this.emit()); // Autoplay can be blocked until the first click.
    this.emit();
  }

  unload(): void {
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.releaseUrl?.();
    this.releaseUrl = null;
    this.objectUrl = null;
  }

  get time(): number {
    return this.video.currentTime || 0;
  }
  get duration(): number {
    return Number.isFinite(this.video.duration) ? this.video.duration : 0;
  }
  get loaded(): boolean {
    return this.objectUrl !== null;
  }

  setPause(paused: boolean): void {
    if (paused) this.video.pause();
    else void this.video.play();
  }
  seek(time: number): void {
    this.video.currentTime = Math.max(0, time);
  }

  /** Volume in percent; the page can't amplify, so it stops at 100. */
  setVolume(level: number): number {
    this.volumeLevel = Math.min(100, Math.max(0, level));
    this.video.volume = this.volumeLevel / 100;
    return this.volumeLevel;
  }
  get volume(): number {
    return this.volumeLevel;
  }
  setSpeed(speed: number): number {
    this.video.playbackRate = Math.min(4, Math.max(0.25, speed));
    return this.video.playbackRate;
  }

  setBrightness(level: number): number {
    this.brightness = Math.min(VIDEO_BRIGHTNESS.max, Math.max(VIDEO_BRIGHTNESS.min, Math.round(level)));
    this.video.style.filter = `brightness(${this.brightness / 100})`;
    return this.brightness;
  }
  get pictureBrightness(): number {
    return this.brightness;
  }

  setAspect(aspect: Aspect): void {
    this.aspect = aspect;
    this.applyAspect();
  }

  private applyAspect(): void {
    const s = this.video.style;
    const ratio = /^(\d+):(\d+)$/.exec(this.aspect);
    s.objectFit = this.aspect === "fill" ? "cover" : this.aspect === "stretch" ? "fill" : "contain";
    if (ratio) {
      // A forced ratio: stretch the picture to that shape, then fit it in the window.
      s.objectFit = "fill";
      s.aspectRatio = `${ratio[1]} / ${ratio[2]}`;
      s.margin = "auto";
      s.width = "auto";
      s.height = "auto";
      s.maxWidth = "100%";
      s.maxHeight = "100%";
      s.position = "absolute";
      s.inset = "0";
    } else {
      s.aspectRatio = s.margin = s.maxWidth = s.maxHeight = s.inset = "";
      s.position = "";
      s.width = s.height = "100%";
    }
  }

  /** A JPEG frame at `at` seconds (null: now) as a data URL; used for thumbnails and cards. */
  frame(video: HTMLVideoElement, maxWidth: number): string {
    const scale = Math.min(1, maxWidth / (video.videoWidth || maxWidth));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round((video.videoWidth || maxWidth) * scale);
    canvas.height = Math.round((video.videoHeight || (maxWidth * 9) / 16) * scale);
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.8);
  }
}

export const engine = new Engine();
