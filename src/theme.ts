// Light and dark themes. The chosen theme sets `light` or `dark` on <html>,
// which swaps Beyt's colour variables (index.css), and loads the matching
// PrimeReact theme into the `primereact` layer.

import darkCss from "primereact/resources/themes/lara-dark-blue/theme.css?inline";
import lightCss from "primereact/resources/themes/lara-light-blue/theme.css?inline";

export type Theme = "light" | "dark";

/** Remembered in the browser too, so the first frame, before settings load
 *  from disk, already shows the right theme. */
const CACHE_KEY = "beyt-theme";
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const sheet = document.createElement("style");
document.head.append(sheet);

let choice: Theme | null = cached();
let shown: Theme | null = null;

function cached(): Theme | null {
  try {
    const v = localStorage.getItem(CACHE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function show(): void {
  const theme: Theme = choice ?? (systemDark.matches ? "dark" : "light");
  if (theme === shown) return;
  shown = theme;
  // The layer order again, in case this sheet comes before index.css's.
  sheet.textContent = `@layer theme, base, primereact, components, utilities;\n@layer primereact {\n${theme === "dark" ? darkCss : lightCss}\n}`;
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
}

/** Shows `theme`, or follows the system's when null. */
export function setTheme(theme: Theme | null): void {
  choice = theme;
  try {
    if (theme) localStorage.setItem(CACHE_KEY, theme);
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    // No storage: the theme still applies, a frame later on the next launch.
  }
  show();
}

systemDark.addEventListener("change", show);
show();
