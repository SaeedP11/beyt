# Beyt (بیت)

A Linux video player for language learning that shows two or more subtitle
tracks at once, usually Persian and English. A *beyt* is a Persian couplet: two
lines read as a pair.

Design doc: https://claude.ai/code/artifact/b8b79f1d-fec3-401d-ad8e-f2513ef35b14

## Run

```sh
nix develop                      # Rust, libmpv, ffmpeg, WebKitGTK, Node
npm install
./scripts/make-sample.sh         # sample videos + EN/FA subtitles
./scripts/build-dictionary.sh    # offline EN↔FA dictionary (Wiktionary, CC BY-SA)
cargo tauri dev -- -- "$PWD/samples/sync-test.mkv"
```

Subtitle files next to the video that start with its name (`Movie.fa.srt`,
`Movie.en.srt`) load on their own; more can be passed after the video path.

Every key can be changed in Settings → Keyboard shortcuts; press `?` in the app for the full list.

| Key | Action |
| --- | --- |
| Space | Pause / play |
| ← / → | Seek (step set in Settings) |
| ↑ / ↓ , M | Volume, mute |
| - / = , 0 | Slower, faster, normal speed |
| A / D | Previous / next subtitle line |
| S | Replay current line |
| Tab | Select next track |
| Click a word | Dictionary popup (pauses); Save word adds it to Vocabulary |
| W | Save the current line to Vocabulary |
| P | Auto-pause after each line |
| R | Transcript (both languages, click to jump) |
| L | Subtitles panel |
| [ / ] | Selected track offset −/+ 100 ms |
| B | Selected track: show / blur / hide |
| T | Selected track: top / bottom |
| F, double-click | Fullscreen |
| I | Info panel |
| Esc | Back to the library |
| ? or F1 | All keyboard shortcuts |
| , | Settings |
| Ctrl+Q | Quit |

## Layout

- `src-tauri/src/player.rs`: mpv, and its OpenGL video surface under the webview
- `src-tauri/src/subs.rs`: sidecar discovery, encoding detection, SRT/VTT parsing, Persian fixes
- `src/`: the TypeScript overlay (clock, cue lookup, track rendering, keys)

## How the video and overlay fit together

mpv renders through its OpenGL render API into a `GtkGLArea`. The area sits under
Tauri's WebKitGTK webview in a `GtkOverlay`, and the webview's transparent page
draws the subtitles. Everything stays in one window, so it works on Wayland
compositors (tested on niri) without positioning a separate overlay window.

## Spike results (milestone 0, 2026-10-11)

- Video under a transparent webview works on niri (Wayland), AMD Raven Ridge.
- Hardware decoding is active (`vaapi-copy`), rendering at the video's 30 fps.
- Subtitles switch within about one frame of the burned-in clock in the
  sync-test video (checked with screenshots 0.43 s apart).
- A Windows-1256 Persian file decodes correctly; Arabic letter forms and flipped
  punctuation are fixed.
- Debug build uses about 45% of one core. Follow-up: pass the Wayland display
  to mpv for zero-copy `vaapi` instead of `vaapi-copy`, and measure a release build.
