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
import { VERSION } from "./version";

export interface BeytOptions {
  /** Remote folders to browse, e.g. an FTP server behind your gateway. See `httpFileSource`. */
  sources?: FileSource[];
  /** Where watch history, settings and saved words are kept. See `httpServer`. */
  server?: BeytServer;
  /** Called when the server can't be reached or a write fails. */
  onError?: (error: Error) => void;
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
          <App />
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
export { httpFileSource, mountSource, unmountSource } from "./backend/sources";
export type { FileSource, HttpFileSourceOptions, RemoteEntry } from "./backend/sources";
export { httpServer } from "./backend/remote";
export type { BeytServer, BeytState, HttpServerOptions } from "./backend/remote";
export type { Watch as BeytWatch } from "./backend/store";
