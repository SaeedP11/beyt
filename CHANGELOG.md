# Changelog

Beyt follows [semantic versioning](https://semver.org). Until 1.0.0, settings
and the data in `~/.local/share/app.beyt.player/` may change between versions.

## 0.4.3 (2026-10-13)

### Fixed

- Dialogs (Settings, Keyboard shortcuts, File details, Match subtitles), the
  Subtitles and Transcript side panels, popups (dropdowns, color pickers,
  confirmations, the word popup and the right-click menu) and toasts no
  longer flicker as they open and close. WebKitGTK 2.54 drew a stale frame
  where a CSS transition ended: the page without the overlay right after it
  opened, or the whole overlay right after it closed.

### Changed

- Dialogs now fade and rise in smoothly, and fade out together with the dim
  behind them. Side panels slide in and out, popups unfold and fade, and
  toasts rise in and fold away as the ones below move up, all on the same
  smooth timing. The motion is skipped when the system asks for reduced
  motion.

## 0.4.2 (2026-10-13)

### Fixed

- Clicking a subtitle word whose part of speech has no translation (an
  abbreviation, for example) no longer fails with an error.
- The word popup opens above the clicked word and stays inside the window.
  It used to open below the subtitle and grow off the bottom of the screen
  once the dictionary results loaded.
- The word popup now names every part of speech the offline dictionary uses
  (pronoun, preposition, interjection, suffix and so on) in English and
  Persian, not just nouns, verbs, adjectives and adverbs.

## 0.4.1 (2026-10-12)

### Fixed

- An error while drawing the interface no longer leaves a frozen window that
  ignores every key and click. Beyt shows what went wrong with a Reload
  button, and reloading reopens the video where it was.
- If WebKit's page process crashes or is killed, Beyt reloads the page instead
  of leaving the window blank.
- Pressing Escape to close a word's dictionary popup no longer also stops the
  video and goes back to the library.
- Playback commands (pause, seek, speed, volume, subtitle track) no longer run
  mpv on the thread that draws the video, which mpv warns can stall playback.

### Added

- When started from the desktop, Beyt writes errors to
  `~/.local/share/app.beyt.player/beyt.log` (the previous run's log is kept as
  `beyt.log.old`), including errors from the interface.

## 0.4.0 (2026-10-12)

### Added

- A right-click menu of Beyt's own replaces the webview's browser menu (Back,
  Reload, Inspect Element). On the video it offers play or pause, replay line,
  auto-pause, a speed submenu, the panels, fullscreen, shortcuts, settings and
  back to the library, each with its keyboard shortcut. Right-click a subtitle
  line to play it from the start, copy it or save it to your vocabulary, and
  a word to look it up. In the library it offers shortcuts, settings,
  fullscreen and quit.
- Text fields keep the usual cut, copy and paste menu. In development builds,
  Shift+right-click still opens the webview's menu for Inspect Element.

## 0.3.0 (2026-10-12)

### Added

- File details (I, or the info button) replaces the old info overlay: video
  codec, profile, resolution, frame rate, bit depth and HDR; every audio
  track; embedded subtitles; and the release name, exact duration, size and
  OpenSubtitles hash for finding subtitles by hand
- "Find the best match" in the Subtitles panel ranks several subtitle files
  against the video's audio, reporting each as in sync, fitting with an
  offset (applied when used), drifting from a different frame rate, or not
  matching; results are cached

### Fixed

- Keys pressed inside a dialog no longer reach the player, so Escape closes
  a dialog without also leaving the video

## 0.2.0 (2026-10-11)

First tagged release: milestones 0–2 of the design doc.

### Playback and subtitles

- mpv video under a transparent Tauri webview in one window, working on
  Wayland (tested on niri) with VA-API hardware decoding
- Two or more subtitle tracks at once: sidecar files found by name, embedded
  text tracks extracted in the background and cached, picture-based tracks
  (PGS, VobSub) drawn by mpv
- Encoding detection (Windows-1256 Persian files), Persian letter forms and
  flipped punctuation fixed
- Per-track position, display mode (show, blur, hide), size, color,
  background box and timing offset, saved per series
- Subtitle files added by hand are remembered per video and can be removed

### Library

- Continue-watching cards, folder browser with watched marks, resume
  position, and an "Up next" card for the next episode

### Learning

- Word popup with an offline English ↔ Persian dictionary built from
  Wiktionary (CC BY-SA), with base-form matching
- Line navigation, replay, auto-pause after each line, transcript drawer
- Vocabulary: save a word or a line with a screenshot and an audio clip
- Anki export through AnkiConnect, and CSV export with media

### App

- English and Persian interface with full right-to-left layout
- Settings dialog; every shortcut can be changed, and `?` lists them all
- Nix flake package with a desktop entry; licensed GPL-3.0-or-later

### Not yet

- `.apkg` export
- Milestone 3: OpenSubtitles download, automatic sync (alass), online
  translation and LLM explanations
- Milestone 4: AI-made subtitles through cloud APIs
- Testing on X11 and on other GPUs
