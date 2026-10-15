import { useEffect, useState, useSyncExternalStore } from "react";

import { api, events, isAndroid } from "./api";
import * as clock from "./clock";
import { getLang, subscribeLang } from "./i18n";
import { Player } from "./player";
import type { Playback } from "./types";

/** The one player for the app. Its per-frame work stays outside React. */
export const player = new Player();

/** Re-renders when tracks, styles or "up next" change. */
export function usePlayer(): Player {
  useSyncExternalStore(player.subscribe, () => player.version);
  return player;
}

/** Re-renders when the interface language changes. */
export function useLang(): string {
  return useSyncExternalStore(subscribeLang, getLang);
}

/** True while the CSS media query matches, e.g. `(max-width: 767px)`. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
  );
}

// Desktops always have a keyboard; Android reports one once it is plugged in.
let hardKeyboard = !isAndroid;
const keyboardListeners = new Set<() => void>();
function setHardKeyboard(attached: boolean): void {
  if (attached === hardKeyboard) return;
  hardKeyboard = attached;
  keyboardListeners.forEach((l) => l());
}
if (isAndroid) {
  // Listen first, so a change during the first read isn't lost.
  void events.hardKeyboard(setHardKeyboard).then(() => api.hardKeyboard().then(setHardKeyboard, () => {}));
}

/** True while a physical keyboard is attached, so keyboard shortcuts are worth showing. */
export function hasHardKeyboard(): boolean {
  return hardKeyboard;
}

/** `hasHardKeyboard`, re-rendering when a keyboard is plugged in or removed. */
export function useHardKeyboard(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      keyboardListeners.add(onChange);
      return () => keyboardListeners.delete(onChange);
    },
    hasHardKeyboard,
  );
}

/** Playback state for controls, sampled `hz` times a second (not every frame). */
export function usePlayback(hz = 4): Playback {
  const read = () => ({ ...clock.snapshot(), time: clock.now() });
  const [state, setState] = useState<Playback>(read);
  useEffect(() => {
    const id = window.setInterval(() => setState(read()), 1000 / hz);
    return () => clearInterval(id);
  }, [hz]);
  return state;
}
