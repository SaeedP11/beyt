import { useEffect, useState, useSyncExternalStore } from "react";

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
