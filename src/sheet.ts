// On small screens (phones, or a very small window), dialogs and popups with
// actions open as sheets: up from the bottom edge when the window is taller
// than wide, and in from the end edge (right in English, left in Persian)
// when it's wider than tall. motion.ts animates them and index.css shapes them.

import { useSyncExternalStore } from "react";

import { getLang, subscribeLang } from "./i18n";

/** The window edge a sheet comes from. */
export type Edge = "bottom" | "left" | "right";

const SMALL = window.matchMedia("(max-width: 640px), (max-height: 500px)");
const LANDSCAPE = window.matchMedia("(orientation: landscape)");

function subscribe(fn: () => void): () => void {
  SMALL.addEventListener("change", fn);
  LANDSCAPE.addEventListener("change", fn);
  const unsubscribeLang = subscribeLang(fn);
  return () => {
    SMALL.removeEventListener("change", fn);
    LANDSCAPE.removeEventListener("change", fn);
    unsubscribeLang();
  };
}

/** Where sheets come from right now, or null when the screen has room for dialogs and popups. */
export function sheetEdge(): Edge | null {
  if (!SMALL.matches) return null;
  if (!LANDSCAPE.matches) return "bottom";
  return getLang() === "fa" ? "left" : "right";
}

/** `sheetEdge()`, re-rendering when the window turns or the language changes. */
export function useSheetEdge(): Edge | null {
  return useSyncExternalStore(subscribe, sheetEdge);
}

/** Props that make a `<Dialog>` a sheet from `edge`, or keep it centred. */
export function dialogSheetProps(edge: Edge | null) {
  return edge ? { position: edge, maskClassName: "beyt-sheet" } : { position: "center" as const, maskClassName: undefined };
}
