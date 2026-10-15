// Touch gestures on the video, the ones phone video players share: tap for
// the controls, double-tap a side to seek, swipe the sides for brightness and
// volume, drag across to scrub, hold to play fast. Only touch and pen input
// counts; the mouse keeps its own handling (wheel, clicks, keys).

export type Zone = "back" | "middle" | "forward";
export type Level = "brightness" | "volume";

export interface GestureHandlers {
  /** One tap, once it's clear no second tap follows. */
  tap(): void;
  /** The second and later taps of a quick series in one zone; `count` starts at 2. */
  multiTap(zone: Zone, count: number): void;
  /** A vertical swipe; `percent` is up-positive, a full swipe being about 140. */
  level(kind: Level, percent: number): void;
  /** A horizontal drag, in seconds from where it started. `end` seeks there. */
  scrub(phase: "move" | "end" | "cancel", seconds: number): void;
  /** A long press starts (true) and ends (false). */
  hold(active: boolean): void;
}

/** Distance a finger moves before a touch counts as a drag, in CSS pixels. */
const MOVE = 12;
/** Time for a second tap to make a double tap. */
const DOUBLE = 300;
/** Once seeking by taps, the next tap may come a little later. */
const CHAIN = 650;
/** Press time before holding plays fast. */
const HOLD = 450;
/** Seconds a drag across the whole width moves. */
const SCRUB_WIDTH = 90;

/** Listens on `el` for touches that start on `el` itself (the bare video,
 *  not the controls or subtitles above it). Returns a function that stops. */
export function attachGestures(el: HTMLElement, h: GestureHandlers, rtl: () => boolean): () => void {
  let touch: { id: number; x: number; y: number; lastY: number } | null = null;
  let mode: "pending" | "vertical" | "horizontal" | "hold" = "pending";
  let level: Level = "volume";
  let holdTimer = 0;
  let tapTimer = 0;
  let taps: { at: number; zone: Zone; count: number } | null = null;

  const zoneAt = (x: number): Zone => {
    const w = el.clientWidth;
    return x < w / 3 ? "back" : x > (w * 2) / 3 ? "forward" : "middle";
  };

  const onDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" || e.target !== el || touch) return;
    // No mouse events copied from the touch: they would wake the controls.
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    touch = { id: e.pointerId, x: e.clientX, y: e.clientY, lastY: e.clientY };
    mode = "pending";
    holdTimer = window.setTimeout(() => {
      if (mode !== "pending") return;
      mode = "hold";
      h.hold(true);
    }, HOLD);
  };

  const onMove = (e: PointerEvent) => {
    if (!touch || e.pointerId !== touch.id) return;
    const dx = e.clientX - touch.x;
    const dy = e.clientY - touch.y;
    if (mode === "pending") {
      if (Math.hypot(dx, dy) < MOVE) return;
      window.clearTimeout(holdTimer);
      if (Math.abs(dy) > Math.abs(dx)) {
        mode = "vertical";
        // Like the scroll-wheel edges: brightness at the start, volume at the end.
        const fromStart = rtl() ? el.clientWidth - touch.x : touch.x;
        level = fromStart < el.clientWidth / 2 ? "brightness" : "volume";
      } else {
        mode = "horizontal";
      }
    }
    if (mode === "vertical") {
      const percent = ((touch.lastY - e.clientY) / (el.clientHeight * 0.7)) * 100;
      touch.lastY = e.clientY;
      h.level(level, percent);
    } else if (mode === "horizontal") {
      h.scrub("move", (dx / el.clientWidth) * SCRUB_WIDTH);
    }
  };

  const tapped = (x: number) => {
    const zone = zoneAt(x);
    const now = performance.now();
    window.clearTimeout(tapTimer);
    if (taps && taps.zone === zone && now - taps.at < (taps.count > 1 ? CHAIN : DOUBLE)) {
      taps = { at: now, zone, count: taps.count + 1 };
      h.multiTap(zone, taps.count);
      tapTimer = window.setTimeout(() => (taps = null), CHAIN);
      return;
    }
    taps = { at: now, zone, count: 1 };
    tapTimer = window.setTimeout(() => {
      if (taps?.count === 1) h.tap();
      taps = null;
    }, DOUBLE);
  };

  const onUp = (e: PointerEvent) => {
    if (!touch || e.pointerId !== touch.id) return;
    window.clearTimeout(holdTimer);
    if (mode === "hold") h.hold(false);
    else if (mode === "horizontal") h.scrub("end", ((e.clientX - touch.x) / el.clientWidth) * SCRUB_WIDTH);
    else if (mode === "pending") tapped(touch.x);
    touch = null;
  };

  const onCancel = (e: PointerEvent) => {
    if (!touch || e.pointerId !== touch.id) return;
    window.clearTimeout(holdTimer);
    if (mode === "hold") h.hold(false);
    else if (mode === "horizontal") h.scrub("cancel", 0);
    touch = null;
  };

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onCancel);
  return () => {
    window.clearTimeout(holdTimer);
    window.clearTimeout(tapTimer);
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onCancel);
  };
}

/** A quick sideways swipe on a subtitle line: true when it should move to
 *  the next line, false for the previous, null when it wasn't a swipe. */
export function lineSwipe(
  start: { x: number; y: number; at: number },
  end: { x: number; y: number; at: number },
  rtl: boolean,
): boolean | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (end.at - start.at > 500 || Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 2) return null;
  // Like turning a page: towards the reading direction's start is forward.
  return rtl ? dx > 0 : dx < 0;
}
