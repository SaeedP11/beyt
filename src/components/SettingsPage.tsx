// Android: settings as a full-screen page instead of a dialog. It opens on a
// list of sections; each section is a page of its own, and Back (the app
// bar's arrow, Android's Back button or Escape) goes up a level at a time.

import { getVersion } from "@tauri-apps/api/app";
import { ConfirmPopup } from "primereact/confirmpopup";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useHardKeyboard } from "../hooks";
import { t } from "../i18n";
import { slideIn, slideOut } from "../motion";
import { Compact, SECTIONS, type Section, SectionContent } from "./SettingsDialog";

const EXIT_MS = 200;

/** The section list, in two cards: watching, then everything else. */
const CARDS: Section[][] = [
  ["general", "playback", "subtitles", "learning"],
  ["anki", "shortcuts", "data"],
];

/** Overlays that close on Escape themselves; Escape then isn't a Back. */
const POPUPS = ".p-dropdown-panel, .p-multiselect-panel, .p-colorpicker-panel, .p-confirm-popup, .p-overlaypanel, .p-dialog-mask";

interface Props {
  visible: boolean;
  /** The section shown, or null for the list of sections. */
  section: Section | null;
  onSection: (s: Section | null) => void;
  onHide: () => void;
}

export function SettingsPage({ visible, section, onSection, onHide }: Props) {
  const [mounted, setMounted] = useState(visible);
  const root = useRef<HTMLDivElement>(null);
  /** Moved between the list and a section (not just opened), so the body slides. */
  const navigated = useRef(false);
  const keyboard = useHardKeyboard();

  // Opens with a slide in from the end side, closes with one back out.
  useEffect(() => {
    if (visible) {
      navigated.current = false;
      setMounted(true);
      return;
    }
    if (!root.current) return setMounted(false);
    slideOut(root.current, EXIT_MS);
    const id = window.setTimeout(() => setMounted(false), EXIT_MS);
    return () => window.clearTimeout(id);
  }, [visible]);
  useLayoutEffect(() => {
    if (visible && mounted && root.current) slideIn(root.current, true);
  }, [visible, mounted]);

  const go = (next: Section | null) => {
    navigated.current = true;
    onSection(next);
  };
  const back = () => (section ? go(null) : onHide());

  // Escape (and so Android's Back button) goes up a level.
  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector(POPUPS)) return;
      e.preventDefault();
      backRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  // Shortcuts need a keyboard; leave them if it's unplugged.
  useEffect(() => {
    if (section === "shortcuts" && !keyboard) onSection(null);
  }, [section, keyboard, onSection]);

  if (!mounted) return null;
  const current = section && SECTIONS.find((s) => s.id === section);

  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={t("settings")}
      className="fixed inset-0 z-50 flex flex-col bg-ink-950 text-zinc-100"
    >
      <ConfirmPopup />
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-ink-700/60 px-1">
        <button
          type="button"
          onClick={back}
          aria-label={t("navBack")}
          className="grid h-12 w-12 shrink-0 place-items-center rounded-full text-zinc-200 transition-colors [-webkit-tap-highlight-color:transparent] active:bg-ink-800 focus-visible:outline-2 focus-visible:outline-accent"
        >
          <i className="pi pi-arrow-left text-lg rtl:-scale-x-100" />
        </button>
        <h1 className="min-w-0 truncate text-lg font-semibold">{t(current ? current.label : "settings")}</h1>
      </header>

      <Body key={section ?? "list"} animate={navigated.current} forward={section !== null}>
        {section ? (
          <Compact.Provider value={true}>
            <SectionContent section={section} />
          </Compact.Provider>
        ) : (
          <SectionList keyboard={keyboard} onPick={go} />
        )}
      </Body>
    </div>,
    document.body,
  );
}

/** One level's scrolling body; it slides in from the side it was reached from. */
function Body({ animate, forward, children }: { animate: boolean; forward: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (animate && ref.current) slideIn(ref.current, forward);
    // Only as it first shows.
  }, []);
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto max-w-2xl px-4 pb-10 pt-4">{children}</div>
    </div>
  );
}

function SectionList({ keyboard, onPick }: { keyboard: boolean; onPick: (s: Section) => void }) {
  const [version, setVersion] = useState("");
  useEffect(() => void getVersion().then(setVersion, () => {}), []);

  return (
    <>
      {CARDS.map((ids) => (
        <div key={ids[0]} className="mb-5 divide-y divide-ink-700/60 overflow-hidden rounded-2xl border border-ink-700/60 bg-ink-900">
          {SECTIONS.filter((s) => ids.includes(s.id) && (s.id !== "shortcuts" || keyboard)).map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onPick(s.id)}
              className="flex min-h-16 w-full items-center gap-4 px-4 py-3 text-start transition-colors [-webkit-tap-highlight-color:transparent] active:bg-ink-800 focus-visible:bg-ink-800 focus-visible:outline-none"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent">
                <i className={`${s.icon} text-lg`} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.9375rem] font-medium text-zinc-100">{t(s.label)}</span>
                <span className="block truncate text-xs text-zinc-400">{t(s.summary)}</span>
              </span>
              <i className="pi pi-angle-right text-zinc-500 rtl:-scale-x-100" />
            </button>
          ))}
        </div>
      ))}
      <div className="mt-8 flex flex-col items-center gap-1 text-center">
        <span className="font-sans text-2xl font-bold text-accent/80" lang="fa">
          بیت
        </span>
        {version && (
          <span className="text-xs tabular-nums text-zinc-500" dir="auto">
            {t("appVersion", { v: version })}
          </span>
        )}
      </div>
    </>
  );
}
