
import { Button } from "primereact/button";
import { Toast, type ToastMessage } from "primereact/toast";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { api, events, isAndroid, isTauri } from "./api";
import { onBackButton } from "./platform";
import * as clock from "./clock";
import { AppContextMenu } from "./components/AppContextMenu";
import { ConfirmHost } from "./components/Confirm";
import { DefaultPlayerDialog } from "./components/DefaultPlayerDialog";
import { FileInfoDialog } from "./components/FileInfoDialog";
import { Library, type LibraryHandle } from "./components/Library";
import { VideoSurface } from "./components/VideoSurface";
import { PlayerChrome } from "./components/PlayerChrome";
import type { Section } from "./components/SettingsDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { SubtitlePanel } from "./components/SubtitlePanel";
import { Transcript } from "./components/Transcript";
import { UpNextCard } from "./components/UpNextCard";
import { LevelIndicator } from "./components/LevelIndicator";
import { WordPopup, type WordPopupHandle } from "./components/WordPopup";
import { attachGestures, type GestureHandlers, lineSwipe, type Zone } from "./gestures";
import { hasHardKeyboard, player, useLang } from "./hooks";
import { type Lang, getLang, t } from "./i18n";
import { type Action, bindingTable, eventKey, keyParts, keysFor } from "./keymap";
import { popupMotions } from "./motion";
import { clampMargin, getSettings, loadSettings, marginKey, updateSettings, useSettings } from "./settings";
import type { Theme } from "./theme";
import { fmtTime, setToastHandler, toast } from "./ui";

type Screen = "loading" | "library" | "player";

/** Feedback for a gesture: where it shows, and what it says. */
interface Hint {
  icon?: string;
  text: string;
  at: Zone;
}

/** Shown over the video while a gesture acts: on the side seeking by taps
 *  goes, else in the middle. Seeking sides are physical, like the timeline. */
function GestureHint({ hint }: { hint: Hint }) {
  const place =
    hint.at === "back" ? "left-[12%]" : hint.at === "forward" ? "right-[12%]" : "left-1/2 -translate-x-1/2";
  return (
    <div className={`pointer-events-none absolute top-1/2 z-30 -translate-y-1/2 ${place}`}>
      <div
        className="dark flex items-center gap-2 rounded-full bg-ink-950/70 px-4 py-2 text-lg font-semibold whitespace-pre text-white tabular-nums"
        dir="ltr"
      >
        {hint.icon && <i className={hint.icon} />}
        {hint.text}
      </div>
    </div>
  );
}

/** Actions that work on the library screen too. */
/** Distance a pointer moves on a subtitle line before it drags the stack, in CSS pixels. */
const SUB_DRAG = 6;

const GLOBAL_ACTIONS = new Set<Action>(["help", "settings", "fullscreen", "quit", "back"]);
/** Width of the strips at the edges where scrolling sets the brightness
 *  (start edge) and the volume (end edge). */
const EDGE = 0.2;
/** Wheel distance for one brightness step (about one mouse wheel notch). */
const WHEEL_STEP = 50;

/** Scales subtitles with the window, the way mpv scales them with the video:
 *  the sizes in settings are for 1280×720. The narrower side wins, so lines
 *  in a tall narrow window still fit across. */
function updateSubScale() {
  const scale = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
  const clamped = Math.min(Math.max(scale, 0.6), 3);
  document.documentElement.style.setProperty("--sub-scale", clamped.toFixed(3));
}

// Settings are rarely opened, so their code loads on first use.
const SettingsDialog = lazy(() => import("./components/SettingsDialog").then((m) => ({ default: m.SettingsDialog })));
const SettingsPage = lazy(() => import("./components/SettingsPage").then((m) => ({ default: m.SettingsPage })));

