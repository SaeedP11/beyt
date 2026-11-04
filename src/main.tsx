import "./index.css";
import "./theme";

import { PrimeReactProvider } from "primereact/api";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { isAndroid, isTauri } from "./api";
import { App } from "./App";
import { CrashScreen, logError } from "./components/CrashScreen";

if (isAndroid) document.documentElement.classList.add("android");

window.addEventListener("error", (e) => logError(e.error ?? e.message, "error"));
window.addEventListener("unhandledrejection", (e) => logError(e.reason, "unhandled rejection"));

// Dev only: `pnpm dev:gateway` connects the page to a Beyt gateway. Without
// those variables this block is removed from the build.
if (import.meta.env.DEV && !isTauri && import.meta.env.VITE_BEYT_GATEWAY) {
  const [{ httpFileSource, mountSource }, { connectServer, httpServer }] = await Promise.all([
    import("./backend/sources"),
    import("./backend/remote"),
  ]);
  const base = import.meta.env.VITE_BEYT_GATEWAY;
  const token = import.meta.env.VITE_BEYT_TOKEN ?? "";
  const headers = () => ({ Authorization: `Bearer ${token}` });
  for (const entry of (import.meta.env.VITE_BEYT_SOURCES ?? "").split(",").filter(Boolean)) {
    const [id = "", ...label] = entry.split(":");
    mountSource(
      httpFileSource({
        id,
        label: label.join(":") || id,
        baseUrl: `${base}/sources/${id}`,
        headers,
        streamUrl: (_path, url) => `${url}&token=${encodeURIComponent(token)}`,
      }),
    );
  }
  await connectServer(httpServer({ baseUrl: base, headers, onError: (e) => console.warn("[beyt gateway]", e.message) }), (e) =>
    console.warn("[beyt gateway] could not load state:", e.message),
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PrimeReactProvider value={{ ripple: true }}>
      <CrashScreen>
        <App />
      </CrashScreen>
    </PrimeReactProvider>
  </StrictMode>,
);
