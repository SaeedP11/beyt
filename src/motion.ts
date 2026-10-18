// Open and close animation for PrimeReact dialogs and side panels.
//
// WebKitGTK 2.54's compositor gets the frame wrong where a CSS transition or
// animation ends (fixed upstream in WebKit 320494@main): it briefly shows the
// page without the overlay right after it opens, or the whole overlay right
// after it closes. So overlays animate from JavaScript instead, setting
// opacity and transform once a frame. The CSS side is in index.css.

import type { CSSTransitionProps } from "primereact/csstransition";

import { type Edge, dialogSheetProps, sheetEdge, useSheetEdge } from "./sheet";

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

/** Popups that pick a value and become sheets on small screens; ConfirmPopup has its own (see Confirm.tsx). */
const PANELS = ".p-dropdown-panel, .p-multiselect-panel, .p-colorpicker-panel";

/** The dim behind each panel sheet. */
const scrims = new WeakMap<HTMLElement, HTMLElement>();

/**
 * Makes a value panel that's opening a sheet from `edge` (index.css places
 * it) over a dim. A tap on the dim is a click outside the panel, so the panel
 * closes as usual and the tap doesn't reach whatever is under it. Escape
 * (and so Android's Back button) closes it the same way.
 */
function panelSheet(el: HTMLElement, edge: Edge) {
  el.classList.add("beyt-panel-sheet", `beyt-panel-sheet-${edge}`);
  const scrim = document.createElement("div");
  scrim.className = "beyt-scrim";
  scrim.style.zIndex = String((parseInt(el.style.zIndex) || 1100) - 1);
  scrim.style.opacity = "0";
  el.before(scrim);
  scrims.set(el, scrim);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopImmediatePropagation();
    scrim.click();
  };
  document.addEventListener("keydown", onKey, true);
  // Gone with the panel, however it went (a closing dialog can take it along).
  const gone = new MutationObserver(() => {
    if (el.isConnected) return;
    scrim.remove();
    document.removeEventListener("keydown", onKey, true);
    gone.disconnect();
  });
  gone.observe(el.parentElement ?? document.body, { childList: true });
}

/** Where a panel sheet sits, or null for a popup by its field. */
function panelEdge(el: HTMLElement): Edge | null {
  if (!el.classList.contains("beyt-panel-sheet")) return null;
  return (["bottom", "left", "right"] as const).find((e) => el.classList.contains(`beyt-panel-sheet-${e}`)) ?? null;
}

/** A value popup unfolds by its field, or as a sheet slides in from its edge as its dim fades in. */
const drawConnected: Draw = (el, shown, closing) => {
  const edge = panelEdge(el);
  if (!edge) return drawPopup(el, shown, closing);
  slide(el, edge, 1 - shown);
  const scrim = scrims.get(el);
  if (scrim) scrim.style.opacity = String(shown);
};

/** `transitionOptions` for Dropdown, MultiSelect, ColorPicker and ConfirmPopup. */
function connectedMotion(): CSSTransitionProps {
  const base = popupMotion("p-connected-overlay", drawConnected);
  const sheet = popupMotion("p-connected-overlay", drawConnected, 280, 200);
  return {
    ...base,
    onEnter: (node, appearing) => {
      const el = newest("p-connected-overlay-enter");
      const edge = sheetEdge();
      if (el && edge && el.matches(PANELS)) panelSheet(el, edge);
      base.onEnter?.(node, appearing);
    },
    // Sheets travel further, so they take longer.
    onEntering: (node, appearing) => {
      const el = newest("p-connected-overlay-enter");
      (el && panelEdge(el) ? sheet : base).onEntering?.(node, appearing);
    },
    onExiting: (node) => {
      const el = newest("p-connected-overlay-exit-active");
      (el && panelEdge(el) ? sheet : base).onExiting?.(node);
    },
    timeout: sheet.timeout,
  } as CSSTransitionProps;
}

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
  /** Dropdown, MultiSelect, ColorPicker and ConfirmPopup; the first three are sheets on small screens. */
  connected: connectedMotion(),
  overlayPanel: popupMotion("p-overlaypanel"),
  contextMenu: popupMotion("p-contextmenu"),
  toast: popupMotion("p-toast-message", drawToast, 250, 200),
};

/** The window edge a sheet slides from. */
export type SheetEdge = Edge;

/** How far `sheet` is pushed off its edge, from 0 (fully out) to 1 (hidden). */
export function sheetOffset(sheet: HTMLElement, edge: SheetEdge): number {
  const m = new DOMMatrixReadOnly(getComputedStyle(sheet).transform);
  const size = edge === "bottom" ? sheet.offsetHeight : sheet.offsetWidth;
  const moved = edge === "bottom" ? m.m42 : edge === "right" ? m.m41 : -m.m41;
  return size ? Math.min(1, Math.max(0, moved / size)) : 1;
}

/** Puts `sheet` at `offset` (see `sheetOffset`) and dims `scrim` to match. */
export function placeSheet(sheet: HTMLElement, scrim: HTMLElement | null, edge: SheetEdge, offset: number): void {
  const axis = edge === "bottom" ? "Y" : "X";
  const sign = edge === "left" ? -1 : 1;
  sheet.style.transform = offset === 0 ? "" : `translate${axis}(${sign * offset * 100}%)`;
  if (scrim) scrim.style.opacity = String(1 - offset);
}

/** Slides a sheet out from its window edge (`show`) or back into it, from
    wherever it is now, so a sheet let go mid-drag carries on from the finger. */
export function slideSheet(sheet: HTMLElement, scrim: HTMLElement | null, edge: SheetEdge, show: boolean): void {
  const from = sheetOffset(sheet, edge);
  const to = show ? 0 : 1;
  const ms = (show ? 280 : 200) * Math.max(0.4, Math.abs(to - from));
  animate(
    sheet,
    (el, shown, closing) => placeSheet(el, scrim, edge, from + (to - from) * (closing ? 1 - shown : shown)),
    !show,
    ms,
  );
}

/** Fades `el` in or out over `ms`, from wherever its opacity is now. */
export function fade(el: HTMLElement, show: boolean, ms: number): void {
  const from = parseFloat(el.style.opacity || "1");
  const to = show ? 1 : 0;
  animate(el, (e, shown) => (e.style.opacity = String(from + (to - from) * (show ? shown : 1 - shown))), !show, ms);
}

/** Slides a page in sideways as it fades in: from the end side when `forward`. */
export function slideIn(el: HTMLElement, forward: boolean, ms = 260): void {
  const rtl = getComputedStyle(el).direction === "rtl";
  const from = (forward !== rtl ? 1 : -1) * 28;
  animate(
    el,
    (e, shown) => {
      e.style.opacity = String(shown);
      e.style.transform = shown >= 1 ? "" : `translateX(${from * (1 - shown)}px)`;
    },
    false,
    ms,
  );
}

/** The way back from `slideIn`: slides `el` out towards the end side as it fades. */
export function slideOut(el: HTMLElement, ms = 200): void {
  const to = (getComputedStyle(el).direction === "rtl" ? -1 : 1) * 28;
  animate(
    el,
    (e, shown) => {
      e.style.opacity = String(shown);
      e.style.transform = `translateX(${to * (1 - shown)}px)`;
    },
    true,
    ms,
  );
}

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
