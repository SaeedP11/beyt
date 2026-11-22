// Light and dark themes. The chosen theme sets `light` or `dark` on <html>,
// which swaps Beyt's colour variables (index.css), and loads the matching
// PrimeReact theme into the `primereact` layer.

export type Theme = "light" | "dark";
export type ThemeColor = "blue" | "green" | "amber" | "cyan" | "indigo" | "pink" | "purple" | "teal";
export type BeytColor = ThemeColor | (string & {});

export const COLOR_PRESETS: Record<
  ThemeColor,
  {
    dark: { accent: string; wordAccent: string };
    light: { accent: string; wordAccent: string };
  }
> = {
  blue: {
    dark: { accent: "#60a5fa", wordAccent: "96 165 250" },
    light: { accent: "#2563eb", wordAccent: "37 99 235" },
  },
  green: {
    dark: { accent: "#34d399", wordAccent: "52 211 153" },
    light: { accent: "#10b981", wordAccent: "16 185 129" },
  },
  amber: {
    dark: { accent: "#fbbf24", wordAccent: "251 191 36" },
    light: { accent: "#d97706", wordAccent: "217 119 6" },
  },
  cyan: {
    dark: { accent: "#22d3ee", wordAccent: "34 211 238" },
    light: { accent: "#06b6d4", wordAccent: "6 182 212" },
  },
  indigo: {
    dark: { accent: "#818cf8", wordAccent: "129 140 248" },
    light: { accent: "#6366f1", wordAccent: "99 102 241" },
  },
  pink: {
    dark: { accent: "#f472b6", wordAccent: "244 114 182" },
    light: { accent: "#ec4899", wordAccent: "236 72 153" },
  },
  purple: {
    dark: { accent: "#a78bfa", wordAccent: "167 139 250" },
    light: { accent: "#8b5cf6", wordAccent: "139 92 246" },
  },
  teal: {
    dark: { accent: "#2dd4bf", wordAccent: "45 212 191" },
    light: { accent: "#14b8a6", wordAccent: "20 184 166" },
  },
};

export function isThemeColor(color: string): color is ThemeColor {
  return color in COLOR_PRESETS;
}

/** Parses hex color (#fff, #10b981) or rgb(...) string to an RGB triplet "r g b". */
export function colorToRgbTriplet(color: string): string | null {
  if (typeof color !== "string") return null;
  const hex = color.trim().replace(/^#/, "");
  if (hex.length === 3) {
    const h0 = hex[0];
    const h1 = hex[1];
    const h2 = hex[2];
    if (h0 && h1 && h2) {
      const r = parseInt(h0 + h0, 16);
      const g = parseInt(h1 + h1, 16);
      const b = parseInt(h2 + h2, 16);
      if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return `${r} ${g} ${b}`;
    }
  } else if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if (!isNaN(r) && !isNaN(g) && !isNaN(b)) return `${r} ${g} ${b}`;
  }
  const rgbMatch = /rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i.exec(color);
  if (rgbMatch && rgbMatch[1] && rgbMatch[2] && rgbMatch[3]) {
    return `${rgbMatch[1]} ${rgbMatch[2]} ${rgbMatch[3]}`;
  }
  return null;
}

/** Each theme is its own chunk, fetched only when shown. */
const themeCss: Record<Theme, Record<ThemeColor, () => Promise<{ default: string }>>> = {
  dark: {
    blue: () => import("primereact/resources/themes/lara-dark-blue/theme.css?inline"),
    green: () => import("primereact/resources/themes/lara-dark-green/theme.css?inline"),
    amber: () => import("primereact/resources/themes/lara-dark-amber/theme.css?inline"),
    cyan: () => import("primereact/resources/themes/lara-dark-cyan/theme.css?inline"),
    indigo: () => import("primereact/resources/themes/lara-dark-indigo/theme.css?inline"),
    pink: () => import("primereact/resources/themes/lara-dark-pink/theme.css?inline"),
    purple: () => import("primereact/resources/themes/lara-dark-purple/theme.css?inline"),
    teal: () => import("primereact/resources/themes/lara-dark-teal/theme.css?inline"),
  },
  light: {
    blue: () => import("primereact/resources/themes/lara-light-blue/theme.css?inline"),
    green: () => import("primereact/resources/themes/lara-light-green/theme.css?inline"),
    amber: () => import("primereact/resources/themes/lara-light-amber/theme.css?inline"),
    cyan: () => import("primereact/resources/themes/lara-light-cyan/theme.css?inline"),
    indigo: () => import("primereact/resources/themes/lara-light-indigo/theme.css?inline"),
    pink: () => import("primereact/resources/themes/lara-light-pink/theme.css?inline"),
    purple: () => import("primereact/resources/themes/lara-light-purple/theme.css?inline"),
    teal: () => import("primereact/resources/themes/lara-light-teal/theme.css?inline"),
  },
};

/** Remembered in the browser too, so the first frame, before settings load
 *  from disk, already shows the right theme. */
const CACHE_KEY = "beyt-theme";
const systemDark = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const sheet = typeof document !== "undefined" ? document.createElement("style") : null;
if (sheet && typeof document !== "undefined") {
  document.head.append(sheet);
}

let choice: Theme | null = cached();
let colorChoice: BeytColor | null = null;
let shown: Theme | null = null;
let shownColor: BeytColor | null = null;

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
  const rawColor: BeytColor = colorChoice ?? "blue";
  const preset: ThemeColor = isThemeColor(rawColor) ? rawColor : "blue";
  if (theme === shown && rawColor === shownColor) return;
  shown = theme;
  shownColor = rawColor;
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");

  const presetValues = COLOR_PRESETS[preset][theme];
  const accent = isThemeColor(rawColor) ? presetValues.accent : rawColor;
  const wordAccent = colorToRgbTriplet(accent) ?? presetValues.wordAccent;

  root.style.setProperty("--accent", accent);
  root.style.setProperty("--word-accent", wordAccent);
  root.style.setProperty("--primary-color", accent);

  if (sheet) {
    void themeCss[theme][preset]().then(({ default: css }) => {
      if (shown !== theme || shownColor !== rawColor) return; // Switched again while this one loaded.
      // The layer order again, in case this sheet comes before index.css's.
      sheet.textContent = `@layer theme, base, primereact, beyt, components, utilities;\n@layer primereact {\n${css}\n}`;
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

/** Sets active color palette or custom accent color. */
export function setColor(color: BeytColor | null): void {
  colorChoice = color;
  show();
}

/** Sets both theme and color at once. */
export function setThemeAndColor(theme: Theme | null, color: BeytColor | null, persist = true): void {
  choice = theme;
  colorChoice = color;
  if (persist) {
    try {
      if (theme) localStorage.setItem(CACHE_KEY, theme);
      else localStorage.removeItem(CACHE_KEY);
    } catch {
      // No storage
    }
  }
  show();
}

export function getTheme(): Theme {
  return shown ?? choice ?? defaultTheme();
}

export function getColor(): BeytColor {
  return shownColor ?? colorChoice ?? "blue";
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
