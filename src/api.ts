// The one place the UI talks to its backend. On the desktop and Android that
// is the Rust core (backend/tauri.ts); in a browser, or inside another app that
// embeds Beyt as a package, it is backend/web.ts. Both have the same shape.

import { tauriApi, tauriEvents } from "./backend/tauri";
import { webApi, webEvents } from "./backend/web";

export type { AnkiConfig, Brightness } from "./backend/shared";

/** Running inside the Tauri shell (desktop or Android), not a plain browser. */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Android's file pickers return content:// links, not paths, so there the
 *  library browses the phone's storage itself. */
export const isAndroid = isTauri && navigator.userAgent.includes("Android");

export const api: typeof tauriApi = isTauri ? tauriApi : webApi;
export const events: typeof tauriEvents = isTauri ? tauriEvents : webEvents;
