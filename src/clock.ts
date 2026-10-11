import type { Playback } from "./types";

// mpv reports the position a few times a second. Between reports the clock is
// extrapolated so cues switch on the right frame, not on the next report.

let last: Playback = { time: 0, paused: true, speed: 1, duration: 0 };
let at = performance.now();

export function update(p: Playback): void {
  last = p;
  at = performance.now();
}

/** Moves the local clock right away, before mpv confirms a seek. */
export function jump(time: number): void {
  last = { ...last, time };
  at = performance.now();
}

export function now(): number {
  if (last.paused) return last.time;
  return last.time + ((performance.now() - at) / 1000) * last.speed;
}

export function snapshot(): Readonly<Playback> {
  return last;
}
