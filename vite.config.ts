import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Node's, typed here rather than pulling in @types/node for one line.
declare const process: { env: Record<string, string | undefined> };

// Set by `cargo tauri android dev`: the phone loads the page over the
// network, so the dev server has to listen beyond localhost.
const host = process.env.TAURI_DEV_HOST;

// Tauri expects a fixed dev-server port and handles the screen itself.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    // Loaded from disk (or from inside the APK), so bundle size barely matters.
    chunkSizeWarningLimit: 2000,
  },
});
