// Open and close animation for PrimeReact dialogs and side panels.
//
// WebKitGTK 2.54's compositor gets the frame wrong where a CSS transition or
// animation ends (fixed upstream in WebKit 320494@main): it briefly shows the
// page without the overlay right after it opens, or the whole overlay right
// after it closes. So overlays animate from JavaScript instead, setting
// opacity and transform once a frame. The CSS side is in index.css.

import type { CSSTransitionProps } from "primereact/csstransition";

import { type Edge, dialogSheetProps, useSheetEdge } from "./sheet";

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Draws an overlay at `shown`, from 0 (hidden) to 1 (open). */
type Draw = (el: HTMLElement, shown: number, closing: boolean) => void;

const frames = new WeakMap<HTMLElement, number>();

/** Animates `el` open or closed over `ms`, one `draw` a frame. */
function animate(el: HTMLElement, draw: Draw, closing: boolean, ms: number): void {
  cancelAnimationFrame(frames.get(el) ?? 0);
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const start = performance.now();
  const step = (now: number) => {
    const t = reduce ? 1 : Math.min(1, (now - start) / ms);
    draw(el, closing ? 1 - easeInOut(t) : easeOut(t), closing);
    if (t < 1) frames.set(el, requestAnimationFrame(step));
  };
  step(start);
}

/** `transitionOptions` that animate the element `find` returns. */
function motionOptions(find: () => HTMLElement | null | undefined, draw: Draw, enterMs: number, exitMs: number) {
  const run = (closing: boolean) => {
    const el = find();
    if (!el) return;
    animate(el, draw, closing, closing ? exitMs : enterMs);
    if (!closing && sheetEdgeOf(el)) swipeToClose(el);
  };
  return {
    // A little longer than the exit, so its last frame shows before unmounting.
    timeout: { enter: enterMs, exit: exitMs + 50 },
    onEnter: () => {
      const el = find();
      if (el) draw(el, 0, false);
    },
    onEntering: () => run(false),
    onExiting: () => run(true),
  } as CSSTransitionProps;
}

/** The edge a sheet (see sheet.ts) sits on, read off its mask's classes; null if `el` isn't one. */
function sheetEdgeOf(el: HTMLElement): Edge | null {
  const mask = el.parentElement?.classList;
  if (!mask?.contains("beyt-sheet")) return null;
  return (["bottom", "left", "right"] as const).find((e) => mask.contains(`p-dialog-${e}`) || mask.contains(`p-sidebar-${e}`)) ?? null;
}

/** Moves a sheet `off` of the way out past its edge: 0 is in place, 1 fully off screen. */
function slide(el: HTMLElement, edge: Edge, off: number) {
  const pct = off * 100;
  el.style.transform =
    off === 0 ? "" : edge === "bottom" ? `translateY(${pct}%)` : `translateX(${edge === "left" ? -pct : pct}%)`;
}

/** How far a swipe had pulled a sheet out when it let go and closed it. */
const pulled = new WeakMap<HTMLElement, number>();

/** A sheet slides in from its edge. A modal one carries its dim (see index.css), so it also fades,
    in the first half of opening and the second half of closing. */
const drawSheet = (el: HTMLElement, edge: Edge, shown: number, closing: boolean) => {
  const from = closing ? (pulled.get(el) ?? 0) : 0;
  slide(el, edge, 1 - shown * (1 - from));
  if (el.parentElement?.classList.contains("p-component-overlay")) {
    el.style.opacity = shown === 1 ? "" : String(Math.min(1, shown * 2));
  }
};

/** Sheets already listening for swipes. */
const swipeable = new WeakSet<HTMLElement>();

/**
 * Dragging a sheet's header toward its edge pulls the sheet along; letting go
 * far enough out, or with a flick, closes it through its close button, so
 * the owner's `onHide` runs as usual.
 */
function swipeToClose(sheet: HTMLElement) {
  if (swipeable.has(sheet)) return;
  swipeable.add(sheet);
  let start: { x: number; y: number; time: number; edge: Edge } | null = null;
  let off = 0;

  const distance = (e: PointerEvent) => {
    if (!start) return 0;
    if (start.edge === "bottom") return e.clientY - start.y;
    return start.edge === "left" ? start.x - e.clientX : e.clientX - start.x;
  };
  const size = (edge: Edge) => (edge === "bottom" ? sheet.offsetHeight : sheet.offsetWidth) || 1;

  sheet.addEventListener("pointerdown", (e) => {
    const target = e.target as HTMLElement;
    const edge = sheetEdgeOf(sheet);
    // Only the header starts a swipe, so lists, sliders and text inside keep their own drags.
    if (!edge || e.button !== 0 || !target.closest(".p-dialog-header, .p-sidebar-header")) return;
    if (target.closest("button, a, input")) return;
    start = { x: e.clientX, y: e.clientY, time: e.timeStamp, edge };
    off = 0;
    sheet.setPointerCapture(e.pointerId);
  });
  sheet.addEventListener("pointermove", (e) => {
    if (!start) return;
    off = Math.min(1, Math.max(0, distance(e) / size(start.edge)));
    slide(sheet, start.edge, off);
  });
  const end = (e: PointerEvent) => {
    if (!start) return;
    const { edge, time } = start;
    const speed = distance(e) / Math.max(1, e.timeStamp - time); // px per ms
    start = null;
    if (off > 0.3 || (off > 0.05 && speed > 0.5)) {
      pulled.set(sheet, off);
      sheet.querySelector<HTMLElement>(".p-dialog-header-close, .p-sidebar-close")?.click();
      return;
    }
    const from = off;
    animate(sheet, (el, shown) => slide(el, edge, from * (1 - shown)), false, 180);
  };
  sheet.addEventListener("pointerup", end);
  sheet.addEventListener("pointercancel", end);
}

