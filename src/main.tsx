import "./index.css";

import { PrimeReactProvider } from "primereact/api";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { CrashScreen, logError } from "./components/CrashScreen";

window.addEventListener("error", (e) => logError(e.error ?? e.message, "error"));
window.addEventListener("unhandledrejection", (e) => logError(e.reason, "unhandled rejection"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PrimeReactProvider value={{ ripple: true }}>
      <CrashScreen>
        <App />
      </CrashScreen>
    </PrimeReactProvider>
  </StrictMode>,
);
