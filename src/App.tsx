import { Button } from "primereact/button";
import { Toast, type ToastMessage } from "primereact/toast";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, events } from "./api";
import * as clock from "./clock";
import { AppContextMenu } from "./components/AppContextMenu";
import { FileInfoDialog } from "./components/FileInfoDialog";
import { Library } from "./components/Library";
import { PlayerChrome } from "./components/PlayerChrome";
import { type Section, SettingsDialog } from "./components/SettingsDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { SubtitlePanel } from "./components/SubtitlePanel";
import { Transcript } from "./components/Transcript";
import { UpNextCard } from "./components/UpNextCard";
import { LevelIndicator } from "./components/LevelIndicator";
import { WordPopup, type WordPopupHandle } from "./components/WordPopup";
import { player, useLang } from "./hooks";
import { type Action, bindingTable, eventKey } from "./keymap";
import { popupMotions } from "./motion";
import { getSettings, loadSettings, useSettings } from "./settings";
import { setToastHandler, toast } from "./ui";

type Screen = "loading" | "library" | "player";

/** Actions that work on the library screen too. */
const GLOBAL_ACTIONS = new Set<Action>(["help", "settings", "fullscreen", "quit", "back"]);
/** Width of the strips at the edges where scrolling sets the brightness
 *  (start edge) and the volume (end edge). */
const EDGE = 0.2;
/** Wheel distance for one brightness step (about one mouse wheel notch). */
const WHEEL_STEP = 50;

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
  const [settingsSection, setSettingsSection] = useState<Section>("general");
  const [controls, setControls] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const toastRef = useRef<Toast>(null);
  const wordPopup = useRef<WordPopupHandle>(null);
  const idleTimer = useRef<number | undefined>(undefined);

  const closeTranscript = useCallback(() => setTranscriptOpen(false), []);

  const openSettings = useCallback((section?: Section) => {
    if (section) setSettingsSection(section);
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
      if (!clock.snapshot().paused) setControls(false);
    }, getSettings().controlsHideDelay * 1000);
  }, []);

  const showControls = screen === "player" && (controls || panelOpen || transcriptOpen || menuOpen);
  useEffect(() => {
    document.documentElement.style.setProperty("--controls-offset", showControls ? "84px" : "0px");
    document.body.classList.toggle("idle", screen === "player" && !showControls);
  }, [showControls, screen]);

  // ---------- actions (keyboard and right-click menu) ----------

  /** Runs an action; returns false if it doesn't apply here. */
  const runAction = useCallback(
    (action: Action): boolean => {
      const playing = screen === "player";
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
    [screen, panelOpen, transcriptOpen, backToLibrary, openSettings, wake],
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

  /** Opens the dictionary popup for a subtitle word element. */
  const lookUp = (e: React.MouseEvent | MouseEvent, el: HTMLElement) => {
    if (el.tagName !== "SPAN" || el.classList.contains("line")) return;
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
    if (wheelSum.current.edge !== edge) wheelSum.current = { edge, sum: 0 };
    wheelSum.current.sum += e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 40 : e.deltaY;
    // A wheel notch is a step; touchpads add up small deltas to one.
    const steps = Math.trunc(wheelSum.current.sum / WHEEL_STEP);
    if (!steps) return;
    wheelSum.current.sum -= steps * WHEEL_STEP;
    if (edge === "brightness") player.adjustBrightness(-steps * 5);
    else player.adjustVolume(-steps * 5);
  };

  return (
    <div
      className="relative h-full text-zinc-100"
      onMouseMove={screen === "player" ? wake : undefined}
      onWheel={screen === "player" ? onWheel : undefined}
    >
      {/* TrackView draws subtitle lines into these two stacks. */}
      <div id="subs-top" className="sub-stack top" onClick={pickWord} />
      <div id="subs-bottom" className="sub-stack bottom" onClick={pickWord} />

      {screen === "player" && (
        <PlayerChrome
          visible={showControls}
          onBack={() => void backToLibrary()}
          onToggleSubtitles={() => setPanelOpen((o) => !o)}
          onInfo={() => setInfoOpen(true)}
          onToggleTranscript={() => setTranscriptOpen((o) => !o)}
          onHelp={() => setHelpOpen(true)}
          onSettings={() => openSettings()}
        />
      )}
      <SubtitlePanel visible={panelOpen && screen === "player"} rtl={rtl} onHide={() => setPanelOpen(false)} />
      <Transcript visible={transcriptOpen && screen === "player"} rtl={rtl} onHide={closeTranscript} />
      {screen === "player" && <LevelIndicator />}
      <UpNextCard />
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
      <SettingsDialog
        visible={settingsOpen}
        section={settingsSection}
        onSection={setSettingsSection}
        onHide={() => setSettingsOpen(false)}
      />
      <AppContextMenu
        screen={screen}
        runAction={runAction}
        onLookUp={lookUp}
        onBack={() => void backToLibrary()}
        onVisibleChange={setMenuOpen}
      />
      <Toast ref={toastRef} position={rtl ? "top-left" : "top-right"} transitionOptions={popupMotions.toast} />
    </div>
  );
}