/** A dialog fades and rises in, and fades out with a smaller drop. As a sheet, it slides instead. */
const drawDialog: Draw = (el, shown, closing) => {
  const edge = sheetEdgeOf(el);
  if (edge) return drawSheet(el, edge, shown, closing);
  const lift = closing ? 6 : 12;
  const shrink = closing ? 0.02 : 0.04;
  el.style.opacity = String(shown);
  el.style.transform = shown === 1 ? "" : `translateY(${(1 - shown) * lift}px) scale(${1 - (1 - shown) * shrink})`;
};

/** A side panel slides in from its edge of the window. */
const drawPanel: Draw = (el, shown, closing) => {
  const edge = sheetEdgeOf(el);
  if (edge) return drawSheet(el, edge, shown, closing);
  const mask = el.parentElement?.classList;
  slide(el, mask?.contains("p-sidebar-bottom") ? "bottom" : mask?.contains("p-sidebar-left") ? "left" : "right", 1 - shown);
};

/** A popup unfolds from the side it opens on, and fades out. */
const drawPopup: Draw = (el, shown, closing) => {
  el.style.opacity = shown === 1 ? "" : String(shown);
  el.style.transform = shown === 1 || closing ? "" : `scaleY(${0.9 + 0.1 * shown})`;
};

/** The newest element with `className`: the popup PrimeReact just marked
    as entering or leaving. */
function newest(className: string): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(`.${className}`);
  return all[all.length - 1] ?? null;
}

/** `transitionOptions` for overlays whose transition classes start with `base`. */
function popupMotion(base: string, draw = drawPopup, enterMs = 150, exitMs = 100): CSSTransitionProps {
  const entering = motionOptions(() => newest(`${base}-enter`), draw, enterMs, exitMs);
  const leaving = motionOptions(() => newest(`${base}-exit-active`), draw, enterMs, exitMs);
  return { ...entering, onExiting: leaving.onExiting };
}

/** A toast's height and gap when it started closing. */
const toastSizes = new WeakMap<HTMLElement, { height: number; gap: number }>();

/** A toast rises in, and fades while the toasts below it move up. */
const drawToast: Draw = (el, shown, closing) => {
  el.style.opacity = shown === 1 ? "" : String(shown);
  if (!closing) {
    el.style.transform = shown === 1 ? "" : `translateY(${(1 - shown) * 50}%)`;
    return;
  }
  let size = toastSizes.get(el);
  if (!size) {
    // PrimeReact's exit class already zeroed max-height and the bottom
    // margin; scrollHeight ignores the first, and the toast below (if any)
    // still has the usual gap.
    const below = el.nextElementSibling;
    const gap = below ? parseFloat(getComputedStyle(below).marginBottom) || 0 : 0;
    size = { height: el.scrollHeight, gap };
    toastSizes.set(el, size);
  }
  el.style.overflow = "hidden";
  el.style.maxHeight = `${size.height * shown}px`;
  el.style.marginBottom = `${size.gap * shown}px`;
};

/** `transitionOptions` for Beyt's popups. PrimeReact adds the transition's
    class to the popup just before each callback, so one shared object can
    find the right element without a ref. */
export const popupMotions = {
  /** Dropdown, MultiSelect, ColorPicker and ConfirmPopup. */
  connected: popupMotion("p-connected-overlay"),
  overlayPanel: popupMotion("p-overlaypanel"),
  contextMenu: popupMotion("p-contextmenu"),
  toast: popupMotion("p-toast-message", drawToast, 250, 200),
};

// Dialogs and side panels are found by their transition classes too: a ref's
// handle isn't attached yet when PrimeReact starts the opening transition.
const dialogMotion = popupMotion("p-dialog", drawDialog, 220, 150);
const sheetMotion = popupMotion("p-dialog", drawDialog, 280, 200);
const panelMotion = popupMotion("p-sidebar", drawPanel, 280, 200);

/** Spread into a `<Dialog>` (or ConfirmDialog) to give it Beyt's open and
    close animation, and to make it a sheet on small screens (see sheet.ts). */
export function useDialogMotion() {
  const edge = useSheetEdge();
  return { transitionOptions: edge ? sheetMotion : dialogMotion, ...dialogSheetProps(edge) };
}

/** Spread into a `<Sidebar>` to give it Beyt's open and close animation. It
    sits on `side`; on small screens it becomes a sheet, from the bottom when
    the window is taller than wide (see sheet.ts). */
export function usePanelMotion(side: "left" | "right") {
  const edge = useSheetEdge();
  return {
    transitionOptions: panelMotion,
    position: edge === "bottom" ? ("bottom" as const) : side,
    maskClassName: edge ? "beyt-sheet" : undefined,
  };
}
