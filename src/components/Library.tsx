import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "primereact/button";
import { Checkbox } from "primereact/checkbox";
import { ContextMenu } from "primereact/contextmenu";
import { Dialog } from "primereact/dialog";
import { Menu } from "primereact/menu";
import type { MenuItem, MenuItemOptions } from "primereact/menuitem";
import { TabPanel, TabView } from "primereact/tabview";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { api } from "../api";
import { getLang, t } from "../i18n";
import { popupMotions, useDialogMotion } from "../motion";
import type { Folder, FolderEntry, Recent } from "../types";
import { toast } from "../ui";
import { VocabularyView } from "./VocabularyView";

const VIDEO_EXTENSIONS = ["mkv", "mp4", "m4v", "webm", "avi", "mov", "ts", "m2ts", "wmv", "flv", "ogv"];
const WATCHED = 0.92;
/** How long Undo is offered before a removal or move to the Trash happens. */
const UNDO_MS = 6000;

/** A video in the library, from Continue watching or the open folder. */
interface Video {
  path: string;
  /** File name with its extension. */
  name: string;
  /** Watched fraction, 0 to 1. */
  fraction: number;
  /** Seconds still to watch, if known. */
  left: number | null;
  /** Where the thumbnail frame comes from; null picks one near the start. */
  at: number | null;
  recent: boolean;
}

function fromRecent(r: Recent): Video {
  const fraction = r.duration > 0 ? r.position / r.duration : 0;
  return {
    path: r.path,
    name: baseName(r.path),
    fraction,
    left: r.duration > 0 ? r.duration - r.position : null,
    at: fraction >= WATCHED ? null : r.position,
    recent: true,
  };
}

function fromEntry(e: FolderEntry): Video {
  const fraction = e.duration ? (e.position ?? 0) / e.duration : 0;
  return {
    path: e.path,
    name: e.name,
    fraction,
    left: e.duration ? e.duration - (e.position ?? 0) : null,
    at: fraction > 0 && fraction < WATCHED ? (e.position ?? null) : null,
    recent: false,
  };
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** "Movie.fa.mkv" → ["Movie.fa", ".mkv"]; a leading dot isn't an extension. */
function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

function progressLabel(v: Video): string | null {
  if (v.fraction >= WATCHED) return t("watched");
  if (v.fraction > 0 && v.left !== null) return t("minutesLeft", { n: Math.max(1, Math.round(v.left / 60)) });
  return null;
}

// ---------- thumbnails ----------

/** Thumbnails made this session, by path and moment. */
const thumbs = new Map<string, Promise<string | null>>();
/** ffmpeg runs at once; more would slow the first cards down. */
const MAX_JOBS = 2;
let jobs = 0;
const waiting: (() => void)[] = [];

function thumbnailUrl(path: string, at: number | null): Promise<string | null> {
  // Same five-second steps as the cache on disk.
  const key = `${path}\n${at === null ? "" : Math.floor(at / 5)}`;
  let url = thumbs.get(key);
  if (!url) {
    url = new Promise<void>((start) => {
      if (jobs < MAX_JOBS) {
        jobs++;
        start();
      } else {
        waiting.push(start);
      }
    })
      .then(() => api.thumbnail(path, at))
      .then(
        (file) => convertFileSrc(file),
        () => null,
      )
      .finally(() => {
        // Hand the slot to the next one in line, or free it.
        const next = waiting.shift();
        if (next) next();
        else jobs--;
      });
    thumbs.set(key, url);
  }
  return url;
}

function useThumbnail(path: string, at: number | null): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    void thumbnailUrl(path, at).then((s) => live && setSrc(s));
    return () => {
      live = false;
    };
  }, [path, at]);
  return src;
}

