import { Button } from "primereact/button";
import { OverlayPanel } from "primereact/overlaypanel";
import { Tag } from "primereact/tag";
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";

import { api, isAndroid } from "../api";
import * as clock from "../clock";
import { markDictionaryMissing, useDictionary } from "../dictionary";
import { popupMotions } from "../motion";
import { captureOptions } from "../player";
import { getSettings } from "../settings";
import { player } from "../hooks";
import { type StringKey, t } from "../i18n";
import type { Lookup, PickedWord } from "../types";
import { toast } from "../ui";
import { DictionaryInstallCard } from "./DictionaryInstall";
import { WordSheet } from "./WordSheet";

export interface WordPopupHandle {
  /** `event` may be a native one: the right-click menu opens the popup too. */
  open: (event: React.MouseEvent | MouseEvent, target: HTMLElement, picked: PickedWord) => void;
}

type State =
  | { kind: "loading" }
  | { kind: "done"; lookup: Lookup }
  | { kind: "error"; message: string }
  /** No dictionary installed yet. */
  | { kind: "missing" };

/** Space between the word and the popup (room for the arrow), and from the window edges. */
const GAP = 10;
const EDGE = 8;

/**
 * Puts the popup above `word`, or below it when there's more room there, kept
 * inside the window. PrimeReact only positions the panel when it opens, so a
 * popup opened while still loading grows off the bottom of the screen; this
 * runs again whenever the panel changes size.
 */
function place(panel: HTMLElement, word: HTMLElement) {
  const w = word.getBoundingClientRect();
  // offset sizes ignore the opening animation's scale transform.
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const above = w.top - GAP - height >= EDGE || w.top > window.innerHeight - w.bottom;
  const top = above
    ? Math.max(EDGE, w.top - GAP - height)
    : Math.min(w.bottom + GAP, window.innerHeight - height - EDGE);
  const center = w.left + w.width / 2;
  const left = Math.min(Math.max(center - width / 2, EDGE), window.innerWidth - width - EDGE);

  Object.assign(panel.style, {
    top: `${top + window.scrollY}px`,
    left: `${left + window.scrollX}px`,
    margin: "0",
    transformOrigin: above ? "bottom" : "top",
  });
  // The arrow sits 1.25rem (20px) past this offset; point it at the word.
  panel.style.setProperty("--overlayArrowLeft", `${Math.min(Math.max(center - left - 20, 0), width - 40)}px`);
  panel.classList.toggle("p-overlaypanel-flipped", above);
  panel.setAttribute("data-p-overlaypanel-flipped", String(above));
}

function posLabel(pos: string): string {
  const key = `pos_${pos}` as StringKey;
  const label = t(key);
  return label === key ? pos : label;
}

