// Every keyboard action, its default keys, and the user's overrides.
// The key handler, the help dialog and the shortcut settings all read this.

export type Group = "playback" | "subtitles" | "learning" | "panels" | "app";

export const ACTIONS = [
  { id: "togglePause", group: "playback", keys: ["Space"] },
  { id: "seekBack", group: "playback", keys: ["ArrowLeft"] },
  { id: "seekForward", group: "playback", keys: ["ArrowRight"] },
  { id: "restart", group: "playback", keys: ["Home"] },
  { id: "volumeUp", group: "playback", keys: ["ArrowUp"] },
  { id: "volumeDown", group: "playback", keys: ["ArrowDown"] },
  { id: "mute", group: "playback", keys: ["m"] },
  { id: "speedDown", group: "playback", keys: ["-"] },
  { id: "speedUp", group: "playback", keys: ["="] },
  { id: "speedReset", group: "playback", keys: ["0"] },
  { id: "fullscreen", group: "playback", keys: ["f"] },

  { id: "prevLine", group: "subtitles", keys: ["a"] },
  { id: "nextLine", group: "subtitles", keys: ["d"] },
  { id: "replayLine", group: "subtitles", keys: ["s"] },
  { id: "nextTrack", group: "subtitles", keys: ["Tab"] },
  { id: "offsetMinus", group: "subtitles", keys: ["["] },
  { id: "offsetPlus", group: "subtitles", keys: ["]"] },
  { id: "cycleMode", group: "subtitles", keys: ["b"] },
  { id: "togglePosition", group: "subtitles", keys: ["t"] },

  { id: "autoPause", group: "learning", keys: ["p"] },
  { id: "saveLine", group: "learning", keys: ["w"] },

  { id: "subtitles", group: "panels", keys: ["l"] },
  { id: "transcript", group: "panels", keys: ["r"] },
  { id: "info", group: "panels", keys: ["i"] },
  { id: "help", group: "panels", keys: ["?", "F1"] },
  { id: "settings", group: "panels", keys: [","] },

  { id: "back", group: "app", keys: ["Escape"] },
  { id: "quit", group: "app", keys: ["Ctrl+q"] },
] as const satisfies readonly { id: string; group: Group; keys: readonly string[] }[];

export type Action = (typeof ACTIONS)[number]["id"];
export type Keymap = Partial<Record<Action, string[]>>;

export const GROUPS: Group[] = ["playback", "subtitles", "learning", "panels", "app"];

export const DEFAULT_KEYS = {} as Record<Action, readonly string[]>;
for (const a of ACTIONS) DEFAULT_KEYS[a.id] = a.keys;

/** A key event as a binding string: "Space", "a", "Ctrl+q", "Shift+Tab", "?". */
export function eventKey(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  let key = e.key === " " ? "Space" : e.key;
  const printable = key.length === 1;
  if (printable) key = key.toLowerCase();
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.metaKey) mods.push("Meta");
  // Shift is already part of printable characters ("?" vs "/").
  if (e.shiftKey && !printable) mods.push("Shift");
  return [...mods, key].join("+");
}

export function keysFor(action: Action, overrides: Keymap): readonly string[] {
  return overrides[action] ?? ACTIONS.find((a) => a.id === action)!.keys;
}

/** Binding string → action, with the user's overrides applied. */
export function bindingTable(overrides: Keymap): Map<string, Action> {
  const table = new Map<string, Action>();
  for (const a of ACTIONS) for (const key of keysFor(a.id, overrides)) table.set(key, a.id);
  return table;
}

const LABELS: Record<string, string> = {
  Space: "Space",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Escape: "Esc",
  Enter: "Enter",
  Backspace: "⌫",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

/** Keycap labels for a binding: "Ctrl+q" → ["Ctrl", "Q"]. */
export function keyParts(binding: string): string[] {
  // "+" itself can be a key: "Ctrl++".
  const parts = binding.endsWith("++") ? [...binding.slice(0, -2).split("+"), "+"] : binding.split("+");
  return parts.map((p) => LABELS[p] ?? (p.length === 1 ? p.toUpperCase() : p));
}
