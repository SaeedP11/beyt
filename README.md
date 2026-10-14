# Beyt (بیت)

A Linux video player for language learning that shows two or more subtitle
tracks at once, usually Persian and English. A *beyt* is a Persian couplet: two
lines read as a pair.

Design doc: https://claude.ai/code/artifact/b8b79f1d-fec3-401d-ad8e-f2513ef35b14

## Install

Beyt is packaged as a Nix flake. Installing it puts `beyt` on your PATH and
adds a **Beyt** entry (with icon) to your app launcher, which also accepts
video files from "Open with".

```sh
cd ~/Projects/video-player
nix profile install .#beyt       # release build: takes a few minutes the first time
```

The first time you click a subtitle word, Beyt offers to download its offline
English ↔ Persian dictionary (Wiktionary, about 13 MB). You can also install or
update it from Settings → Learning.

Then start it from the launcher, or from a terminal:

```sh
beyt                             # opens the library
beyt movie.mkv                   # plays a file directly
```

**Update** after pulling or changing code: `nix profile upgrade beyt` rebuilds
from the repo and replaces the installed version.

**Uninstall:** `nix profile remove beyt`. Your library, vocabulary and settings
stay in `~/.local/share/app.beyt.player/` until you delete that folder.

**Try it without installing:** `nix run .` runs the release build once.

On NixOS you can also add it declaratively: add this repo as a flake input and
put `inputs.beyt.packages.${pkgs.system}.default` in
`environment.systemPackages` or Home Manager's `home.packages`.

The installed app and the development build share the same data folder, so
watch history, vocabulary, settings and the dictionary are the same in both.

## Develop

```sh
nix develop                      # Rust, libmpv, ffmpeg, WebKitGTK, Node, pnpm
pnpm install
./scripts/make-sample.sh         # sample videos + EN/FA subtitles
./scripts/build-dictionary.sh    # optional: the dictionary, without going through the app
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

## Android (in progress)

```sh
nix develop .#android            # Android SDK + NDK, JDK 17, Rust with Android targets
pnpm install
./scripts/build-android.sh       # release APK for arm64 phones
./scripts/build-android.sh --aab # App Bundle for Google Play
cargo tauri android dev          # run on a connected phone with live reload
```

The first run generates the Android Studio project in `src-tauri/gen/android`,
which is kept in git. The APK lands in
`src-tauri/gen/android/app/build/outputs/apk/universal/release/`; install it
with `adb install -r <apk>`.

Release builds are signed with the local debug key, which is fine for your
own phone. For Google Play, create a release key once (keep it and its
passwords safe: every later update must be signed with it) and describe it in
`src-tauri/gen/android/keystore.properties`, which git ignores:

```sh
keytool -genkey -v -keystore ~/beyt-release.jks -keyalg RSA -keysize 4096 -validity 10000 -alias beyt
```

```properties
storeFile=/home/you/beyt-release.jks
storePassword=...
keyAlias=beyt
keyPassword=...
```

Videos don't play on Android yet: `src-tauri/src/player_android.rs` stands in
for the desktop player until Android has a video surface of its own.

## Layout

- `src-tauri/src/lib.rs`: the app and its commands; `main.rs` starts it on the desktop
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

## License

GPL-3.0-or-later; see [LICENSE](LICENSE). Changes are listed in
[CHANGELOG.md](CHANGELOG.md).