/** Dictionary popup for a clicked subtitle word (a sheet on phones). Pauses while open. */
export function WordPopup({ ref }: { ref: Ref<WordPopupHandle> }) {
  const panel = useRef<OverlayPanel>(null);
  const target = useRef<HTMLElement | null>(null);
  const resumeOnClose = useRef(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [picked, setPicked] = useState<PickedWord | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [saved, setSaved] = useState(false);
  /** The word being shown, so a late lookup for an earlier one is dropped. */
  const current = useRef<PickedWord | null>(null);

  const reposition = useCallback(() => {
    const el = panel.current?.getElement();
    if (el && target.current) place(el, target.current);
  }, []);

  // Re-place whenever the content changes size (loading → results) or the window resizes.
  const watchSize = useCallback((content: HTMLDivElement | null) => {
    if (!content) return;
    const observer = new ResizeObserver(reposition);
    observer.observe(content);
    // PrimeReact re-aligns on resize too; run after it.
    const onResize = () => requestAnimationFrame(reposition);
    window.addEventListener("resize", onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [reposition]);

  useImperativeHandle(ref, () => ({
    open(event, el, word) {
      target.current?.classList.remove("picked");
      target.current = el;
      el.classList.add("picked");
      if (getSettings().popupPauses && !clock.snapshot().paused) {
        resumeOnClose.current = true;
        void api.setPause(true);
      }
      current.current = word;
      setPicked(word);
      setState({ kind: "loading" });
      setSaved(false);
      if (isAndroid) {
        // Already open on another word: the sheet stays and shows this one.
        setSheetOpen(true);
      } else {
        panel.current?.show(event as unknown as React.SyntheticEvent, el);
        // Already open on another word: PrimeReact just re-aligned it below.
        reposition();
      }
      lookUp(word);
    },
  }));

  const lookUp = (word: PickedWord) => {
    api.lookupWord(word.word, word.lang).then(
      (lookup) => {
        // A late answer for a word the popup has moved on from.
        if (current.current === word) setState({ kind: "done", lookup });
      },
      (e) => {
        if (current.current !== word) return;
        if (String(e) === "dictionary-missing") {
          markDictionaryMissing();
          setState({ kind: "missing" });
        } else {
          setState({ kind: "error", message: String(e) });
        }
      },
    );
  };

  // Installed from the popup (or Settings) while it shows the install card:
  // look the word up now.
  const dictionary = useDictionary();
  useEffect(() => {
    if (dictionary.kind === "ready" && state.kind === "missing" && picked) {
      setState({ kind: "loading" });
      lookUp(picked);
    }
  }, [dictionary.kind]);

  const onHide = () => {
    target.current?.classList.remove("picked");
    target.current = null;
    if (resumeOnClose.current) {
      resumeOnClose.current = false;
      void api.setPause(false);
    }
  };

  const closeSheet = useCallback(() => {
    setSheetOpen(false);
    onHide();
  }, []);

  const lookup = state.kind === "done" ? state.lookup : null;
  const showsPersian = picked?.lang !== "fa";

  const save = async () => {
    const video = player.media?.path;
    if (!picked || !video) return;
    const top = lookup?.entries[0];
    try {
      await api.saveVocab({
        word: lookup?.matched ?? lookup?.word ?? picked.word,
        meaning: top ? (showsPersian ? top.fa : top.glosses[0] ?? null) : null,
        sentence: picked.sentence,
        translation: picked.translation,
        lang: picked.lang,
        video,
        start: picked.start,
        end: picked.end,
      }, captureOptions());
      setSaved(true);
    } catch (e) {
      toast(String(e), 5000);
    }
  };

  const body = picked && (
    <div ref={isAndroid ? undefined : watchSize} className="flex min-h-0 flex-1 flex-col">
      {/* On a phone, the header is also where the sheet is dragged closed. */}
      <div
        className={`flex items-start gap-2 border-b border-ink-700 ${isAndroid ? "px-5 pt-1 pb-3" : "px-4 py-3"}`}
        data-sheet-drag
      >
        <div className="min-w-0 flex-1">
          <div className={`font-semibold break-words ${isAndroid ? "text-2xl" : "text-xl"}`} dir="auto">
            {lookup?.word ?? picked.word}
          </div>
          {lookup?.matched && lookup.matched !== lookup.word.toLowerCase() && (
            <div className="text-xs text-zinc-400" dir="ltr">
              → {lookup.matched}
            </div>
          )}
        </div>
        {isAndroid && (
          <Button
            icon="pi pi-times"
            rounded
            text
            severity="secondary"
            aria-label={t("close")}
            className="-me-2 h-10 w-10 shrink-0"
            onClick={closeSheet}
          />
        )}
      </div>

      <div
        className={`overflow-y-auto overscroll-contain ${isAndroid ? "min-h-0 flex-1 px-5 py-4" : "max-h-[min(18rem,calc(100dvh-12rem))] px-4 py-3"}`}
      >
        {state.kind === "loading" && <i className="pi pi-spin pi-spinner text-zinc-400" />}
        {state.kind === "error" && <p className="text-sm text-amber-300">{state.message}</p>}
        {state.kind === "missing" && <DictionaryInstallCard />}
        {lookup && lookup.entries.length === 0 && <p className="text-sm text-zinc-400">{t("noMatch")}</p>}
        {lookup && lookup.entries.length > 0 && (
          <ul className={`flex flex-col ${isAndroid ? "gap-4" : "gap-3"}`}>
            {lookup.entries.map((e, i) => (
              <li key={i} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span
                    className={showsPersian ? "text-2xl font-semibold text-accent" : "text-lg font-semibold"}
                    dir={showsPersian ? "rtl" : "auto"}
                    lang={showsPersian ? "fa" : undefined}
                  >
                    {showsPersian ? e.fa : e.glosses[0]}
                  </span>
                  <Tag value={posLabel(e.pos)} severity="secondary" className="text-[0.65rem]" />
                </div>
                <div className="text-sm text-zinc-400" dir="ltr">
                  {e.roman && <span className="me-2 italic text-zinc-500">{e.roman}</span>}
                  {(showsPersian ? e.glosses : e.glosses.slice(1)).slice(0, 3).join(" · ")}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={`flex items-center gap-3 border-t border-ink-700 ${isAndroid ? "px-5 py-3" : "px-4 py-2"}`}>
        <span className="flex-1 text-[0.7rem] text-zinc-500">{t("dictionarySource")}</span>
        <Button
          icon={saved ? "pi pi-check" : "pi pi-bookmark"}
          label={saved ? t("saved") : t("saveWord")}
          size={isAndroid ? undefined : "small"}
          severity={saved ? "success" : undefined}
          disabled={saved || state.kind === "loading"}
          onClick={() => void save()}
        />
      </div>
    </div>
  );

  // A phone gets a sheet from the screen's edge instead: a popup next to a
  // fingertip-sized word sits under the finger and leaves little room.
  if (isAndroid) {
    return (
      <WordSheet open={sheetOpen} onClose={closeSheet}>
        {body}
      </WordSheet>
    );
  }

  return (
    <OverlayPanel ref={panel} transitionOptions={popupMotions.overlayPanel} onHide={onHide} className="w-[min(22rem,90vw)]" pt={{ content: { className: "p-0" } }}>
      {body}
    </OverlayPanel>
  );
}
