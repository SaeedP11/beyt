// Shapes shared with the Rust core (see src-tauri/src/media.rs, main.rs, store.rs).

export interface Cue {
  /** Seconds from the start of the video. */
  start: number;
  end: number;
  /** Lines separated by "\n", tags already stripped. */
  text: string;
}

export type TrackSource =
  | { kind: "file"; path: string }
  | { kind: "embedded"; stream: number; sid: number; codec: string; forced: boolean; default: boolean };

export type TrackStatus = "ready" | "loading" | "image" | "failed";

export interface Track {
  id: number;
  /** Stable across a series' episodes, e.g. "fa:file:0". */
  key: string;
  /** Two-letter code when known, else the raw tag, else "und". */
  lang: string;
  /** File name or embedded title. */
  detail: string;
  rtl: boolean;
  source: TrackSource;
  status: TrackStatus;
  error: string | null;
  defaultEnabled: boolean;
  /** A file the user added by hand, so it can be removed again. */
  added: boolean;
  /** Sorted by start. */
  cues: Cue[];
}

export interface Media {
  path: string;
  title: string;
  folder: string;
  tracks: Track[];
  resumedAt: number | null;
  series: SeriesSettings | null;
}

export interface TrackUpdate {
  path: string;
  track: Track;
}

/** The `playback` event payload. */
export interface Playback {
  time: number;
  paused: boolean;
  speed: number;
  duration: number;
  eof: boolean;
}

export interface FolderEntry {
  path: string;
  name: string;
  isDir: boolean;
  position?: number;
  duration?: number;
}

export interface Folder {
  path: string;
  parent: string | null;
  entries: FolderEntry[];
}

export interface Recent {
  path: string;
  title: string;
  position: number;
  duration: number;
  updatedAt: number;
}

export type Position = "top" | "bottom";
export type Mode = "show" | "blur" | "hide";

export interface TrackStyle {
  enabled: boolean;
  position: Position;
  /** Font size in CSS pixels. */
  size: number;
  color: string;
  mode: Mode;
  boxed: boolean;
  /** Timing offset in seconds; positive shows the subtitle later. */
  offset: number;
}

/** Saved per series folder, keyed by track key. */
export interface SeriesSettings {
  tracks: Record<string, TrackStyle>;
}

export interface DictEntry {
  fa: string;
  pos: string;
  roman: string | null;
  glosses: string[];
}

export interface Lookup {
  word: string;
  /** The form that matched ("run" for "running"), or null when nothing did. */
  matched: string | null;
  entries: DictEntry[];
}

/** A clicked subtitle word with what is needed to look it up and save it. */
export interface PickedWord {
  word: string;
  lang: string;
  rtl: boolean;
  /** The whole subtitle line the word is in. */
  sentence: string;
  /** The other language's line shown at the same time, if any. */
  translation: string | null;
  /** The line's span in video time (offsets applied). */
  start: number;
  end: number;
}

export interface NewVocab {
  word: string | null;
  meaning: string | null;
  sentence: string;
  translation: string | null;
  lang: string;
  video: string;
  start: number;
  end: number;
}

export interface VocabItem extends NewVocab {
  id: number;
  /** File names in the vocab media folder. */
  screenshot: string | null;
  audio: string | null;
  createdAt: number;
  exported: boolean;
}

export interface AnkiResult {
  added: number[];
  skipped: number;
}
