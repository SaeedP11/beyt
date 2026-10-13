import { convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Button } from "primereact/button";
import { ConfirmPopup, confirmPopup } from "primereact/confirmpopup";
import { Tag } from "primereact/tag";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api";
import { t } from "../i18n";
import { popupMotions } from "../motion";
import { getSettings } from "../settings";
import type { VocabItem } from "../types";
import { toast } from "../ui";

/** The sentence with the saved word highlighted. */
function Highlighted({ text, word }: { text: string; word: string | null }) {
  const i = word ? text.toLowerCase().indexOf(word.toLowerCase()) : -1;
  if (!word || i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded bg-accent/25 px-0.5 text-inherit">{text.slice(i, i + word.length)}</mark>
      {text.slice(i + word.length)}
    </>
  );
}

export function VocabularyView({ onCount }: { onCount?: (n: number) => void }) {
  const [items, setItems] = useState<VocabItem[]>([]);
  const [mediaDir, setMediaDir] = useState("");
  const [busy, setBusy] = useState<"anki" | "csv" | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await api.listVocab();
      setItems(list);
      onCount?.(list.length);
    } catch (e) {
      toast(String(e), 5000);
    }
  }, [onCount]);

  useEffect(() => {
    void api.vocabMediaDir().then(setMediaDir);
    void reload();
  }, [reload]);

  const src = (name: string) => convertFileSrc(`${mediaDir}/${name}`);

  const play = (name: string) => {
    audio.current?.pause();
    audio.current = new Audio(src(name));
    void audio.current.play();
  };

  const remove = (event: React.MouseEvent<HTMLButtonElement>, item: VocabItem) =>
    confirmPopup({
      transitionOptions: popupMotions.connected,
      target: event.currentTarget,
      message: `${t("delete")}?`,
      icon: "pi pi-trash",
      acceptClassName: "p-button-danger",
      accept: async () => {
        await api.deleteVocab(item.id);
        await reload();
      },
    });

  const sendToAnki = async () => {
    setBusy("anki");
    try {
      const { ankiUrl, ankiDeck } = getSettings();
      const r = await api.exportAnki({ url: ankiUrl, deck: ankiDeck });
      toast(t("ankiResult", { added: r.added.length, skipped: r.skipped }), 4000);
      await reload();
    } catch (e) {
      toast(String(e), 6000);
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = async () => {
    const path = await save({ defaultPath: "beyt-vocabulary.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    setBusy("csv");
    try {
      const media = await api.exportCsv(path);
      toast(t("csvDone", { path: media }), 8000);
    } catch (e) {
      toast(String(e), 6000);
    } finally {
      setBusy(null);
    }
  };

  if (!items.length) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-ink-600 px-6 py-20 text-center">
        <i className="pi pi-bookmark text-5xl text-zinc-500" />
        <p className="max-w-md text-zinc-300">{t("vocabEmpty")}</p>
      </div>
    );
  }

  return (
    <section>
      <ConfirmPopup />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="flex-1 text-sm text-zinc-400">
          {items.length} · {items.filter((i) => i.exported).length} {t("inAnki")}
        </span>
        <Button icon="pi pi-send" label={t("sendToAnki")} loading={busy === "anki"} onClick={() => void sendToAnki()} />
        <Button icon="pi pi-download" label={t("exportCsv")} outlined loading={busy === "csv"} onClick={() => void exportCsv()} />
      </div>

      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.id} className="flex gap-4 rounded-xl border border-ink-700 bg-ink-850 p-3">
            {item.screenshot ? (
              <img src={src(item.screenshot)} alt="" className="aspect-video w-36 shrink-0 rounded-lg object-cover" />
            ) : (
              <div className="grid aspect-video w-36 shrink-0 place-items-center rounded-lg bg-ink-800">
                <i className="pi pi-image text-zinc-600" />
              </div>
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                {item.word && (
                  <span className="text-lg font-semibold" dir="auto">
                    {item.word}
                  </span>
                )}
                {item.meaning && (
                  <span className="text-lg text-accent" dir="auto">
                    {item.meaning}
                  </span>
                )}
                {item.exported && <Tag value={t("inAnki")} severity="success" className="text-[0.65rem]" />}
              </div>
              <p className="text-zinc-200" dir="auto">
                <Highlighted text={item.sentence} word={item.word} />
              </p>
              {item.translation && (
                <p className="text-sm text-zinc-400" dir="auto">
                  {item.translation}
                </p>
              )}
            </div>
            <div className="flex shrink-0 flex-col gap-1">
              {item.audio && (
                <Button
                  icon="pi pi-volume-up"
                  rounded
                  text
                  aria-label={t("playClip")}
                  tooltip={t("playClip")}
                  onClick={() => play(item.audio!)}
                />
              )}
              <Button
                icon="pi pi-trash"
                rounded
                text
                severity="danger"
                aria-label={t("delete")}
                onClick={(e) => remove(e, item)}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
