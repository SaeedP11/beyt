// Light and dark themes. The chosen theme sets `light` or `dark` on <html>,
// which swaps Beyt's colour variables (index.css), and loads the matching
// PrimeReact theme into the `primereact` layer.

/** Each theme is its own chunk, fetched only when shown. */
const themeCss = {
  dark: () => import("primereact/resources/themes/lara-dark-blue/theme.css?inline"),
  light: () => import("primereact/resources/themes/lara-light-blue/theme.css?inline"),
};

export type Theme = "light" | "dark";

/** Remembered in the browser too, so the first frame, before settings load
 *  from disk, already shows the right theme. */
const CACHE_KEY = "beyt-theme";
const systemDark = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const sheet = typeof document !== "undefined" ? document.createElement("style") : null;
if (sheet && typeof document !== "undefined") {
  document.head.append(sheet);
}

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

/** Detects host application theme, falling back to system preference. */
export function defaultTheme(): Theme {
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    if (root.classList.contains("dark") || root.getAttribute("data-theme") === "dark") {
      return "dark";
    }
    if (root.classList.contains("light") || root.getAttribute("data-theme") === "light") {
      return "light";
    }
    try {
      const colorScheme = window.getComputedStyle(root).colorScheme;
      if (colorScheme === "dark") return "dark";
      if (colorScheme === "light") return "light";
    } catch {
      // getComputedStyle might fail in some environments
    }
  }
  return systemDark?.matches ? "dark" : "light";
}

function show(): void {
  const theme: Theme = choice ?? defaultTheme();
  if (theme === shown) return;
  shown = theme;
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
  if (sheet) {
    void themeCss[theme]().then(({ default: css }) => {
      if (shown !== theme) return; // Switched again while this one loaded.
      // The layer order again, in case this sheet comes before index.css's.
      sheet.textContent = `@layer theme, base, primereact, components, utilities;\n@layer primereact {\n${css}\n}`;
    });
  }
}

/** Shows `theme`, or follows the application / system when null. */
export function setTheme(theme: Theme | null, persist = true): void {
  choice = theme;
  if (persist) {
    try {
      if (theme) localStorage.setItem(CACHE_KEY, theme);
      else localStorage.removeItem(CACHE_KEY);
    } catch {
      // No storage: the theme still applies, a frame later on the next launch.
    }
  }
  show();
}

export function getTheme(): Theme {
  return shown ?? choice ?? defaultTheme();
}

if (systemDark) {
  systemDark.addEventListener("change", () => {
    if (choice === null) show();
  });
}

// Observe host application theme changes on <html> if choice is null
if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
  const observer = new MutationObserver(() => {
    if (choice === null) {
      const detected = defaultTheme();
      if (detected !== shown) {
        show();
      }
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "style"],
  });
}

show();
