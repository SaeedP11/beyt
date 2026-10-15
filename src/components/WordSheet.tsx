import { type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { placeSheet, type SheetEdge, sheetOffset, slideSheet } from "../motion";
import { t } from "../i18n";

const landscape = window.matchMedia("(orientation: landscape)");
const subscribe = (change: () => void) => {
  landscape.addEventListener("change", change);
  return () => landscape.removeEventListener("change", change);
};
const useLandscape = () => useSyncExternalStore(subscribe, () => landscape.matches);

/** A fling this fast (px/ms) towards the edge closes the sheet however far it went. */
const FLING = 0.5;
/** Dragged this far out of view, a let-go sheet closes rather than springs back. */
const CLOSE_AT = 0.3;
/** How long the sheet stays mounted after closing starts: the slide out, and a frame. */
const EXIT_MS = 250;

/**
 * The phone's home for a word's translation, in place of a popup over the
 * word: a sheet up from the bottom when the phone is upright, a drawer in
 * from the end side (right in English, left in Persian) when it's sideways,
 * where a bottom sheet would cover the subtitles. Drag it back towards its
 * edge, tap outside or press Back to close. Tapping another subtitle word
 * through the dim behind it looks that word up instead.
 */
export function WordSheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const sideways = useLandscape();
  const rtl = document.documentElement.dir === "rtl";
  const edge: SheetEdge = sideways ? (rtl ? "left" : "right") : "bottom";
  const sheet = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (sheet.current) slideSheet(sheet.current, scrim.current, edge, false);
    const timer = window.setTimeout(() => setMounted(false), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Slides in once mounted, from off its edge, or back from wherever it got
  // to if reopened while closing. Turning the phone while open swaps the
  // edge: the sheet just appears at the new one.
  const placedEdge = useRef<SheetEdge | null>(null);
  useLayoutEffect(() => {
    const el = sheet.current;
    if (!el || !open) return;
    const was = placedEdge.current;
    placedEdge.current = edge;
    if (was !== null && was !== edge) return placeSheet(el, scrim.current, edge, 0);
    if (was === null) placeSheet(el, scrim.current, edge, 1);
    slideSheet(el, scrim.current, edge, true);
  }, [mounted, open, edge]);
  useEffect(() => {
    if (!mounted) placedEdge.current = null;
  }, [mounted]);

  // Escape (and Android's Back, which App turns into Escape) closes it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  /** Dragging by the handle, or by whatever the content marks `data-sheet-drag`
      (its header), towards the edge. The rest scrolls as usual. */
  const drag = useRef<{ id: number; start: number; size: number; last: number; at: number; speed: number } | null>(null);
  const along = (e: React.PointerEvent) => (edge === "bottom" ? e.clientY : edge === "right" ? e.clientX : -e.clientX);
  const onDown = (e: React.PointerEvent) => {
    const el = sheet.current;
    const target = e.target as HTMLElement;
    if (!el || !open || drag.current || !target.closest("[data-sheet-drag]") || target.closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const size = edge === "bottom" ? el.offsetHeight : el.offsetWidth;
    // Grab it where it is, even mid-slide.
    const pos = along(e);
    drag.current = { id: e.pointerId, start: pos - sheetOffset(el, edge) * size, size, last: pos, at: e.timeStamp, speed: 0 };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !sheet.current) return;
    const pos = along(e);
    const dt = e.timeStamp - d.at;
    if (dt > 0) d.speed = (pos - d.last) / dt;
    d.last = pos;
    d.at = e.timeStamp;
    // Past the open position it only gives a little.
    const moved = pos - d.start;
    const offset = moved >= 0 ? moved / d.size : -Math.sqrt(-moved) / d.size;
    placeSheet(sheet.current, scrim.current, edge, Math.min(1, Math.max(0, offset)));
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !sheet.current) return;
    drag.current = null;
    if (d.speed > FLING || (d.speed > -FLING && sheetOffset(sheet.current, edge) > CLOSE_AT)) onClose();
    else slideSheet(sheet.current, scrim.current, edge, true);
  };

  /** A tap outside closes the sheet, unless it lands on a subtitle word:
      that word is looked up instead, so words can be read one after another. */
  const onScrimClick = (e: React.MouseEvent) => {
    const word = document
      .elementsFromPoint(e.clientX, e.clientY)
      .find((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains("word"));
    if (word) word.click();
    else onClose();
  };

  if (!mounted) return null;

  const placement = {
    bottom: "inset-x-0 bottom-0 max-h-[min(34rem,72dvh)] rounded-t-2xl border-t pb-[env(safe-area-inset-bottom)]",
    // Physical sides on purpose: the edge is already chosen by the language.
    right: "inset-y-0 right-0 w-[min(24rem,48vw)] rounded-l-2xl border-l pr-[env(safe-area-inset-right)]",
    left: "inset-y-0 left-0 w-[min(24rem,48vw)] rounded-r-2xl border-r pl-[env(safe-area-inset-left)]",
  }[edge];
  const side = edge !== "bottom";

  return createPortal(
    <div className="word-sheet fixed inset-0 z-[1000] text-zinc-100" inert={!open}>
      <div
        ref={scrim}
        className={`absolute inset-0 ${side ? "bg-black/20" : "bg-black/35"}`}
        style={{ opacity: 0 }}
        onClick={onScrimClick}
      />
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-label={t("wordDetails")}
        className={`absolute flex flex-col overflow-hidden border-ink-600 bg-ink-800/95 shadow-[0_0_40px_rgb(0_0_0/0.5)] backdrop-blur-md will-change-transform ${placement}`}
      >
        <div
          className={`flex shrink-0 touch-none ${side ? "absolute inset-y-0 start-0 z-10 w-5 items-center justify-center" : "justify-center pt-2.5 pb-1"}`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          data-sheet-drag
          aria-hidden
        >
          <span className={`rounded-full bg-zinc-500/70 ${side ? "h-10 w-1" : "h-1 w-10"}`} />
        </div>
        <div
          className={`flex min-h-0 flex-1 flex-col ${side ? "ps-2 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]" : ""}`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
