import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm build:lib`: Beyt as an npm package for the browser (dist-lib/).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: "es2022",
    outDir: "dist-lib",
    emptyOutDir: true,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 4000,
    lib: { entry: "src/lib.tsx", formats: ["es"], fileName: () => "beyt.js", cssFileName: "style" },
    rollupOptions: {
      // The host app supplies React. The Tauri modules are only used inside the desktop shell.
      external: [/^react($|\/)/, /^react-dom($|\/)/, /^@tauri-apps\//],
    },
  },
});
