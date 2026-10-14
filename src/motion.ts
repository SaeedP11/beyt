// Open and close animation for PrimeReact dialogs and side panels.
//
// WebKitGTK 2.54's compositor gets the frame wrong where a CSS transition or
// animation ends (fixed upstream in WebKit 320494@main): it briefly shows the
// page without the overlay right after it opens, or the whole overlay right
// after it closes. So overlays animate from JavaScript instead, setting
// opacity and transform once a frame. The CSS side is in index.css.

import type { CSSTransitionProps } from "primereact/csstransition";
import type { Dialog } from "primereact/dialog";
import type { Sidebar } from "primereact/sidebar";
import { type RefObject, useMemo, useRef } from "react";

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
    if (el) animate(el, draw, closing, closing ? exitMs : enterMs);
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

interface Overlay {
  getElement(): HTMLElement | null;
}

function useMotion<T extends Overlay>(draw: Draw, enterMs: number, exitMs: number) {
  const ref = useRef<T>(null);
  const transitionOptions = useMemo(
    () => motionOptions(() => ref.current?.getElement(), draw, enterMs, exitMs),
    [draw, enterMs, exitMs],
  );
  return { ref, transitionOptions };
}

/** A dialog fades and rises in, and fades out with a smaller drop. */
const drawDialog: Draw = (el, shown, closing) => {
  const lift = closing ? 6 : 12;
  const shrink = closing ? 0.02 : 0.04;
  el.style.opacity = String(shown);
  el.style.transform = shown === 1 ? "" : `translateY(${(1 - shown) * lift}px) scale(${1 - (1 - shown) * shrink})`;
};

/** A side panel slides in from its edge of the window. */
const drawPanel: Draw = (el, shown) => {
  const fromLeft = el.parentElement?.classList.contains("p-sidebar-left");
  el.style.transform = shown === 1 ? "" : `translateX(${(1 - shown) * (fromLeft ? -100 : 100)}%)`;
};

/** Spread into a `<Dialog>` to give it Beyt's open and close animation. */
export function useDialogMotion(): { ref: RefObject<Dialog | null>; transitionOptions: CSSTransitionProps } {
  return useMotion<Dialog>(drawDialog, 220, 150);
}

/** Spread into a `<Sidebar>` to give it Beyt's open and close animation. */
export function usePanelMotion(): { ref: RefObject<Sidebar | null>; transitionOptions: CSSTransitionProps } {
  return useMotion<Sidebar>(drawPanel, 280, 200);
}

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

/** Fades `el` in or out over `ms`, from wherever its opacity is now. */
export function fade(el: HTMLElement, show: boolean, ms: number): void {
  const from = parseFloat(el.style.opacity || "1");
  const to = show ? 1 : 0;
  animate(el, (e, shown) => (e.style.opacity = String(from + (to - from) * (show ? shown : 1 - shown))), !show, ms);
}
