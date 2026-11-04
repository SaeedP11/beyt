// Beyt as a package: `import { Beyt, mountBeyt } from "beyt"` plus `import "beyt/style.css"`.
// The whole app runs in the browser on the web backend (see backend/web.ts).

import "./index.css";
import "./theme";

import { PrimeReactProvider } from "primereact/api";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { App } from "./App";
import { CrashScreen } from "./components/CrashScreen";
import { VERSION } from "./version";

/** The player and library as a React component. Give it a parent with a size;
 *  it fills it. */
export function Beyt() {
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
export function mountBeyt(element: HTMLElement): () => void {
  const root: Root = createRoot(element);
  root.render(<Beyt />);
  return () => root.unmount();
}

export { VERSION };
