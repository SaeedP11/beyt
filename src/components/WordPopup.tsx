import { Button } from "primereact/button";
import { OverlayPanel } from "primereact/overlaypanel";
import { Sidebar } from "primereact/sidebar";
import { Tag } from "primereact/tag";
import { type Ref, useCallback, useImperativeHandle, useRef, useState } from "react";

import { api } from "../api";
import * as clock from "../clock";
import { popupMotions, usePanelMotion } from "../motion";
import { captureOptions } from "../player";
import { getSettings } from "../settings";
import { sheetEdge, useSheetEdge } from "../sheet";
import { player } from "../hooks";
import { type StringKey, t } from "../i18n";
import type { Lookup, PickedWord } from "../types";
import { toast } from "../ui";

export interface WordPopupHandle {
  /** `event` may be a native one: the right-click menu opens the popup too. */
  open: (event: React.MouseEvent | MouseEvent, target: HTMLElement, picked: PickedWord) => void;
}

type State =
  | { kind: "loading" }
  | { kind: "done"; lookup: Lookup }
  | { kind: "error"; message: string };

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

/** Dictionary popup for a clicked subtitle word, or a sheet on small screens. Pauses while open. */
export function WordPopup({ ref }: { ref: Ref<WordPopupHandle> }) {
  const panel = useRef<OverlayPanel>(null);
  const edge = useSheetEdge();
  const sheetMotion = usePanelMotion(edge === "left" ? "left" : "right");
  const [sheetOpen, setSheetOpen] = useState(false);
  const target = useRef<HTMLElement | null>(null);
  const resumeOnClose = useRef(false);
  const [picked, setPicked] = useState<PickedWord | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [saved, setSaved] = useState(false);

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
      setPicked(word);
      setState({ kind: "loading" });
      setSaved(false);
      if (sheetEdge()) {
        setSheetOpen(true);
      } else {
        panel.current?.show(event as unknown as React.SyntheticEvent, el);
        // Already open on another word: PrimeReact just re-aligned it below.
        reposition();
      }
      api.lookupWord(word.word, word.lang).then(
        (lookup) => setState({ kind: "done", lookup }),
        (e) => setState({ kind: "error", message: String(e) }),
      );
    },
  }));

  const onHide = () => {
    setSheetOpen(false);
    target.current?.classList.remove("picked");
    target.current = null;
    if (resumeOnClose.current) {
      resumeOnClose.current = false;
      void api.setPause(false);
    }
  };

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

  const title = (
    <div>
      <div className="text-xl font-semibold" dir="auto">
        {lookup?.word ?? picked?.word}
      </div>
      {lookup?.matched && lookup.matched !== lookup.word.toLowerCase() && (
        <div className="text-xs text-zinc-400" dir="ltr">
          → {lookup.matched}
        </div>
      )}
    </div>
  );

  const entries = (
    <>
      {state.kind === "loading" && <i className="pi pi-spin pi-spinner text-zinc-400" />}
      {state.kind === "error" && <p className="text-sm text-amber-300">{state.message}</p>}
      {lookup && lookup.entries.length === 0 && <p className="text-sm text-zinc-400">{t("noMatch")}</p>}
      {lookup && lookup.entries.length > 0 && (
        <ul className="flex flex-col gap-3">
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
    </>
  );

  const saveButton = (
    <Button
      icon={saved ? "pi pi-check" : "pi pi-bookmark"}
      label={saved ? t("saved") : t("saveWord")}
      size={edge ? undefined : "small"}
      severity={saved ? "success" : undefined}
      disabled={saved || state.kind === "loading"}
      onClick={() => void save()}
    />
  );

  return (
    <>
      <OverlayPanel ref={panel} transitionOptions={popupMotions.overlayPanel} onHide={onHide} className="w-[min(22rem,90vw)]" pt={{ content: { className: "p-0" } }}>
        {picked && (
          <div ref={watchSize} className="flex flex-col">
            <div className="border-b border-ink-700 px-4 py-3">{title}</div>
            <div className="max-h-72 overflow-y-auto px-4 py-3">{entries}</div>
            <div className="flex items-center gap-3 border-t border-ink-700 px-4 py-2">
              <span className="flex-1 text-[0.7rem] text-zinc-500">{t("dictionarySource")}</span>
              {saveButton}
            </div>
          </div>
        )}
      </OverlayPanel>
      {(edge || sheetOpen) && (
        <Sidebar visible={sheetOpen} onHide={onHide} {...sheetMotion} header={title} pt={{ content: { className: "p-0" } }}>
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto border-t border-ink-700 px-5 py-4">{entries}</div>
            <div className="flex flex-col gap-2 border-t border-ink-700 px-5 py-3">
              {saveButton}
              <span className="text-center text-[0.7rem] text-zinc-500">{t("dictionarySource")}</span>
            </div>
          </div>
        </Sidebar>
      )}
    </>
  );
}
