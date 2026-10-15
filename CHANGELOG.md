# Changelog

Beyt follows [semantic versioning](https://semver.org). Until 1.0.0, settings
and the data in `~/.local/share/app.beyt.player/` may change between versions.

## 0.14.3 (2026-10-15)

### Changed

- On Android, the Keyboard shortcuts button and menu items only appear
  while a physical keyboard is connected, over USB or Bluetooth. Plug one
  in and they show up straight away; unplug it and they go again.

## 0.14.2 (2026-10-15)

### Changed

- On Android, Beyt now runs full screen: the status bar and the navigation
  bar stay hidden, leaving the whole screen for your videos and subtitles.
  Swipe in from the top or bottom edge to show them for a moment.

## 0.14.1 (2026-10-15)

### Changed

- On Android, the library no longer shows the Open video and Open folder
  buttons at the top. Browse your phone's videos from the Library tab
  instead, which leaves more room for your videos.

## 0.14.0 (2026-10-15)

### Added

- On Android, the library's sections sit in a navigation bar at the bottom
  of the screen, within reach of your thumb. The active section is marked
  with a highlight that grows in as you tap it.

### Changed

- Continue watching has its own tab in the library, and it's the one that
  opens first. The Library tab holds the open folder, and opening a folder
  switches to it. Coming back from a video returns to the tab you left.
- The folder view is redesigned. A bar at the top shows where you are as a
  clickable path, with an Up button beside it. Subfolders are tiles
  you can scan at a glance, and the folders and videos each have a heading
  with how many there are.
- Switching tabs in the library slides the new tab in from the side you
  picked it from.

### Fixed

- The player's control bar fits narrow phone screens. Below tablet width
  its buttons are a little smaller, and the aspect ratio and fullscreen
  buttons move into the ⋯ menu.
- Dialogs, the word popup and menus fit short screens, such as a phone
  held sideways. Settings no longer scrolls inside a scrolling dialog,
  dialogs use less padding on small screens, and menus taller than the
  window scroll.

## 0.13.0 (2026-10-15)

### Added

- The picture's aspect ratio can be changed, on the desktop and on
  Android: the video's own shape, 16:9, 4:3, 1.85:1 or 2.35:1, Fill
  screen (zooms in until the black bars are gone, cropping the edges) or
  Stretch. Pick one from the new button in the control bar or the player's
  right-click menu, or press Z to step through them. The choice is
  remembered for the rest of the series.

### Changed

- On Android, the control bar no longer shows the fullscreen button: the
  player already fills the phone's screen.

### Fixed

- On Android, the file details dialog shows the video's streams, frame
  rate, duration and hash. It only showed an error, because it read them
  with ffprobe, which phones don't have; Android's own media library reads
  them now.

## 0.12.2 (2026-10-15)

### Fixed

- On Android, the library shows video thumbnails. They were made with
  ffmpeg, which phones don't have; Android's own decoders make them now.

## 0.12.1 (2026-10-15)

### Fixed

- On Android, brightness is the screen's brightness from 1 to 100%, like
  the phone's own slider, and starts from where the screen already is. It
  used the desktop's video-picture scale (50–115%) instead. Leaving Beyt
  hands brightness back to the phone.
- On Android, a long press on the video plays at 2× without also opening
  the player menu.
- On Android, the last frame of a video no longer shows around the library
  after leaving it.

## 0.12.0 (2026-10-15)

### Added

- Touch gestures while a video plays, the ones phone video players share:
  tap to show or hide the controls; double-tap the left or right third to
  seek back or forward by the seek step (keep tapping to go further) and
  the middle to pause; swipe up or down on the start half for brightness and
  on the end half for volume; drag sideways to scrub, with the time shown;
  press and hold to play at 2× until you let go. Swiping sideways on a
  subtitle line moves to the previous or next line. Mouse and keyboard work
  as before.

### Changed

- On a phone, the library lists videos as rows with a small thumbnail
  beside the name, so several fit on screen, and the open buttons sit side
  by side. On touch screens each video's ⋯ button always shows (it only
  appeared on hover, so renaming and moving to the Trash were out of
  reach), and the keyboard-shortcuts button is hidden.
- The page no longer zooms with a pinch.

## 0.11.2 (2026-10-15)

### Changed

- Beyt has its own icon: the بیت wordmark over two subtitle lines, on
  Android (with adaptive and themed versions) and on the desktop. The old
  desktop icon showed empty boxes, since it was drawn with a font that has
  no Persian letters. `scripts/make-icons.sh` renders all of them from
  `src-tauri/icons/design/`.

## 0.11.1 (2026-10-15)

### Fixed

- Android's Back button closed Beyt from anywhere, including right after
  coming back from the file-access screen. It now does what Esc does on the
  desktop: it closes a dialog or popup, or leaves a video for the library.
  In the library it puts Beyt in the background, still open.
- On Android, videos showed a black picture, and the top of the library ran
  under the status bar.

## 0.11.0 (2026-10-15)

### Added

- Videos play on Android. Beyt uses Android's own video player (Media3
  ExoPlayer, with hardware decoding) under the subtitles, so MKV, MP4 and
  WebM files play with both subtitle tracks on top. Pause, seeking, speed,
  volume, mute and resuming where you stopped work as on the desktop, and the
  screen stays on while a video plays. Brightness sets the screen's
  brightness for Beyt.
- On Android, **Open video** and **Open folder** browse the phone's storage
  in the library. The first time, Beyt asks for access to all files, which it
  needs to find the subtitle files next to a video.

