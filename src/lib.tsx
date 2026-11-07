// Beyt as a package: `import { Beyt, mountBeyt } from "beyt"` plus `import "beyt/style.css"`.
// The whole app runs in the browser on the web backend (see backend/web.ts).

import "./index.css";
import "./theme";

import { PrimeReactProvider } from "primereact/api";
import { StrictMode, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import { App } from "./App";
import { connectServer, type BeytServer } from "./backend/remote";
import { mountSource, type FileSource } from "./backend/sources";
import { CrashScreen } from "./components/CrashScreen";
import { type Lang, defaultLang, setLang } from "./i18n";
import { type Theme, defaultTheme, setTheme } from "./theme";
import { VERSION } from "./version";

export interface BeytOptions {
  /** Remote folders to browse, e.g. an FTP server behind your gateway. See `httpFileSource`. */
  sources?: FileSource[];
  /** Where watch history, settings and saved words are kept. See `httpServer`. */
  server?: BeytServer;
  /** Called when the server can't be reached or a write fails. */
  onError?: (error: Error) => void;
  /** Virtual path or file path to play immediately when opened */
  initialFile?: string;
  /** Callback when the user closes or exits the player */
  onClose?: () => void;
  /** Heartbeat progress callback (seconds, duration) */
  onProgress?: (pos: number, dur: number) => void;
  /** Theme to apply ("dark" | "light" | "auto"). If omitted or "auto", follows host application theme. */
  theme?: Theme | "auto";
  /** Locale / language to apply ("fa" | "en" | "auto"). If omitted or "auto", follows host application locale. */
  locale?: Lang | "auto";
  /** Alias for locale */
  lang?: Lang | "auto";
}

/** Mounts the sources and connects the server. Safe to call more than once. */
function setup({ sources = [], server, onError }: BeytOptions): Promise<void> {
  for (const source of sources) mountSource(source);
  return server ? connectServer(server, onError) : Promise.resolve();
}

/** The player and library as a React component. Give it a parent with a size;
 *  it fills it. */
export function Beyt(options: BeytOptions = {}) {
  const [ready, setReady] = useState(!options.server);

  const effectiveTheme = options.theme && options.theme !== "auto" ? options.theme : undefined;
  const effectiveLocale =
    (options.locale && options.locale !== "auto" ? options.locale : undefined) ??
    (options.lang && options.lang !== "auto" ? options.lang : undefined);

  useEffect(() => {
    // Save host application's initial language, direction, and theme classes
    const initialLang = document.documentElement.lang;
    const initialDir = document.documentElement.dir;
    const initialDark = document.documentElement.classList.contains("dark");
    const initialLight = document.documentElement.classList.contains("light");

    if (effectiveTheme) {
      setTheme(effectiveTheme, false);
    } else {
      setTheme(defaultTheme(), false);
    }

    if (effectiveLocale) {
      setLang(effectiveLocale);
    } else {
      setLang(defaultLang());
    }

    return () => {
      // Restore host application theme and locale upon unmount
      if (initialLang) document.documentElement.lang = initialLang;
      if (initialDir) document.documentElement.dir = initialDir;
      document.documentElement.classList.toggle("dark", initialDark);
      document.documentElement.classList.toggle("light", initialLight);
    };
  }, [effectiveTheme, effectiveLocale]);

  useEffect(() => {
    let alive = true;
    void setup(options).then(
      () => alive && setReady(true),
      (e: unknown) => {
        options.onError?.(e instanceof Error ? e : new Error(String(e)));
        if (alive) setReady(true);
      },
    );
    return () => {
      alive = false;
    };
    // The options are read once: sources and server are fixed for the page's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) return null;
  return (
    <StrictMode>
      <PrimeReactProvider value={{ ripple: true }}>
        <CrashScreen>
          <App
            initialFile={options.initialFile}
            onClose={options.onClose}
            onProgress={options.onProgress}
            theme={effectiveTheme}
            locale={effectiveLocale}
          />
        </CrashScreen>
      </PrimeReactProvider>
    </StrictMode>
  );
}

/** Renders Beyt into `element` without needing React in the host app.
 *  Returns a function that removes it again. */
export function mountBeyt(element: HTMLElement, options: BeytOptions = {}): () => void {
  const root: Root = createRoot(element);
  root.render(<Beyt {...options} />);
  return () => root.unmount();
}

export { VERSION };
export type { Theme } from "./theme";
export type { Lang } from "./i18n";
export { httpFileSource, mountSource, unmountSource } from "./backend/sources";
export type { FileSource, HttpFileSourceOptions, RemoteEntry } from "./backend/sources";
export { httpServer } from "./backend/remote";
export type { BeytServer, BeytState, HttpServerOptions } from "./backend/remote";
export type { Watch as BeytWatch } from "./backend/store";
