import { onBackButtonPress } from "@tauri-apps/api/app";
import { Button } from "primereact/button";
import { Toast, type ToastMessage } from "primereact/toast";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, events, isAndroid } from "./api";
import * as clock from "./clock";
import { AppContextMenu } from "./components/AppContextMenu";
import { FileInfoDialog } from "./components/FileInfoDialog";
import { Library } from "./components/Library";
import { PlayerChrome } from "./components/PlayerChrome";
import { type Section, SettingsDialog } from "./components/SettingsDialog";
import { SettingsPage } from "./components/SettingsPage";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { SubtitlePanel } from "./components/SubtitlePanel";
import { Transcript } from "./components/Transcript";
import { UpNextCard } from "./components/UpNextCard";
import { LevelIndicator } from "./components/LevelIndicator";
import { WordPopup, type WordPopupHandle } from "./components/WordPopup";
import { attachGestures, type GestureHandlers, lineSwipe, type Zone } from "./gestures";
import { hasHardKeyboard, player, useLang } from "./hooks";
import { getLang, t } from "./i18n";
import { type Action, bindingTable, eventKey, keyParts, keysFor } from "./keymap";
import { popupMotions } from "./motion";
import { getSettings, loadSettings, useSettings } from "./settings";
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
        className="flex items-center gap-2 rounded-full bg-ink-950/70 px-4 py-2 text-lg font-semibold whitespace-pre text-white tabular-nums"
        dir="ltr"
      >
        {hint.icon && <i className={hint.icon} />}
        {hint.text}
      </div>
    </div>
  );
}

/** Actions that work on the library screen too. */
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

export function App() {
  const lang = useLang();
  const { keymap } = useSettings();
  const [screen, setScreen] = useState<Screen>("loading");
  const [lastFolder, setLastFolder] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const idleTimer = useRef<number | undefined>(undefined);

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
    setScreen("library");
  }, []);

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
      const saved = await api.appSettings();
      loadSettings(saved);
      setLastFolder(typeof saved.lastFolder === "string" ? saved.lastFolder : null);

      await events.playback((p) => {
        clock.update(p);
        player.onPlayback(p);
      });
      await events.trackUpdated((u) => player.onTrackUpdated(u));
      await events.audioTracks((u) => player.onAudioTracks(u));

      const frame = () => {
        player.render(clock.now());
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);

      const initial = await api.initialFile();
      if (initial) await play(initial);
      else setScreen("library");
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

  // ---------- actions (keyboard and right-click menu) ----------

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
          if (panelOpen || transcriptOpen) {
            setPanelOpen(false);
            setTranscriptOpen(false);
          } else if (!player.cancelCountdown() && playing) {
            void backToLibrary();
          }
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
          void api.quit();
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
    [screen, locked, panelOpen, transcriptOpen, backToLibrary, openSettings, wake, flash, showLocked],
  );

  useEffect(() => {
    const table = bindingTable(keymap);
    const onKey = (e: KeyboardEvent) => {
      // Dialogs and the right-click menu handle their own keys (Escape closes
      // them). The mask is still there while a dialog closes, so the Escape
      // that closed it stops here too.
      if (helpOpen || settingsOpen || infoOpen || menuOpen || document.querySelector(".p-dialog-mask")) return;
      // Escape closes the word popup; it mustn't also leave the video.
      if (e.key === "Escape" && document.querySelector(".p-overlaypanel")) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, select, textarea, [role=slider], .p-dropdown, .p-colorpicker")) return;
      const key = eventKey(e);
      const action = key ? table.get(key) : undefined;
      if (action && runAction(action)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keymap, helpOpen, settingsOpen, infoOpen, menuOpen, runAction]);

  // Android's Back button does what Escape does: closes a dialog or popup,
  // or leaves the video for the library. In the library it sends Beyt to
  // the background. Without this, Back closed Beyt from anywhere.
  const onAndroidBack = useRef(() => {});
  onAndroidBack.current = () => {
    const overlay = document.querySelector(".p-dialog-mask, .p-overlaypanel, .p-menu-overlay, .p-contextmenu");
    if (helpOpen || settingsOpen || infoOpen || menuOpen || overlay) {
      // They close on Escape, as on the desktop.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    } else if (screen === "player") {
      runAction("back");
    } else {
      void api.moveToBackground();
    }
  };
  useEffect(() => {
    if (!isAndroid) return;
    const listener = onBackButtonPress(() => onAndroidBack.current());
    return () => void listener.then((l) => l.unregister());
  }, []);

  /** Opens the dictionary popup for a subtitle word element. */
  const lookUp = (e: React.MouseEvent | MouseEvent, el: HTMLElement) => {
    if (el.tagName !== "SPAN" || el.classList.contains("line")) return;
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

  /** A sideways swipe on a subtitle line moves to the previous or next line. */
  const swipeStart = useRef<{ x: number; y: number; at: number } | null>(null);
  const swiped = useRef(false);
  const onSubDown = (e: React.PointerEvent) => {
    swipeStart.current = e.pointerType === "mouse" ? null : { x: e.clientX, y: e.clientY, at: performance.now() };
  };
  const onSubUp = (e: React.PointerEvent) => {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start) return;
    const next = lineSwipe(start, { x: e.clientX, y: e.clientY, at: performance.now() }, rtl);
    if (next === null) return;
    // The swipe isn't also a tap on a word.
    swiped.current = true;
    window.setTimeout(() => (swiped.current = false), 400);
    runAction(next ? "nextLine" : "prevLine");
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
    >
      {/* TrackView draws subtitle lines into these two stacks. */}
      <div
        id="subs-top"
        className="sub-stack top"
        onClick={pickWordUnlessSwiped}
        onPointerDown={onSubDown}
        onPointerUp={onSubUp}
      />
      <div
        id="subs-bottom"
        className="sub-stack bottom"
        onClick={pickWordUnlessSwiped}
        onPointerDown={onSubDown}
        onPointerUp={onSubUp}
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
      <ShortcutsDialog visible={helpOpen} onHide={() => setHelpOpen(false)} onCustomise={() => openSettings("shortcuts")} />
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
      <AppContextMenu
        screen={screen}
        locked={locked}
        runAction={runAction}
        onLookUp={lookUp}
        onBack={() => void backToLibrary()}
        onVisibleChange={setMenuOpen}
      />
      <Toast ref={toastRef} position={rtl ? "top-left" : "top-right"} transitionOptions={popupMotions.toast} />
    </div>
  );
}