### Not yet on Android

- Subtitles inside the video file, thumbnails, subtitle matching and the
  screenshot and audio clip of saved words: these use ffmpeg, which Android
  doesn't have. Subtitle files next to the video work.

## 0.10.0 (2026-10-15)

### Added

- Groundwork for an Android version. `nix develop .#android` provides the
  Android SDK, NDK, Java and Rust for Android, and
  `scripts/build-android.sh` builds a release APK (or an App Bundle with
  `--aab`). It builds for arm64 only, since every extra ABI adds another
  copy of the native library, and optimises the Rust code for size.
  Release builds shrink unused code and resources (about 13 MB) and are
  signed with the key in `gen/android/keystore.properties`, or with the
  local debug key when there is none, so they can be installed for testing.
- On Android the library, subtitles, dictionary and vocabulary work, but
  videos don't play yet: the desktop player draws mpv into GTK, and Android
  needs a video surface of its own. Moving to the Trash, showing a file in
  its folder and the ffmpeg-based features (embedded subtitles, thumbnails,
  subtitle matching, audio clips) aren't available there either.

### Changed

- The app is now built as a library (`beyt_lib`) with a small desktop
  launcher, as Android loads apps as shared libraries. GTK, WebKitGTK, mpv
  and D-Bus are only linked on Linux desktops.

## 0.9.0 (2026-10-15)

### Added

- Beyt fits any window size, from a narrow tiled window to fullscreen on a
  4K screen.
- Subtitles scale with the window, the way mpv scales them with the video.
  The sizes in settings are for a 1280×720 window. At 1080p fullscreen,
  subtitles are 1.5 times that size; in a small window they shrink, but
  never below 0.6 times.
- On narrow windows, File info, Shortcuts and Settings move from the
  control bar into a ⋯ menu.
- On narrow windows, the Settings sections become a scrolling row of tabs
  above the page.

### Changed

- On narrow windows the library, player bars, Up next card and File info
  use smaller margins. On very wide screens the library uses more of the
  width.
- The window can't be made smaller than 480×320.

## 0.8.0 (2026-10-15)

### Added

- Install the offline dictionary from inside Beyt. Clicking a subtitle word
  before it's installed shows an **Install dictionary** button in the word
  popup instead of an error; the popup shows the download's progress and
  looks the word up as soon as it's ready, with no restart. Settings →
  Learning has the same button, and **Update** to fetch the latest
  Wiktionary entries later. The download is about 13 MB, and the dictionary
  in use stays in place until the new one is complete.

### Fixed

- `scripts/build-dictionary.sh` failed inside `nix develop` with a glibc
  error from curl. The dev shell now has its own curl.

## 0.7.2 (2026-10-14)

### Fixed

- Clicking the timeline seeks on the first click. Before, a click was
  sometimes ignored after dragging the handle and letting go off the bar.
  The timeline now has a taller hit area, can be dragged from anywhere on it
  and shows the time under the pointer.

## 0.7.1 (2026-10-14)

### Changed

- The open folder's videos are cards with thumbnails, like Continue
  watching, instead of a list. Its subfolders and Up sit above them as a
  row of buttons.
- Popup and right-click menus use Beyt's own dark colours, with padding,
  rounded rows and a clear hover. Move to Trash is shown in red.

### Fixed

- The ⋯ menu on library videos lost its row padding and hover highlight.
- Persian file names under a card lined up on the wrong side in the English
  interface (and English names in the Persian one).

## 0.7.0 (2026-10-14)

### Added

- Thumbnails in the library. Continue watching cards show the frame where
  you stopped, and folder rows show a small one, both with a progress bar
  along the bottom edge. Thumbnails are made with ffmpeg in the background
  and cached.
- Actions on videos in the library, from the ⋯ button, a right-click or the
  keyboard: Rename (F2), Show in folder, Remove from Continue watching and
  Move to Trash (Delete). Folder rows also show rename and trash buttons on
  hover.
- Renaming edits the name in place and keeps the extension. Subtitle files
  with the same name (`Movie.fa.srt` for `Movie.mkv`) are renamed with it,
  and the watch position, added subtitles and saved words follow the new
  name. Beyt won't overwrite a file that already has the new name.
- Move to Trash asks first and can take the video's subtitle files along.
  Files go to the desktop's Trash, not deleted. Removing a video from
  Continue watching and moving it to the Trash both offer Undo for a few
  seconds.

## 0.6.0 (2026-10-14)

### Added

- Scroll over the right edge of the video to change the volume (the left
  edge in Persian), the way the opposite edge already sets the brightness.
  It shows the same level indicator as the volume keys.

### Changed

- The Transcript button, its right-click menu entry and its shortcut (R)
  only appear when a text subtitle is on. Turning off or removing the last
  one closes the transcript instead of leaving an empty drawer.

## 0.5.0 (2026-10-14)

### Added

- Screen brightness control. On laptops it sets the screen's backlight
  (through logind, so no root or extra setup is needed). On external
  monitors, which have no backlight Beyt can reach, it changes the
  picture's brightness instead, from 50% to 115%. Change it with
  Shift+↑ / Shift+↓ (rebindable), by scrolling over the left edge of the
  video (the right edge in Persian), or with the slider in Settings →
  Playback. The backlight stays where you leave it after Beyt closes.

### Changed

- Volume and mute no longer stack up toasts while a key is held. A small
  indicator under the title bar shows the level, updates in place, and
  fades out shortly after the last press. Brightness uses it too.

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