function Thumbnail({ video, small, children }: { video: Video; small?: boolean; children?: React.ReactNode }) {
  const src = useThumbnail(video.path, video.at);
  const watched = video.fraction >= WATCHED;
  return (
    <div className={`relative aspect-video shrink-0 overflow-hidden bg-ink-800 ${small ? "w-28 rounded-md" : "w-full rounded-xl"}`}>
      {src ? (
        <img src={src} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <i className={`pi pi-video text-zinc-600 ${small ? "" : "text-2xl"}`} />
        </div>
      )}
      {watched && <div className="absolute inset-0 bg-ink-950/50" />}
      {children}
      {video.fraction > 0 && !watched && (
        <div className={`absolute inset-x-0 bottom-0 bg-white/20 ${small ? "h-[3px]" : "h-1"}`}>
          <div className="h-full bg-accent" style={{ width: `${video.fraction * 100}%` }} />
        </div>
      )}
    </div>
  );
}

// ---------- the actions menu ----------

/** A menu row laid out like the app's right-click menu, with an optional key hint. */
function menuRow(label: string, icon: string, keys: string | undefined, command: () => void, danger = false): MenuItem {
  return {
    label,
    command,
    template: (_item: MenuItem, o: MenuItemOptions) => (
      <a className={`${o.className} gap-3 ${danger ? "text-red-400!" : ""}`}>
        <span className={`${o.iconClassName} m-0! w-4 shrink-0 ${icon} ${danger ? "text-red-400!" : ""}`} />
        <span className={`${o.labelClassName} flex-1 ${danger ? "text-red-400!" : ""}`}>{label}</span>
        {keys && (
          <span className="ps-6 text-xs text-zinc-500" dir="ltr">
            {keys}
          </span>
        )}
      </a>
    ),
  };
}

// ---------- the library ----------

interface Props {
  folder: string | null;
  onPlay: (path: string) => void;
  onHelp: () => void;
  onSettings: () => void;
}

