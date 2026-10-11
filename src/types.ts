// Shapes shared with the Rust core (see src-tauri/src/subs.rs and player.rs).

export interface Cue {
  /** Seconds from the start of the video. */
  start: number;
  end: number;
  /** Lines separated by "\n", tags already stripped. */
  text: string;
}

export interface Track {
  id: number;
  label: string;
  /** "fa", "en", or another language code; "und" when unknown. */
  lang: string;
  rtl: boolean;
  /** Sorted by start. */
  cues: Cue[];
}

/** The `playback` event payload. */
export interface Playback {
  time: number;
  paused: boolean;
  speed: number;
  duration: number;
}

export type Position = "top" | "bottom";
export type Mode = "show" | "blur" | "hide";

export interface TrackStyle {
  position: Position;
  /** Font size in CSS pixels. */
  size: number;
  color: string;
  mode: Mode;
  boxed: boolean;
  /** Timing offset in seconds; positive shows the subtitle later. */
  offset: number;
}
