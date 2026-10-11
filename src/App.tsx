import { Toast } from "primereact/toast";
import { useCallback, useEffect, useRef, useState } from "react";

import { api, events } from "./api";
import * as clock from "./clock";
import { Hud } from "./components/Hud";
import { Library } from "./components/Library";
import { PlayerChrome } from "./components/PlayerChrome";
import { SubtitlePanel } from "./components/SubtitlePanel";
import { UpNextCard } from "./components/UpNextCard";
import { player, useLang } from "./hooks";
import { type Lang, defaultLang, setLang } from "./i18n";
import { setToastHandler, toast } from "./ui";

const IDLE_MS = 2500;

type Screen = "loading" | "library" | "player";

export function App() {
  const lang = useLang();
  const [screen, setScreen] = useState<Screen>("loading");
  const [lastFolder, setLastFolder] = useState<string | null>(null);
  const [autoplay, setAutoplay] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const [hudOpen, setHudOpen] = useState(false);
  const [controls, setControls] = useState(true);
  const toastRef = useRef<Toast>(null);
  const idleTimer = useRef<number | undefined>(undefined);

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
      const settings = await api.appSettings();
      setLang((settings.uiLanguage as Lang | undefined) ?? defaultLang());
      player.autoplayNext = settings.autoplayNext !== false;
      setAutoplay(player.autoplayNext);
      setLastFolder(typeof settings.lastFolder === "string" ? settings.lastFolder : null);

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
    }, IDLE_MS);
  }, []);

  const showControls = screen === "player" && (controls || panelOpen);
  useEffect(() => {
    document.documentElement.style.setProperty("--controls-offset", showControls ? "84px" : "0px");
    document.body.classList.toggle("idle", screen === "player" && !showControls);
  }, [showControls, screen]);

  // ---------- keyboard ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, select, textarea, [role=slider], .p-dropdown, .p-colorpicker")) return;
      const key = e.key.toLowerCase();
      const playing = screen === "player";

      if (key === "escape") {
        if (panelOpen) setPanelOpen(false);
        else if (player.cancelCountdown()) {
          /* autoplay cancelled */
        } else if (playing) void backToLibrary();
      } else if (key === "f") {
        void api.toggleFullscreen();
      } else if (key === "q" && e.ctrlKey) {
        void api.quit();
      } else if (!playing) {
        return;
      } else if (key === "l") {
        setPanelOpen((o) => !o);
      } else if (key === "i") {
        setHudOpen((o) => !o);
      } else if (!player.handleKey(e)) {
        return;
      }
      e.preventDefault();
      if (playing) wake();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, panelOpen, backToLibrary, wake]);

  const changeLanguage = (next: Lang) => {
    setLang(next);
    void api.setAppSetting("uiLanguage", next);
  };
  const changeAutoplay = (on: boolean) => {
    player.autoplayNext = on;
    setAutoplay(on);
    void api.setAppSetting("autoplayNext", on);
  };

  const rtl = lang === "fa";

  return (
    <div className="relative h-full text-zinc-100" onMouseMove={screen === "player" ? wake : undefined}>
      {/* TrackView draws subtitle lines into these two stacks. */}
      <div id="subs-top" className="sub-stack top" />
      <div id="subs-bottom" className="sub-stack bottom" />

      {screen === "player" && (
        <PlayerChrome
          visible={showControls}
          onBack={() => void backToLibrary()}
          onToggleSubtitles={() => setPanelOpen((o) => !o)}
          onToggleInfo={() => setHudOpen((o) => !o)}
        />
      )}
      {screen === "player" && hudOpen && <Hud />}
      <SubtitlePanel visible={panelOpen && screen === "player"} rtl={rtl} onHide={() => setPanelOpen(false)} />
      <UpNextCard />

      {screen === "library" && (
        <Library
          folder={lastFolder}
          autoplay={autoplay}
          onPlay={(path) => void play(path)}
          onLanguage={changeLanguage}
          onAutoplay={changeAutoplay}
        />
      )}

      <Toast ref={toastRef} position={rtl ? "top-left" : "top-right"} />
    </div>
  );
}