export function Library({ folder: initialFolder, onPlay, onHelp, onSettings }: Props) {
  const [recent, setRecent] = useState<Recent[]>([]);
  const [folder, setFolder] = useState<Folder | null>(null);
  /** Videos waiting out their Undo before they are removed. */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [trashing, setTrashing] = useState<Video | null>(null);
  const [menuModel, setMenuModel] = useState<MenuItem[]>([]);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menu = useRef<Menu>(null);
  const contextMenu = useRef<ContextMenu>(null);
  const folderPath = useRef<string | null>(null);
  const pending = useRef(new Map<string, { timer: number; finish: () => Promise<void> }>());

  const showFolder = useCallback(async (path: string) => {
    try {
      setFolder(await api.listFolder(path));
      folderPath.current = path;
    } catch (e) {
      toast(String(e), 5000);
    }
  }, []);

  const reload = useCallback(async () => {
    try {
      setRecent(await api.recentFiles());
      if (folderPath.current) setFolder(await api.listFolder(folderPath.current));
    } catch (e) {
      toast(String(e), 5000);
    }
  }, []);

  useEffect(() => {
    void api.recentFiles().then(setRecent, (e) => toast(String(e), 5000));
    if (initialFolder) void showFolder(initialFolder);
  }, [initialFolder, showFolder]);

  const setShown = (path: string, shown: boolean) =>
    setHidden((h) => {
      const next = new Set(h);
      if (shown) next.delete(path);
      else next.add(path);
      return next;
    });

  /**
   * Hides `key` at once and runs `commit` once Undo has had its chance. The
   * key is a video's path (hidden everywhere) or `recent:` and its path
   * (hidden from Continue watching only).
   */
  const deferred = (key: string, message: string, commit: () => Promise<void>) => {
    setShown(key, false);
    const finish = async () => {
      pending.current.delete(key);
      try {
        await commit();
        await reload();
      } catch (e) {
        toast(String(e), 5000);
      }
      setShown(key, true);
    };
    const timer = window.setTimeout(() => void finish(), UNDO_MS);
    pending.current.set(key, { timer, finish });
    toast(message, UNDO_MS, {
      label: t("undo"),
      run: () => {
        clearTimeout(timer);
        pending.current.delete(key);
        setShown(key, true);
      },
    });
  };

  // Leaving the library (to play something) doesn't cancel what's pending.
  useEffect(() => {
    const all = pending.current;
    return () => {
      for (const p of all.values()) {
        clearTimeout(p.timer);
        void p.finish();
      }
    };
  }, []);

  const removeRecent = (v: Video) =>
    deferred(`recent:${v.path}`, t("removedRecent", { name: splitName(v.name)[0] }), () => api.forgetRecent(v.path));

  const trash = (v: Video, subtitles: boolean) => {
    setTrashing(null);
    deferred(v.path, t("trashed", { name: splitName(v.name)[0] }), () => api.trashVideo(v.path, subtitles));
  };

  /** Returns an error to show, or null once renamed. */
  const rename = async (v: Video, stem: string): Promise<string | null> => {
    const name = stem.trim();
    if (!name || name.includes("/")) return t("nameInvalid");
    try {
      await api.renameVideo(v.path, name);
    } catch (e) {
      return String(e) === "name-taken" ? t("nameTaken") : String(e);
    }
    setRenaming(null);
    toast(t("renamed", { name }));
    await reload();
    return null;
  };

  // After the menu has closed, so it doesn't take the focus back from the field.
  const startRename = (v: Video) => setTimeout(() => setRenaming(v.path));

  const actions = (v: Video): MenuItem[] => {
    const started = v.fraction > 0 && v.fraction < WATCHED;
    return [
      menuRow(started ? t("resume") : t("play"), "pi pi-play", undefined, () => onPlay(v.path)),
      menuRow(t("rename"), "pi pi-pencil", "F2", () => startRename(v)),
      menuRow(t("showInFolder"), "pi pi-folder-open", undefined, () => {
        api.showInFolder(v.path).catch((e) => toast(String(e), 5000));
      }),
      ...(v.recent ? [menuRow(t("removeRecent"), "pi pi-times", undefined, () => removeRecent(v))] : []),
      { separator: true },
      menuRow(t("moveToTrash"), "pi pi-trash", "Del", () => setTrashing(v), true),
    ];
  };

  const handlers: ItemHandlers = {
    onPlay,
    onMenu: (v, e, atPointer) => {
      setMenuModel(actions(v));
      setMenuFor(v.path);
      if (atPointer) contextMenu.current?.show(e);
      else menu.current?.show(e);
    },
    onKey: (v, e) => {
      if (e.key === "F2") startRename(v);
      else if (e.key === "Delete") setTrashing(v);
      else return;
      e.preventDefault();
    },
    onRename: rename,
    onCancelRename: () => setRenaming(null),
    onAskRename: startRename,
    onAskTrash: setTrashing,
    renaming,
    menuFor,
  };

  const pickFile = async () => {
    const path = await open({
      multiple: false,
      directory: false,
      defaultPath: folder?.path,
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
    if (typeof path === "string") onPlay(path);
  };

  const pickFolder = async () => {
    const path = await open({ multiple: false, directory: true, defaultPath: folder?.path });
    if (typeof path === "string") await showFolder(path);
  };

  const shownRecent = recent.filter((r) => !hidden.has(r.path) && !hidden.has(`recent:${r.path}`));
  const empty = !shownRecent.length && !folder;

  return (
    <main className="absolute inset-0 overflow-y-auto bg-ink-950">
      <div className="mx-auto max-w-6xl px-6 pb-16 pt-8 md:px-10">
        <header className="mb-10 flex flex-wrap items-center justify-between gap-6">
          <div className="flex items-baseline gap-4">
            <span className="font-sans text-5xl font-bold text-accent" lang="fa">
              بیت
            </span>
            <span className="text-zinc-400">{t("appTagline")}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button icon="pi pi-play" label={t("openFile")} onClick={() => void pickFile()} />
            <Button icon="pi pi-folder-open" label={t("openFolder")} outlined onClick={() => void pickFolder()} />
            <Button
              icon="pi pi-question-circle"
              rounded
              text
              severity="secondary"
              aria-label={t("shortcutsTitle")}
              tooltip={`${t("shortcutsTitle")} (?)`}
              tooltipOptions={{ position: "bottom" }}
              onClick={onHelp}
            />
            <Button
              icon="pi pi-cog"
              rounded
              text
              severity="secondary"
              aria-label={t("settings")}
              tooltip={`${t("settings")} (,)`}
              tooltipOptions={{ position: "bottom" }}
              onClick={onSettings}
            />
          </div>
        </header>

        <TabView className="beyt-tabs">
          <TabPanel header={t("libraryTab")} leftIcon="pi pi-home me-2">
            {empty && (
              <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-ink-600 px-6 py-20 text-center">
                <i className="pi pi-video text-5xl text-zinc-500" />
                <p className="text-lg text-zinc-300">{t("dropHint")}</p>
                <p className="text-sm text-zinc-500">{t("appTagline")}</p>
              </div>
            )}

            {shownRecent.length > 0 && (
              <section className="mb-12">
                <SectionTitle>{t("recent")}</SectionTitle>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-5 gap-y-6">
                  {shownRecent.map((r) => (
                    <RecentCard key={r.path} video={fromRecent(r)} {...handlers} />
                  ))}
                </div>
              </section>
            )}

            {folder && (
              <FolderView
                folder={folder}
                hidden={hidden}
                onOpen={(p) => void showFolder(p)}
                handlers={handlers}
              />
            )}
          </TabPanel>
          <TabPanel header={t("vocabulary")} leftIcon="pi pi-bookmark me-2">
            <VocabularyView />
          </TabPanel>
        </TabView>
      </div>

      <Menu
        ref={menu}
        model={menuModel}
        popup
        popupAlignment={getLang() === "fa" ? "left" : "right"}
        className="min-w-64"
        transitionOptions={popupMotions.connected}
        onHide={() => setMenuFor(null)}
      />
      <ContextMenu
        ref={contextMenu}
        model={menuModel}
        className="min-w-64"
        transitionOptions={popupMotions.contextMenu}
        onHide={() => setMenuFor(null)}
      />
      <TrashDialog video={trashing} onHide={() => setTrashing(null)} onConfirm={trash} />
    </main>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-4 text-sm font-semibold tracking-wide text-zinc-400">{children}</h2>;
}

interface ItemHandlers {
  onPlay: (path: string) => void;
  /** Opens the actions menu under the ⋯ button, or at the pointer on right-click. */
  onMenu: (v: Video, e: React.MouseEvent, atPointer: boolean) => void;
  /** F2 renames and Delete trashes the focused item. */
  onKey: (v: Video, e: React.KeyboardEvent) => void;
  onRename: (v: Video, stem: string) => Promise<string | null>;
  onCancelRename: () => void;
  onAskRename: (v: Video) => void;
  onAskTrash: (v: Video) => void;
  renaming: string | null;
  /** The item whose menu is open, which keeps its buttons showing. */
  menuFor: string | null;
}

function MoreButton({ video, onMenu, className = "" }: { video: Video; onMenu: ItemHandlers["onMenu"]; className?: string }) {
  return (
    <Button
      icon="pi pi-ellipsis-h"
      rounded
      text
      severity="secondary"
      aria-label={t("moreActions")}
      aria-haspopup="menu"
      className={`size-9! shrink-0 ${className}`}
      onClick={(e) => {
        e.stopPropagation();
        onMenu(video, e, false);
      }}
    />
  );
}

function RecentCard({ video, ...h }: { video: Video } & ItemHandlers) {
  const label = progressLabel(video);
  const [stem] = splitName(video.name);
  const folder = video.path.split("/").slice(-2, -1)[0] ?? "";
  const active = h.menuFor === video.path;

  return (
    <article
      title={video.path}
      className="group relative flex flex-col gap-3"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        h.onMenu(video, e, true);
      }}
      onKeyDown={(e) => h.renaming !== video.path && h.onKey(video, e)}
    >
      <button
        type="button"
        onClick={() => h.onPlay(video.path)}
        aria-label={`${t("play")}: ${stem}`}
        className={`block rounded-xl text-start transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
          active ? "-translate-y-0.5" : "hover:-translate-y-0.5"
        }`}
      >
        <div
          className={`overflow-hidden rounded-xl border transition ${
            active ? "border-accent/60 shadow-lg shadow-black/40" : "border-ink-700 group-hover:border-accent/60 group-hover:shadow-lg group-hover:shadow-black/40"
          }`}
        >
          <Thumbnail video={video}>
            <div
              className={`absolute inset-0 grid place-items-center bg-ink-950/35 transition ${
                active ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              }`}
            >
              <span className="grid size-12 place-items-center rounded-full bg-accent text-ink-950">
                <i className="pi pi-play ms-0.5" />
              </span>
            </div>
            {label && (
              <span className="absolute end-2 top-2 rounded-md bg-ink-950/80 px-1.5 py-0.5 text-xs font-medium text-zinc-200">
                {label}
              </span>
            )}
          </Thumbnail>
        </div>
      </button>

      {h.renaming === video.path ? (
        <RenameField video={video} onSubmit={(s) => h.onRename(video, s)} onCancel={h.onCancelRename} />
      ) : (
        <div className="flex items-start gap-2">
          <button type="button" onClick={() => h.onPlay(video.path)} tabIndex={-1} className="min-w-0 flex-1 text-start">
            <span className={`block truncate font-semibold ${video.fraction >= WATCHED ? "text-zinc-400" : ""}`} dir="auto">
              {stem}
            </span>
            <span className="block truncate text-sm text-zinc-400" dir="auto">
              {folder}
            </span>
          </button>
          <MoreButton
            video={video}
            onMenu={h.onMenu}
            className={`-mt-1 -me-2 transition ${active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
          />
        </div>
      )}
    </article>
  );
}

interface FolderProps {
  folder: Folder;
  hidden: ReadonlySet<string>;
  onOpen: (path: string) => void;
  handlers: ItemHandlers;
}

function FolderView({ folder, hidden, onOpen, handlers }: FolderProps) {
  const entries = folder.entries.filter((e) => !hidden.has(e.path));
  return (
    <section>
      <div className="mb-4 flex items-center gap-3">
        <SectionTitle>{t("folder")}</SectionTitle>
        <span className="mb-4 truncate text-xs text-zinc-500" dir="ltr">
          {folder.path}
        </span>
      </div>
      <ul className="divide-y divide-ink-700 overflow-hidden rounded-xl border border-ink-700 bg-ink-850">
        {folder.parent && (
          <li>
            <DirRow icon="pi pi-arrow-up" label={t("up")} muted onClick={() => onOpen(folder.parent!)} />
          </li>
        )}
        {entries.map((e) => (
          <li key={e.path}>
            {e.isDir ? (
              <DirRow icon="pi pi-folder" label={e.name} bold onClick={() => onOpen(e.path)} />
            ) : (
              <VideoRow video={fromEntry(e)} {...handlers} />
            )}
          </li>
        ))}
        {!entries.length && <li className="px-5 py-8 text-center text-zinc-500">{t("emptyFolder")}</li>}
      </ul>
    </section>
  );
}

function VideoRow({ video, ...h }: { video: Video } & ItemHandlers) {
  const label = progressLabel(video);
  const watched = video.fraction >= WATCHED;
  const active = h.menuFor === video.path;
  const editing = h.renaming === video.path;
  const reveal = active ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100";

  return (
    <div
      className={`group flex items-center gap-2 pe-3 transition hover:bg-ink-800 focus-within:bg-ink-800 ${active || editing ? "bg-ink-800" : ""}`}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        h.onMenu(video, e, true);
      }}
      onKeyDown={(e) => !editing && h.onKey(video, e)}
    >
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-4 px-5 py-2.5">
          <Thumbnail video={video} small />
          <div className="max-w-xl min-w-0 flex-1">
            <RenameField video={video} onSubmit={(s) => h.onRename(video, s)} onCancel={h.onCancelRename} />
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => h.onPlay(video.path)}
          className="flex min-w-0 flex-1 items-center gap-4 py-2.5 ps-5 text-start focus-visible:outline-none"
        >
          <Thumbnail video={video} small>
            <div className={`absolute inset-0 grid place-items-center bg-ink-950/35 transition ${reveal}`}>
              <span className="grid size-7 place-items-center rounded-full bg-accent text-ink-950">
                <i className="pi pi-play ms-px text-xs" />
              </span>
            </div>
          </Thumbnail>
          <span className="min-w-0 flex-1">
            <span className={`block truncate ${watched ? "text-zinc-400" : "font-medium"}`} dir="auto">
              {video.name}
            </span>
            {label && <span className="block text-sm text-zinc-400">{label}</span>}
          </span>
        </button>
      )}

      {!editing && (
        <div className={`flex shrink-0 items-center gap-0.5 transition ${reveal}`}>
          <Button
            icon="pi pi-pencil"
            rounded
            text
            severity="secondary"
            className="size-9!"
            aria-label={t("rename")}
            tooltip={`${t("rename")} (F2)`}
            tooltipOptions={{ position: "top" }}
            onClick={() => h.onAskRename(video)}
          />
          <Button
            icon="pi pi-trash"
            rounded
            text
            severity="secondary"
            className="size-9!"
            aria-label={t("moveToTrash")}
            tooltip={`${t("trashConfirm")} (Del)`}
            tooltipOptions={{ position: "top" }}
            onClick={() => h.onAskTrash(video)}
          />
          <MoreButton video={video} onMenu={h.onMenu} />
        </div>
      )}
    </div>
  );
}

interface DirRowProps {
  icon: string;
  label: string;
  bold?: boolean;
  muted?: boolean;
  onClick: () => void;
}

function DirRow({ icon, label, bold, muted, onClick }: DirRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-4 px-5 py-3 text-start transition hover:bg-ink-800 focus-visible:bg-ink-800 focus-visible:outline-none"
    >
      <i className={`${icon} ${muted ? "text-zinc-500" : "text-accent"}`} />
      <span className={`flex-1 truncate ${bold ? "font-semibold" : ""} ${muted ? "text-zinc-400" : ""}`} dir="auto">
        {label}
      </span>
    </button>
  );
}

// ---------- renaming and moving to the Trash ----------

interface RenameProps {
  video: Video;
  onSubmit: (stem: string) => Promise<string | null>;
  onCancel: () => void;
}

/** Edits the name in place; the extension stays as it is. */
function RenameField({ video, onSubmit, onCancel }: RenameProps) {
  const [stem, ext] = splitName(video.name);
  const [value, setValue] = useState(stem);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [subtitles, setSubtitles] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    api.videoSidecars(video.path).then((s) => setSubtitles(s.length), () => {});
  }, [video.path]);

  const save = async () => {
    if (value.trim() === stem) return onCancel();
    setBusy(true);
    const err = await onSubmit(value);
    setBusy(false);
    setError(err);
    if (err) input.current?.focus();
  };

  return (
    <div
      ref={box}
      className="flex min-w-0 flex-col gap-1.5"
      onBlur={(e) => {
        // Clicking away from an unchanged name just closes the field.
        if (!busy && value.trim() === stem && !box.current?.contains(e.relatedTarget)) onCancel();
      }}
    >
      <label htmlFor={id} className="sr-only">
        {t("fileNameLabel")}
      </label>
      <div
        className={`flex h-9 items-center rounded-lg border bg-ink-900 ring-3 ${
          error ? "border-red-400 ring-red-400/20" : "border-accent ring-accent/25"
        }`}
      >
        <input
          id={id}
          ref={input}
          value={value}
          dir="auto"
          disabled={busy}
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") void save();
            else if (e.key === "Escape") onCancel();
          }}
          className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-zinc-100 outline-none"
        />
        {ext && (
          <span dir="ltr" className="border-s border-ink-700 px-2.5 text-sm text-zinc-500">
            {ext}
          </span>
        )}
        <button
          type="button"
          aria-label={t("renameSave")}
          disabled={busy}
          onClick={() => void save()}
          className="grid size-8 shrink-0 place-items-center rounded-md text-accent hover:bg-ink-700"
        >
          <i className={busy ? "pi pi-spin pi-spinner" : "pi pi-check"} />
        </button>
        <button
          type="button"
          aria-label={t("cancel")}
          onClick={onCancel}
          className="me-0.5 grid size-8 shrink-0 place-items-center rounded-md text-zinc-400 hover:bg-ink-700"
        >
          <i className="pi pi-times" />
        </button>
      </div>
      <p id={`${id}-hint`} role={error ? "alert" : undefined} className={`text-xs ${error ? "text-red-300" : "text-zinc-400"}`}>
        {error ?? (subtitles ? `${t("renameHint")} · ${t("renameSubs")}` : t("renameHint"))}
      </p>
    </div>
  );
}

interface TrashProps {
  video: Video | null;
  onHide: () => void;
  onConfirm: (v: Video, subtitles: boolean) => void;
}

function TrashDialog({ video, onHide, onConfirm }: TrashProps) {
  const motion = useDialogMotion();
  const [subtitles, setSubtitles] = useState<string[]>([]);
  const [withSubtitles, setWithSubtitles] = useState(true);
  // Kept while the dialog animates closed.
  const [shown, setShown] = useState<Video | null>(null);
  const id = useId();

  useEffect(() => {
    if (!video) return;
    setShown(video);
    setWithSubtitles(true);
    setSubtitles([]);
    api.videoSidecars(video.path).then(setSubtitles, () => {});
  }, [video]);

  const footer = shown && (
    <div className="flex justify-end gap-2">
      <Button label={t("cancel")} outlined severity="secondary" onClick={onHide} />
      <Button
        label={t("trashConfirm")}
        icon="pi pi-trash"
        severity="danger"
        autoFocus
        onClick={() => onConfirm(shown, withSubtitles && subtitles.length > 0)}
      />
    </div>
  );

  return (
    <Dialog
      header={t("trashTitle")}
      visible={video !== null}
      onHide={onHide}
      footer={footer}
      className="w-[min(30rem,95vw)]"
      dismissableMask
      draggable={false}
      {...motion}
    >
      {shown && (
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-4">
            <Thumbnail video={shown} small />
            <span className="min-w-0 truncate font-medium" dir="auto">
              {shown.name}
            </span>
          </div>
          <p className="m-0 text-sm leading-relaxed text-zinc-400">{t("trashBody")}</p>
          {subtitles.length > 0 && (
            <div className="flex items-start gap-3">
              <Checkbox inputId={id} checked={withSubtitles} onChange={(e) => setWithSubtitles(!!e.checked)} />
              <label htmlFor={id} className="min-w-0 cursor-pointer text-sm">
                {t("trashSubs", { n: subtitles.length })}
                <span className="mt-0.5 block truncate text-xs text-zinc-500" dir="ltr">
                  {subtitles.map(baseName).join(", ")}
                </span>
              </label>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