export function App({
  initialFile,
  onClose,
  onProgress,
  theme,
  locale,
}: {
  initialFile?: string;
  onClose?: () => void;
  onProgress?: (pos: number, dur: number) => void;
  theme?: Theme;
  locale?: Lang;
} = {}) {
  const lang = useLang();
  const { keymap } = useSettings();
  const [screen, setScreen] = useState<Screen>("loading");
  const [lastFolder, setLastFolder] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsSeen = useRef(false);
  if (settingsOpen) settingsSeen.current = true;
  // Null only on Android: its settings page then shows the list of sections.
  const [settingsSection, setSettingsSection] = useState<Section | null>(isAndroid ? null : "general");
  const [controls, setControls] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  /** While locked, every key, tap and click is ignored except unlocking. */
  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);
  lockedRef.current = locked;
  const toastRef = useRef<Toast>(null);
  const wordPopup = useRef<WordPopupHandle>(null);
  const libraryRef = useRef<LibraryHandle>(null);
  const idleTimer = useRef<number | undefined>(undefined);

  const openedViaOpenWith = useRef(false);
  const countedThisSession = useRef(false);
  const [defaultPromptOpen, setDefaultPromptOpen] = useState(false);
  const [defaultSettingLoading, setDefaultSettingLoading] = useState(false);

  const handleSkipDefault = useCallback(async () => {
    setDefaultPromptOpen(false);
    try {
      await api.setAppSetting("defaultPlayerPromptDismissed", true);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const handleSetDefault = useCallback(async () => {
    setDefaultSettingLoading(true);
    try {
      await api.setDefaultPlayer();
      await api.setAppSetting("defaultPlayerPromptDismissed", true);
      setDefaultPromptOpen(false);
      if (isAndroid) {
        toast(t("defaultPlayerSettingsOpened"), 4000);
      } else {
        toast(t("setDefaultPlayerSuccess"), 3000);
      }
    } catch (e) {
      toast(t("setDefaultPlayerError"), 4000);
      console.error(e);
    } finally {
      setDefaultSettingLoading(false);
    }
  }, []);

  useEffect(() => {
    if (screen !== "player" || !openedViaOpenWith.current || countedThisSession.current) return;
    countedThisSession.current = true;

    const timer = window.setTimeout(async () => {
      try {
        const settings = await api.appSettings();
        if (Boolean(settings.defaultPlayerPromptDismissed)) return;

        const isAlreadyDefault = await api.isDefaultPlayer().catch(() => false);
        if (isAlreadyDefault) return;

        const currentCount = typeof settings.openWithCount === "number" ? settings.openWithCount : 0;
        const newCount = currentCount + 1;
        await api.setAppSetting("openWithCount", newCount);

        if (newCount === 3) {
          setDefaultPromptOpen(true);
        }
      } catch (e) {
        console.error("Failed to update openWithCount:", e);
      }
    }, 1500);

    return () => clearTimeout(timer);
  }, [screen]);

  const closeTranscript = useCallback(() => setTranscriptOpen(false), []);

  const openSettings = useCallback((section?: Section) => {
    // The dialog reopens where it was left; the Android page on its list.
    if (section || isAndroid) setSettingsSection(section ?? null);
    setHelpOpen(false);
    setSettingsOpen(true);
  }, []);

  // ---------- opening and closing ----------

  const play = useCallback(async (path: string) => {
    try {
      const media = await player.open(path);
      setScreen("player");
      setLastFolder((prev) => {
        if (prev !== media.folder) void api.setAppSetting("lastFolder", media.folder);
        return media.folder;
      });
    } catch (e) {
      toast(String(e), 5000);
    }
  }, []);

  const backToLibrary = useCallback(async () => {
    setPanelOpen(false);
    setTranscriptOpen(false);
    await player.close();
    if (onClose) onClose();
    else setScreen("library");
  }, [onClose]);

  // ---------- startup (once, even under StrictMode) ----------

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    updateSubScale();
    window.addEventListener("resize", updateSubScale);
    setToastHandler((msg, ms, action) => {
      if (!action) {
        toastRef.current?.show({ severity: "secondary", detail: msg, life: ms });
        return;
      }
      const message: ToastMessage = { severity: "secondary", life: ms };
      message.detail = (
        <div className="flex items-center gap-4">
          <span className="flex-1">{msg}</span>
          <Button
            label={action.label}
            text
            size="small"
            className="-my-1 shrink-0"
            onClick={() => {
              action.run();
              toastRef.current?.remove(message);
            }}
          />
        </div>
      );
      toastRef.current?.show(message);
    });
    void (async () => {
      try {
        const saved = await api.appSettings();
        loadSettings(saved, { theme, locale });
        setLastFolder(typeof saved.lastFolder === "string" ? saved.lastFolder : null);

        await events.playback((p) => {
          clock.update(p);
          player.onPlayback(p);
          if (onProgress && p.duration > 0) {
            onProgress(p.time, p.duration);
          }
        });
        await events.trackUpdated((u) => player.onTrackUpdated(u));
        await events.audioTracks((u) => player.onAudioTracks(u));
        await events.openUrl(async (url) => {
          openedViaOpenWith.current = true;
          countedThisSession.current = false;
          await play(url);
        });

        const frame = () => {
          player.render(clock.now());
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);

        const initial = initialFile || (await api.initialFile());
        if (initial) {
          openedViaOpenWith.current = true;
          await play(initial);
        } else {
          setScreen("library");
        }
      } catch (err) {
        console.error("beyt: failed to initialize app:", err);
        setScreen("library");
      }
    })();
  }, [play]);

  // ---------- controls auto-hide ----------

  const wake = useCallback(() => {
    setControls(true);
    clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      // Locked controls can't be used, so they hide even while paused.
      if (lockedRef.current || !clock.snapshot().paused) setControls(false);
    }, getSettings().controlsHideDelay * 1000);
  }, []);

  const showControls = screen === "player" && (controls || panelOpen || transcriptOpen || menuOpen);
  useEffect(() => {
    document.documentElement.style.setProperty("--controls-offset", showControls ? "84px" : "0px");
    document.body.classList.toggle("idle", screen === "player" && !showControls);
  }, [showControls, screen]);

  // ---------- hints over the video ----------

  const [hint, setHint] = useState<Hint | null>(null);
  const hintTimer = useRef<number | undefined>(undefined);
  /** Shows a hint over the video; `ms` 0 keeps it until replaced. */
  const flash = useCallback((next: Hint, ms = 700) => {
    clearTimeout(hintTimer.current);
    setHint(next);
    if (ms) hintTimer.current = window.setTimeout(() => setHint(null), ms);
  }, []);

  // ---------- locking ----------

  /** Answers input while locked: says so, and brings up the unlock button. */
  const showLocked = useCallback(() => {
    const key = keysFor("lock", getSettings().keymap)[0];
    const shortcut = key && hasHardKeyboard() ? `  ${keyParts(key).join("+")}` : "";
    flash({ icon: "pi pi-lock", text: t("locked") + shortcut, at: "middle" }, 1200);
    wake();
  }, [flash, wake]);

  // A new video can't open while locked, but leaving one always unlocks.
  useEffect(() => {
    if (screen !== "player") setLocked(false);
  }, [screen]);

  // Keep the screen awake on desktop and mobile while controls are locked.
  useEffect(() => {
    void api.setLocked(locked);
  }, [locked]);

  useEffect(() => {
    return () => {
      void api.setLocked(false);
    };
  }, []);

  // ---------- actions (keyboard and right-click menu) ----------

  /** Navigates back one level across pages, folders, tabs, panels and dialogs. */
  const handleBackAction = useCallback((): boolean => {
    // 1. Any active high-level overlay, confirm, sheet, or dialog
    const overlay = document.querySelector(
      ".p-dialog-mask, .p-overlaypanel, .word-sheet, .beyt-sheet.p-component-overlay, .beyt-scrim, .p-menu-overlay, .p-contextmenu",
    );
    if (overlay) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      return true;
    }

    if (helpOpen) {
      setHelpOpen(false);
      return true;
    }

    if (infoOpen) {
      setInfoOpen(false);
      return true;
    }

    if (defaultPromptOpen) {
      void handleSkipDefault();
      return true;
    }

    if (menuOpen) {
      setMenuOpen(false);
      return true;
    }

    // 2. Settings: in Android, go back from a section to sections list, or close settings
    if (settingsOpen) {
      const popup = document.querySelector(".p-dropdown-panel, .p-multiselect-panel, .p-colorpicker-panel, .p-confirm-popup");
      if (popup) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        return true;
      }
      if (isAndroid && settingsSection !== null) {
        setSettingsSection(null);
        return true;
      }
      setSettingsOpen(false);
      return true;
    }

    // 3. Player: panels, countdown, or leave player back to library
    if (screen === "player") {
      if (panelOpen || transcriptOpen) {
        setPanelOpen(false);
        setTranscriptOpen(false);
        return true;
      }
      if (player.cancelCountdown()) {
        return true;
      }
      void backToLibrary();
      return true;
    }

    // 4. Library: folder history, tab history, or dialogs
    if (screen === "library") {
      if (libraryRef.current?.handleBack()) {
        return true;
      }
    }

    // At root of the app: nothing left to go back to
    return false;
  }, [
    helpOpen,
    infoOpen,
    defaultPromptOpen,
    menuOpen,
    settingsOpen,
    settingsSection,
    screen,
    panelOpen,
    transcriptOpen,
    backToLibrary,
    handleSkipDefault,
  ]);

  /** Runs an action; returns false if it doesn't apply here. */
  const runAction = useCallback(
    (action: Action): boolean => {
      const playing = screen === "player";
      if (action === "lock") {
        if (!playing) return false;
        if (!locked) {
          setPanelOpen(false);
          setTranscriptOpen(false);
        }
        setLocked(!locked);
        flash({ icon: locked ? "pi pi-lock-open" : "pi pi-lock", text: t(locked ? "unlocked" : "locked"), at: "middle" }, 1200);
        wake();
        return true;
      }
      // Handled, so the key does nothing else (Tab moving focus, say).
      if (locked && playing) {
        showLocked();
        return true;
      }
      if (!playing && !GLOBAL_ACTIONS.has(action)) return false;
      switch (action) {
        case "back":
          handleBackAction();
          break;
        case "help":
          setHelpOpen(true);
          break;
        case "settings":
          openSettings();
          break;
        case "fullscreen":
          void api.toggleFullscreen();
          break;
        case "quit":
          if (onClose) onClose();
          else void api.quit();
          break;
        case "subtitles":
          setPanelOpen((o) => !o);
          break;
        case "transcript":
          // Only a text subtitle has a transcript.
          if (!transcriptOpen && !player.selectedView()) return false;
          setTranscriptOpen((o) => !o);
          break;
        case "info":
          setInfoOpen(true);
          break;
        default:
          if (!player.runAction(action)) return false;
      }
      if (playing) wake();
      return true;
    },
    [screen, locked, panelOpen, transcriptOpen, backToLibrary, openSettings, wake, flash, showLocked, handleBackAction],
  );

  useEffect(() => {
    const table = bindingTable(keymap);
    const onKey = (e: KeyboardEvent) => {
      // Dialogs and the right-click menu handle their own keys (Escape closes
      // them). The mask is still there while a dialog closes, so the Escape
      // that closed it stops here too.
      if (helpOpen || settingsOpen || infoOpen || menuOpen || document.querySelector(".p-dialog-mask")) return;
      // Escape closes the word popup or a sheet; it mustn't also leave the video.
      if (e.key === "Escape" && document.querySelector(".p-overlaypanel, .word-sheet, .beyt-sheet.p-component-overlay, .beyt-scrim")) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, select, textarea, [role=slider], .p-dropdown, .p-colorpicker")) return;
      const key = eventKey(e);
      const action = key ? table.get(key) : undefined;
      if (action && runAction(action)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keymap, helpOpen, settingsOpen, infoOpen, menuOpen, runAction]);

  // Android's Back button does what Escape does: navigates back a page/level,
  // closes a dialog or popup, or leaves the video for the library. Only at
  // the app root does it send Beyt to the background.
  const onAndroidBack = useRef(() => {});
  onAndroidBack.current = () => {
    const handled = handleBackAction();
    if (!handled) {
      void api.moveToBackground();
    }
  };

  const isAndroidDevice = isAndroid || (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent));

  useEffect(() => {
    if (!isAndroidDevice) return;
    return onBackButton(() => onAndroidBack.current());
  }, [isAndroidDevice]);

  /** Opens the dictionary popup for a subtitle word element. */
  const lookUp = (e: React.MouseEvent | MouseEvent, el: HTMLElement) => {
    if (!el.classList.contains("word")) return;
    if (locked) return showLocked();
    const picked = player.wordContext(el);
    if (picked && picked.word.trim()) wordPopup.current?.open(e, el, picked);
  };
  const pickWord = (e: React.MouseEvent) => lookUp(e, e.target as HTMLElement);

  const rtl = lang === "fa";

  /** Scrolling over the start edge of the video changes the brightness,
   *  over the end edge the volume. */
  const wheelSum = useRef({ edge: "", sum: 0 });
  const onWheel = (e: React.WheelEvent) => {
    // Only over the bare video, not the controls, panels or subtitles.
    if (e.target !== e.currentTarget) return;
    const fromStart = rtl ? window.innerWidth - e.clientX : e.clientX;
    const strip = window.innerWidth * EDGE;
    const edge = fromStart <= strip ? "brightness" : fromStart >= window.innerWidth - strip ? "volume" : null;
    if (!edge) return;
    if (locked) return showLocked();
    if (wheelSum.current.edge !== edge) wheelSum.current = { edge, sum: 0 };
    wheelSum.current.sum += e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 40 : e.deltaY;
    // A wheel notch is a step; touchpads add up small deltas to one.
    const steps = Math.trunc(wheelSum.current.sum / WHEEL_STEP);
    if (!steps) return;
    wheelSum.current.sum -= steps * WHEEL_STEP;
    if (edge === "brightness") player.adjustBrightness(-steps * 5);
    else player.adjustVolume(-steps * 5);
  };

  /** Double-clicking the player toggles fullscreen. */
  const onDoubleClick = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (
      target?.closest(
        "button, a, input, select, textarea, [role=slider], .p-button, .p-dialog, .p-dialog-mask, .p-sidebar, .p-sidebar-mask, .p-overlaypanel, .p-contextmenu, .p-menu, .word, .word-sheet, .beyt-sheet, .beyt-scrim",
      )
    ) {
      return;
    }
    e.preventDefault();
    runAction("fullscreen");
  };

  // ---------- touch gestures (see gestures.ts) ----------

  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef({ levelSum: 0, scrubFrom: null as number | null, holding: false, speed: 1 });
  // Read through a ref, so the listeners attached once see the current state.
  const gestureHandlers = useRef<GestureHandlers | null>(null);
  gestureHandlers.current = {
    tap: () => (showControls ? setControls(false) : wake()),
    multiTap: (zone, count) => {
      if (locked) return showLocked();
      if (zone === "middle") {
        if (count === 2) runAction("togglePause");
        return;
      }
      player.runAction(zone === "back" ? "seekBack" : "seekForward");
      const icon = zone === "back" ? "pi pi-angle-double-left" : "pi pi-angle-double-right";
      flash({ icon, text: `${getSettings().seekStep * (count - 1)}`, at: zone });
    },
    level: (kind, percent) => {
      if (locked) return showLocked();
      // Whole steps of 2%, so a slow swipe still adds up.
      const g = gesture.current;
      g.levelSum += percent;
      const steps = Math.trunc(g.levelSum / 2) * 2;
      if (!steps) return;
      g.levelSum -= steps;
      if (kind === "brightness") player.adjustBrightness(steps);
      else player.adjustVolume(steps);
    },
    scrub: (phase, seconds) => {
      const g = gesture.current;
      if (locked) {
        g.scrubFrom = null;
        if (phase !== "cancel") showLocked();
        return;
      }
      if (phase === "cancel") {
        g.scrubFrom = null;
        setHint(null);
        return;
      }
      g.scrubFrom ??= clock.now();
      const { duration } = clock.snapshot();
      const target = Math.min(Math.max(g.scrubFrom + seconds, 0), duration || Infinity);
      const delta = Math.round(target - g.scrubFrom);
      if (phase === "move") {
        flash({ text: `${fmtTime(target)}  ${delta < 0 ? "−" : "+"}${Math.abs(delta)}`, at: "middle" }, 0);
      } else {
        player.seekTo(target);
        g.scrubFrom = null;
        flash({ text: fmtTime(target), at: "middle" }, 500);
      }
    },
    hold: (active) => {
      const g = gesture.current;
      if (active) {
        if (locked) return showLocked();
        const now = clock.snapshot();
        if (now.paused) return;
        g.holding = true;
        g.speed = now.speed;
        void api.setMpvOption("speed", "2");
        flash({ icon: "pi pi-forward", text: "2×", at: "middle" }, 0);
      } else if (g.holding) {
        g.holding = false;
        void api.setMpvOption("speed", String(g.speed));
        setHint(null);
      }
    },
  };
  useEffect(() => {
    const el = root.current;
    if (!el || screen !== "player") return;
    const h = () => gestureHandlers.current!;
    return attachGestures(
      el,
      {
        tap: () => h().tap(),
        multiTap: (zone, count) => h().multiTap(zone, count),
        level: (kind, percent) => h().level(kind, percent),
        scrub: (phase, seconds) => h().scrub(phase, seconds),
        hold: (active) => h().hold(active),
      },
      () => getLang() === "fa",
    );
  }, [screen]);

  /** A sideways swipe on a subtitle line moves to the previous or next line;
   *  dragging a line up or down moves its whole stack. */
  const swipeStart = useRef<{ x: number; y: number; at: number } | null>(null);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    key: "topMargin" | "bottomMargin";
    from: number;
    percent: number;
    stack: HTMLElement;
    track: Element;
    moving: boolean;
  } | null>(null);
  const swiped = useRef(false);
  // The swipe or drag isn't also a tap on a word.
  const suppressTap = () => {
    swiped.current = true;
    window.setTimeout(() => (swiped.current = false), 400);
  };
  const onSubDown = (e: React.PointerEvent) => {
    swipeStart.current = e.pointerType === "mouse" ? null : { x: e.clientX, y: e.clientY, at: performance.now() };
    const track = (e.target as Element).closest(".track");
    if (!track || locked || (e.pointerType === "mouse" && e.button !== 0)) {
      drag.current = null;
      return;
    }
    const stack = e.currentTarget as HTMLElement;
    const key = marginKey(stack.id === "subs-top" ? "top" : "bottom");
    const from = getSettings()[key];
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, key, from, percent: from, stack, track, moving: false };
  };
  const onSubMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moving) {
      if (Math.hypot(dx, dy) < SUB_DRAG) return;
      // Mostly sideways: a line swipe, not a drag.
      if (Math.abs(dx) > Math.abs(dy)) {
        drag.current = null;
        return;
      }
      d.moving = true;
      swipeStart.current = null;
      // On the track, which stays put while its lines change underneath.
      d.track.setPointerCapture(e.pointerId);
      d.stack.classList.add("dragging");
    }
    const delta = (dy / (root.current?.clientHeight || window.innerHeight)) * 100;
    d.percent = clampMargin(d.key === "bottomMargin" ? d.from - delta : d.from + delta);
    // Straight to the CSS variable while dragging; saved once on release.
    document.documentElement.style.setProperty(d.key === "bottomMargin" ? "--sub-bottom" : "--sub-top", `${d.percent}%`);
  };
  /** Ends a drag, keeping where it went or going back; true if there was one. */
  const endDrag = (keep: boolean): boolean => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moving) return false;
    d.stack.classList.remove("dragging");
    updateSettings({ [d.key]: keep ? d.percent : d.from });
    return true;
  };
  const onSubUp = (e: React.PointerEvent) => {
    if (endDrag(true)) {
      swipeStart.current = null;
      suppressTap();
      return;
    }
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start) return;
    const next = lineSwipe(start, { x: e.clientX, y: e.clientY, at: performance.now() }, rtl);
    if (next === null) return;
    suppressTap();
    runAction(next ? "nextLine" : "prevLine");
  };
  const onSubCancel = () => {
    endDrag(false);
    swipeStart.current = null;
  };
  const pickWordUnlessSwiped = (e: React.MouseEvent) => {
    if (!swiped.current) pickWord(e);
  };

  return (
    <div
      ref={root}
      // While a video plays, the page itself doesn't pan or zoom: touches are gestures.
      className={`relative h-full text-zinc-100 ${screen === "player" ? "touch-none" : ""}`}
      onMouseMove={screen === "player" ? wake : undefined}
      onWheel={screen === "player" ? onWheel : undefined}
      onDoubleClick={screen === "player" ? onDoubleClick : undefined}
    >
      {!isTauri && <VideoSurface visible={screen === "player"} />}
      {/* TrackView draws subtitle lines into these two stacks. */}
      <div
        id="subs-top"
        className="sub-stack top"
        onClick={pickWordUnlessSwiped}
        onPointerDown={onSubDown}
        onPointerMove={onSubMove}
        onPointerUp={onSubUp}
        onPointerCancel={onSubCancel}
      />
      <div
        id="subs-bottom"
        className="sub-stack bottom"
        onClick={pickWordUnlessSwiped}
        onPointerDown={onSubDown}
        onPointerMove={onSubMove}
        onPointerUp={onSubUp}
        onPointerCancel={onSubCancel}
      />
      {hint && screen === "player" && <GestureHint hint={hint} />}

      {screen === "player" && (
        <PlayerChrome
          visible={showControls}
          locked={locked}
          onToggleLock={() => runAction("lock")}
          onBack={() => void backToLibrary()}
          onToggleSubtitles={() => setPanelOpen((o) => !o)}
          onInfo={() => setInfoOpen(true)}
          onToggleTranscript={() => setTranscriptOpen((o) => !o)}
          onHelp={() => setHelpOpen(true)}
          onSettings={() => openSettings()}
          onMenuVisibleChange={setMenuOpen}
        />
      )}
      <SubtitlePanel visible={panelOpen && screen === "player"} rtl={rtl} onHide={() => setPanelOpen(false)} />
      <Transcript visible={transcriptOpen && screen === "player"} rtl={rtl} onHide={closeTranscript} />
      {screen === "player" && <LevelIndicator />}
      <div className="contents" inert={locked}>
        <UpNextCard />
      </div>
      <WordPopup ref={wordPopup} />

      {screen === "library" && (
        <Library
          ref={libraryRef}
          folder={lastFolder}
          onPlay={(path) => void play(path)}
          onHelp={() => setHelpOpen(true)}
          onSettings={() => openSettings()}
        />
      )}

      <FileInfoDialog
        visible={infoOpen && screen === "player"}
        path={player.media?.path ?? null}
        onHide={() => setInfoOpen(false)}
      />
      <DefaultPlayerDialog
        visible={defaultPromptOpen}
        onHide={handleSkipDefault}
        onSkip={handleSkipDefault}
        onSetDefault={handleSetDefault}
        loading={defaultSettingLoading}
      />
      <ShortcutsDialog visible={helpOpen} onHide={() => setHelpOpen(false)} onCustomise={() => openSettings("shortcuts")} />
      {settingsSeen.current && (
        <Suspense fallback={null}>
      {isAndroid ? (
        <SettingsPage
          visible={settingsOpen}
          section={settingsSection}
          onSection={setSettingsSection}
          onHide={() => setSettingsOpen(false)}
        />
      ) : (
        <SettingsDialog
          visible={settingsOpen}
          section={settingsSection ?? "general"}
          onSection={setSettingsSection}
          onHide={() => setSettingsOpen(false)}
        />
      )}
        </Suspense>
      )}
      <AppContextMenu
        screen={screen}
        locked={locked}
        runAction={runAction}
        onLookUp={lookUp}
        onBack={() => void backToLibrary()}
        onVisibleChange={setMenuOpen}
      />
      <ConfirmHost />
      <Toast ref={toastRef} position={rtl ? "top-left" : "top-right"} transitionOptions={popupMotions.toast} />
    </div>
  );
}
