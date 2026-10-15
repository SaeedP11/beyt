import { Button } from "primereact/button";
import { Checkbox } from "primereact/checkbox";
import { Dialog } from "primereact/dialog";
import { useEffect, useState } from "react";

import { api } from "../api";
import { getLang, t } from "../i18n";
import { useDialogMotion } from "../motion";
import type { Folder, FolderEntry } from "../types";
import { PathBar } from "./Library";

interface Props {
  /** Folder to start in (the video's); the browser shows while this is set. */
  start: string | null;
  /** One file to add, or several to compare. */
  multiple: boolean;
  onPick: (paths: string[]) => void;
  onHide: () => void;
}

type State = { phase: "loading" } | { phase: "ready"; folder: Folder } | { phase: "error"; message: string };

/** Picks subtitle files by browsing the phone's storage. Android's own file
 *  picker returns content:// links, which Beyt can't read or match by path. */
export function SubtitleBrowser({ start, multiple, onPick, onHide }: Props) {
  const motion = useDialogMotion();
  const [state, setState] = useState<State>({ phase: "loading" });
  const [picked, setPicked] = useState<string[]>([]);

  const show = async (path: string) => {
    setState((s) => (s.phase === "ready" ? s : { phase: "loading" }));
    try {
      setState({ phase: "ready", folder: await api.listSubtitleFolder(path) });
    } catch (e) {
      setState({ phase: "error", message: String(e) });
    }
  };

  useEffect(() => {
    if (start === null) return;
    setPicked([]);
    setState({ phase: "loading" });
    void show(start);
  }, [start]);

  const folder = state.phase === "ready" ? state.folder : null;
  const dirs = folder?.entries.filter((e) => e.isDir) ?? [];
  const files = folder?.entries.filter((e) => !e.isDir) ?? [];
  const allPicked = files.length > 0 && files.every((f) => picked.includes(f.path));

  const toggle = (path: string) =>
    setPicked((p) => (p.includes(path) ? p.filter((x) => x !== path) : [...p, path]));
  const toggleAll = () =>
    setPicked((p) =>
      allPicked ? p.filter((x) => !files.some((f) => f.path === x)) : [...new Set([...p, ...files.map((f) => f.path)])],
    );
  const choose = (entry: FolderEntry) => (multiple ? toggle(entry.path) : onPick([entry.path]));

  const footer = multiple ? (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-zinc-400">{t("filesPicked", { n: picked.length })}</span>
      <Button
        label={t("compareFiles")}
        icon="pi pi-sort-amount-down"
        disabled={picked.length === 0}
        onClick={() => onPick(picked)}
      />
    </div>
  ) : undefined;

  return (
    <Dialog
      header={multiple ? t("pickSubtitlesToCompare") : t("pickSubtitle")}
      visible={start !== null}
      onHide={onHide}
      className="h-[min(40rem,90dvh)] w-[min(36rem,95vw)]"
      contentClassName="flex flex-col gap-3"
      dismissableMask
      draggable={false}
      resizable={false}
      {...motion}
      footer={footer}
    >
      {folder && <PathBar folder={folder} onOpen={(p) => void show(p)} />}

      {state.phase === "loading" && (
        <div className="grid flex-1 place-items-center">
          <i className="pi pi-spin pi-spinner text-2xl text-zinc-500" />
        </div>
      )}

      {state.phase === "error" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <i className="pi pi-exclamation-circle text-3xl text-red-400" />
          <p>{t("folderUnreadable")}</p>
          <p className="max-w-full break-words text-xs text-zinc-500" dir="ltr">
            {state.message}
          </p>
        </div>
      )}

      {folder && dirs.length === 0 && files.length === 0 && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-zinc-400">
          <i className="pi pi-folder-open text-3xl text-zinc-600" />
          <p>{t("noSubtitlesHere")}</p>
        </div>
      )}

      {folder && (dirs.length > 0 || files.length > 0) && (
        <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain px-1">
          {multiple && files.length > 1 && (
            <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm text-zinc-400">
              <Checkbox checked={allPicked} onChange={toggleAll} />
              <span>{t("selectAll")}</span>
            </label>
          )}
          {files.map((f) => (
            <Row key={f.path} entry={f} icon="pi-file" onClick={() => choose(f)}>
              {multiple && <Checkbox checked={picked.includes(f.path)} className="pointer-events-none shrink-0" />}
            </Row>
          ))}
          {dirs.map((d) => (
            <Row key={d.path} entry={d} icon="pi-folder" onClick={() => void show(d.path)}>
              <i className="pi pi-angle-right text-xs text-zinc-600 rtl:rotate-180" />
            </Row>
          ))}
        </div>
      )}
    </Dialog>
  );
}

interface RowProps {
  entry: FolderEntry;
  icon: string;
  onClick: () => void;
  children?: React.ReactNode;
}

function Row({ entry, icon, onClick, children }: RowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={entry.path}
      className="flex min-h-12 w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-start transition hover:bg-ink-850 focus-visible:outline-2 focus-visible:outline-accent active:bg-ink-800"
    >
      <i className={`pi ${icon} shrink-0 ${icon === "pi-folder" ? "text-accent" : "text-zinc-400"}`} />
      <span
        className={`min-w-0 flex-1 break-words text-sm ${getLang() === "fa" ? "text-right" : "text-left"}`}
        dir="auto"
      >
        {entry.name}
      </span>
      {children}
    </button>
  );
}
