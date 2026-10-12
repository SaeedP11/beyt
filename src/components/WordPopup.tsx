import { Button } from "primereact/button";
import { OverlayPanel } from "primereact/overlaypanel";
import { Tag } from "primereact/tag";
import { type Ref, useImperativeHandle, useRef, useState } from "react";

import { api } from "../api";
import * as clock from "../clock";
import { captureOptions } from "../player";
import { getSettings } from "../settings";
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

function posLabel(pos: string): string {
  const key = `pos_${pos}` as StringKey;
  const label = t(key);
  return label === key ? pos : label;
}

/** Dictionary popup for a clicked subtitle word. Pauses while open. */
export function WordPopup({ ref }: { ref: Ref<WordPopupHandle> }) {
  const panel = useRef<OverlayPanel>(null);
  const target = useRef<HTMLElement | null>(null);
  const resumeOnClose = useRef(false);
  const [picked, setPicked] = useState<PickedWord | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [saved, setSaved] = useState(false);

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
      panel.current?.show(event as unknown as React.SyntheticEvent, el);
      api.lookupWord(word.word, word.lang).then(
        (lookup) => setState({ kind: "done", lookup }),
        (e) => setState({ kind: "error", message: String(e) }),
      );
    },
  }));

  const onHide = () => {
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

  return (
    <OverlayPanel ref={panel} onHide={onHide} className="w-[min(22rem,90vw)]" pt={{ content: { className: "p-0" } }}>
      {picked && (
        <div className="flex flex-col">
          <div className="border-b border-ink-700 px-4 py-3">
            <div className="text-xl font-semibold" dir="auto">
              {lookup?.word ?? picked.word}
            </div>
            {lookup?.matched && lookup.matched !== lookup.word.toLowerCase() && (
              <div className="text-xs text-zinc-400" dir="ltr">
                → {lookup.matched}
              </div>
            )}
          </div>

          <div className="max-h-72 overflow-y-auto px-4 py-3">
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
          </div>

          <div className="flex items-center gap-3 border-t border-ink-700 px-4 py-2">
            <span className="flex-1 text-[0.7rem] text-zinc-500">{t("dictionarySource")}</span>
            <Button
              icon={saved ? "pi pi-check" : "pi pi-bookmark"}
              label={saved ? t("saved") : t("saveWord")}
              size="small"
              severity={saved ? "success" : undefined}
              disabled={saved || state.kind === "loading"}
              onClick={() => void save()}
            />
          </div>
        </div>
      )}
    </OverlayPanel>
  );
}
