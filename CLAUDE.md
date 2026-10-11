# Beyt: rules for working on this project

Beyt (بیت) is a Linux video player for language learning that shows two or more
subtitle tracks at once (usually Persian and English).
Design doc: https://claude.ai/code/artifact/b8b79f1d-fec3-401d-ad8e-f2513ef35b14

## Role

Act as an expert UI and UX designer as well as an engineer. Every screen should
look polished and feel effortless: clear hierarchy, consistent spacing, sensible
defaults, keyboard-first controls for playback, and good empty, loading and
error states. Design for both English (LTR) and Persian (RTL) from the start.

## Frontend stack

- **React** with TypeScript for all UI.
- **PrimeReact** for components (dialogs, sidebars, dropdowns, sliders, toasts, etc.).
  Stay on **10.x** (MIT): PrimeReact 11+ is commercial, key-locked and
  closed-source, which is incompatible with Beyt's GPL license.
- **Tailwind CSS** for layout and styling.
- Use logical properties / Tailwind's `ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`
  utilities so layouts mirror correctly in RTL.
- The subtitle overlay's per-frame work (clock, cue lookup, `TrackView`) stays
  in plain TypeScript outside React state, so playback never waits on re-renders.

## Product constraints

- No local AI on the user's machine (no whisper.cpp, no Ollama). AI features use
  cloud APIs only and stay off until the user adds their own key.
- Linux desktop first, tested on Wayland (niri) with an AMD integrated GPU.

## Commands

```sh
nix develop                                   # toolchain
npm install
./scripts/make-sample.sh                      # sample videos and subtitles
cargo tauri dev -- -- "$PWD/samples/sync-test.mkv"
cd src-tauri && cargo test && cargo clippy    # Rust checks
npx tsc --noEmit                              # TypeScript check
```
