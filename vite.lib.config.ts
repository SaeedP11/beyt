import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Keeps the package small: fonts the page never needs are dropped.
 *  Vazirmatn already covers Latin, so the themes' Inter fonts (700 kB) go,
 *  and every browser that runs Beyt reads woff2, so the icon font ships in that format only. */
const trimFonts = {
  name: "beyt-trim-fonts",
  enforce: "pre" as const,
  transform(code: string, id: string) {
    if (/primereact\/resources\/themes\/.*\/theme\.css/.test(id)) {
      return code.replace(/@font-face\s*\{[^}]*Inter var[^}]*\}/g, "");
    }
    return null;
  },
  generateBundle: {
    order: "post" as const,
    handler(_: unknown, bundle: Record<string, { type: string; source?: string | Uint8Array }>) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset" || typeof file.source !== "string") continue;
        file.source = file.source
          .replace(/@font-face\{font-family:primeicons;[\s\S]*?font-weight:400;font-style:normal\}/, (face) => {
            const woff2 = /url\((data:font\/woff2;base64,[^)]+)\) ?format\("woff2"\)/.exec(face);
            return woff2
              ? `@font-face{font-family:primeicons;font-display:block;src:url(${woff2[1]}) format("woff2");font-weight:400;font-style:normal}`
              : face;
          })
          // The variable font is listed twice, for old and new syntax. One copy is enough.
          .replace(
            /(@font-face\{font-family:Vazirmatn;src:url\([^)]+\)) ?format\("woff2 supports variations"\),\s*url\([^)]+\) ?format\("woff2-variations"\)/,
            '$1 format("woff2")',
          );
      }
    },
  },
};

// `pnpm build:lib`: Beyt as an npm package for the browser (dist-lib/).
export default defineConfig({
  plugins: [trimFonts, react(), tailwindcss()],
  // Libraries are not given this by the host build, so dev-only checks (prop-types) would stay in.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    target: "es2022",
    outDir: "dist-lib",
    emptyOutDir: true,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 1000,
    lib: { entry: "src/lib.tsx", formats: ["es"], fileName: () => "beyt.js", cssFileName: "style" },
    rollupOptions: {
      // The host app supplies React. The Tauri modules are only used inside the desktop shell.
      external: [/^react($|\/)/, /^react-dom($|\/)/, /^@tauri-apps\//],
    },
  },
});
