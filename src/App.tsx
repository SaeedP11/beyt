import { Toast } from "primereact/toast";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, events } from "./api";
import * as clock from "./clock";
import { FileInfoDialog } from "./components/FileInfoDialog";
import { Library } from "./components/Library";
import { PlayerChrome } from "./components/PlayerChrome";
import { type Section, SettingsDialog } from "./components/SettingsDialog";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { SubtitlePanel } from "./components/SubtitlePanel";
import { Transcript } from "./components/Transcript";
import { UpNextCard } from "./components/UpNextCard";
import { WordPopup, type WordPopupHandle } from "./components/WordPopup";
import { player, useLang } from "./hooks";
import { type Action, bindingTable, eventKey } from "./keymap";
import { getSettings, loadSettings, useSettings } from "./settings";
import { setToastHandler, toast } from "./ui";

type Screen = "loading" | "library" | "player";

/** Actions that work on the library screen too. */
const GLOBAL_ACTIONS = new Set<Action>(["help", "settings", "fullscreen", "quit", "back"]);

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
  const toastRef = useRef<Toast>(null);
  const wordPopup = useRef<WordPopupHandle>(null);
  const idleTimer = useRef<number | undefined>(undefined);

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
    setToastHandler((msg, ms) => toastRef.current?.show({ severity: "secondary", detail: msg, life: ms }));
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

  const showControls = screen === "player" && (controls || panelOpen || transcriptOpen);
  useEffect(() => {
    document.documentElement.style.setProperty("--controls-offset", showControls ? "84px" : "0px");
    document.body.classList.toggle("idle", screen === "player" && !showControls);
  }, [showControls, screen]);

  // ---------- keyboard ----------

  useEffect(() => {
    const table = bindingTable(keymap);
    const onKey = (e: KeyboardEvent) => {
      // Dialogs handle their own keys (Escape closes them). The mask is still
      // there while one closes, so the Escape that closed it stops here too.
      if (helpOpen || settingsOpen || infoOpen || document.querySelector(".p-dialog-mask")) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, select, textarea, [role=slider], .p-dropdown, .p-colorpicker")) return;
      const key = eventKey(e);
      const action = key ? table.get(key) : undefined;
      if (!action) return;
      const playing = screen === "player";
      if (!playing && !GLOBAL_ACTIONS.has(action)) return;

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
          setTranscriptOpen((o) => !o);
          break;
        case "info":
          setInfoOpen(true);
          break;
        default:
          if (!player.runAction(action)) return;
      }
      e.preventDefault();
      if (playing) wake();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keymap, screen, panelOpen, transcriptOpen, helpOpen, settingsOpen, infoOpen, backToLibrary, openSettings, wake]);

  /** A click on a subtitle word opens its dictionary popup. */
  const pickWord = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    if (el.tagName !== "SPAN" || el.classList.contains("line")) return;
    const picked = player.wordContext(el);
    if (picked && picked.word.trim()) wordPopup.current?.open(e, el, picked);
  };

  const rtl = lang === "fa";

  return (
    <div className="relative h-full text-zinc-100" onMouseMove={screen === "player" ? wake : undefined}>
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
      <Transcript visible={transcriptOpen && screen === "player"} rtl={rtl} onHide={() => setTranscriptOpen(false)} />
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
      <Toast ref={toastRef} position={rtl ? "top-left" : "top-right"} />
    </div>
  );
}
