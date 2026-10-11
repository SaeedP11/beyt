import type { Cue } from "./types";

/** Index of the last cue starting at or before `t`, or -1. Cues must be sorted. */
export function cueIndexAt(cues: readonly Cue[], t: number): number {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.start <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Indexes of every cue showing at `t`, in start order. */
export function activeCues(cues: readonly Cue[], t: number): number[] {
  const last = cueIndexAt(cues, t);
  const out: number[] = [];
  // Overlapping cues are rare; a short look back is enough.
  for (let i = last; i >= 0 && i > last - 8; i--) {
    if (cues[i]!.end > t) out.unshift(i);
  }
  return out;
}

/**
 * The cue to seek to for "previous" (-1) or "next" (+1) from time `t`.
 * Inside a line, "previous" goes to the line before it; replaying the
 * current line is a separate action.
 */
export function neighbourCue(cues: readonly Cue[], t: number, delta: -1 | 1): number {
  if (!cues.length) return -1;
  // Small lead so a seek that landed exactly on a cue start counts as inside it.
  let i = cueIndexAt(cues, t + 0.05);
  if (delta > 0) i += 1;
  else if (i >= 0 && t < cues[i]!.end) i -= 1;
  return Math.min(Math.max(i, 0), cues.length - 1);
}
