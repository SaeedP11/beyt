/// <reference types="vite/client" />

// Opt-in dev wiring to a Beyt gateway (see `pnpm dev:gateway`, server/README.md).
interface ImportMetaEnv {
  readonly VITE_BEYT_GATEWAY?: string;
  readonly VITE_BEYT_TOKEN?: string;
  /** "id:Label,id2:Label 2" */
  readonly VITE_BEYT_SOURCES?: string;
}
