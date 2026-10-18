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

/** The picture's shape: the video's own, a forced width:height ratio,
 *  zoomed in to fill the screen (cropping), or stretched to it. */
export type Aspect = "original" | "16:9" | "4:3" | "fill" | "stretch";

/** Saved per series folder: track styles keyed by track key, the picture
 *  shape, and the audio track last chosen (matched by language and title). */
export interface SeriesSettings {
  tracks: Record<string, TrackStyle>;
  aspect?: Aspect;
  audio?: AudioChoice;
}

export interface AudioChoice {
  lang: string;
  detail: string;
}

/** An audio track of the open video (see src-tauri/src/audio.rs). */
export interface AudioTrack {
  /** The player's id, used to select it. */
  id: number;
  /** Two-letter code when known, else the raw tag, else "und". */
  lang: string;
  /** The track's title, or an audio file's name. */
  detail: string;
  codec: string | null;
  channels: number | null;
  default: boolean;
  selected: boolean;
  /** The player can decode it. */
  supported: boolean;
  /** The audio file it comes from, when it isn't part of the video. */
  file: string | null;
  /** A file the user added, so it can be removed again. */
  added: boolean;
}

export interface AudioUpdate {
  path: string;
  tracks: AudioTrack[];
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

/** A video's headers and name, for finding subtitles that fit it (see info.rs). */
export interface FileInfo {
  name: string;
  folder: string;
  size: number;
  container: string | null;
  duration: number | null;
  bitrate: number | null;
  titleTag: string | null;
  release: Release;
  /** OpenSubtitles "moviehash". */
  hash: string | null;
  video: VideoStream[];
  audio: AudioStream[];
  subtitles: SubtitleStream[];
}

export interface Release {
  title: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
  resolution: string | null;
  source: string | null;
  group: string | null;
}

export interface VideoStream {
  codec: string;
  profile: string | null;
  width: number;
  height: number;
  fps: number | null;
  bitDepth: number | null;
  hdr: boolean;
}

export interface AudioStream {
  lang: string;
  codec: string;
  channels: number | null;
  sampleRate: number | null;
  title: string | null;
  default: boolean;
}

export interface SubtitleStream {
  lang: string;
  codec: string;
  title: string | null;
  forced: boolean;
}

/** A subtitle file judged against the video's soundtrack (see sync.rs). */
export interface Candidate {
  path: string;
  name: string;
  lang: string;
  cues: number;
  /** 0–100. */
  score: number;
  /** Seconds; apply as the track's offset. */
  offset: number;
  /** Audio samples that agree on `offset`, out of `samples`. */
  agree: number;
  samples: number;
  verdict: "inSync" | "shifted" | "drifts" | "noMatch" | "unreadable";
  reasons: MatchReason[];
}

export type MatchReason =
  | { kind: "sameRelease"; group: string }
  | { kind: "otherEpisode"; subtitle: string; video: string }
  | { kind: "frameRate"; subtitle: number; video: number }
  | { kind: "endsAfter"; seconds: number }
  | { kind: "partial"; percent: number }
  | { kind: "error"; message: string };
