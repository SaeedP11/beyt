import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "primereact/button";
import { Checkbox } from "primereact/checkbox";
import { ContextMenu } from "primereact/contextmenu";
import { Dialog } from "primereact/dialog";
import type { MenuItem, MenuItemOptions } from "primereact/menuitem";
import { TabPanel, TabView } from "primereact/tabview";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { api, isAndroid } from "../api";
import { useHardKeyboard } from "../hooks";
import { getLang, t } from "../i18n";
import { popupMotions, slideIn, useDialogMotion } from "../motion";
import { sheetEdge } from "../sheet";
import type { Folder, FolderEntry, Recent } from "../types";
import { toast } from "../ui";
import { PopupMenu, type PopupMenuHandle } from "./SheetMenu";
import { VocabularyView } from "./VocabularyView";

const VIDEO_EXTENSIONS = ["mkv", "mp4", "m4v", "webm", "avi", "mov", "ts", "m2ts", "wmv", "flv", "ogv"];
const WATCHED = 0.92;
/** How long Undo is offered before a removal or move to the Trash happens. */
const UNDO_MS = 6000;
/** The library's tabs, in order. Continue watching opens first. */
const TAB_RECENT = 0;
const TAB_FOLDER = 1;
/** The tab last shown, so coming back from a video returns to it. */
let lastTab = TAB_RECENT;

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

/** The name of the folder a file is in, usually the series. */
function parentName(path: string): string {
  return baseName(path.slice(0, path.lastIndexOf("/")));
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

/** A small fixed thumbnail (`small`), or a card's: small beside the name on a
 *  phone, the card's full width from `sm` up. */
function Thumbnail({ video, small, children }: { video: Video; small?: boolean; children?: React.ReactNode }) {
  const src = useThumbnail(video.path, video.at);
  const watched = video.fraction >= WATCHED;
  return (
    <div
      className={`relative aspect-video shrink-0 overflow-hidden bg-ink-800 ${
        small ? "w-28 rounded-md" : "w-32 rounded-lg sm:w-full sm:rounded-xl"
      }`}
    >
      {src ? (
        <img src={src} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <i className={`pi pi-video text-zinc-600 ${small ? "" : "sm:text-2xl"}`} />
        </div>
      )}
      {watched && <div className="absolute inset-0 bg-ink-950/50" />}
      {children}
      {video.fraction > 0 && !watched && (
        <div className={`absolute inset-x-0 bottom-0 bg-white/20 ${small ? "h-[3px]" : "h-[3px] sm:h-1"}`}>
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
    // For the sheet on small screens; the popups draw rows with the template.
    icon,
    command,
    className: danger ? "danger" : undefined,
    template: (_item: MenuItem, o: MenuItemOptions) => {
      const link = (
        <a className={`${o.className} gap-3`}>
          <span className={`${o.iconClassName} m-0! w-4 shrink-0 ${icon}`} />
          <span className={`${o.labelClassName} flex-1`}>{label}</span>
          {keys && (
            <span className="ps-6 text-xs text-zinc-500" dir="ltr">
              {keys}
            </span>
          )}
        </a>
      );
      // The popup Menu hands the template the whole item, the ContextMenu
      // only the link inside it; the theme's padding and hover need the wrapper.
      return "onMouseMove" in o ? <div className="p-menuitem-content">{link}</div> : link;
    },
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
  const [menuTitle, setMenuTitle] = useState("");
  const [tab, setTab] = useState(lastTab);
  /** Whether the tab being shown came from further left, for its slide. */
  const [forward, setForward] = useState(true);
  const [switched, setSwitched] = useState(false);
  const keyboard = useHardKeyboard();
  const scroller = useRef<HTMLDivElement>(null);
  const showTab = useCallback((next: number) => {
    if (next === lastTab) return;
    setForward(next > lastTab);
    setSwitched(true);
    setTab(next);
    lastTab = next;
    scroller.current?.scrollTo({ top: 0 });
  }, []);
  const menu = useRef<PopupMenuHandle>(null);
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
      setMenuTitle(v.name);
      // On small screens both become the same sheet.
      if (atPointer && !sheetEdge()) contextMenu.current?.show(e);
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

  /** Android: shows the phone's storage here, asking for access first. */
  const browseStorage = async () => {
    try {
      const access = await api.storageAccess();
      if (access.granted) {
        if (access.root) {
          await showFolder(folder?.path ?? access.root);
          showTab(TAB_FOLDER);
        }
        return;
      }
      toast(t("storageAccessNeeded"), 6000);
      await api.requestStorageAccess();
      // Android shows its own settings screen, and the page isn't told when
      // Beyt is back, so check for a while and carry on once access is given.
      const started = Date.now();
      const check = window.setInterval(() => {
        if (Date.now() - started > 120_000) return window.clearInterval(check);
        void api.storageAccess().then((a) => {
          if (!a.granted) return;
          window.clearInterval(check);
          if (a.root) void showFolder(a.root).then(() => showTab(TAB_FOLDER));
        });
      }, 1000);
    } catch (e) {
      toast(String(e), 5000);
    }
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
    if (isAndroid) return browseStorage();
    const path = await open({ multiple: false, directory: true, defaultPath: folder?.path });
    if (typeof path !== "string") return;
    await showFolder(path);
    showTab(TAB_FOLDER);
  };

  const shownRecent = recent.filter((r) => !hidden.has(r.path) && !hidden.has(`recent:${r.path}`));

  const pages: Page[] = [
    {
      id: "recent",
      label: t("recent"),
      icon: "pi pi-history",
      content:
        shownRecent.length > 0 ? (
          <VideoGrid>
            {shownRecent.map((r) => (
              <VideoCard key={r.path} video={fromRecent(r)} meta={parentName(r.path)} {...handlers} />
            ))}
          </VideoGrid>
        ) : (
          <EmptyState icon="pi pi-video" title={t("noRecent")} hint={t("appTagline")} />
        ),
    },
    {
      id: "folder",
      label: t("libraryTab"),
      icon: "pi pi-folder",
      content: folder ? (
        <FolderView folder={folder} hidden={hidden} onOpen={(p) => void showFolder(p)} handlers={handlers} />
      ) : (
        <EmptyState icon="pi pi-folder-open" title={t("noFolder")}>
          <Button icon="pi pi-folder-open" label={t("openFolder")} outlined onClick={() => void pickFolder()} />
        </EmptyState>
      ),
    },
    { id: "vocabulary", label: t("vocabulary"), icon: "pi pi-bookmark", content: <VocabularyView /> },
  ];

  return (
    <main className="absolute inset-0 flex flex-col bg-ink-950">
      {/* In a narrow window: the wordmark and settings on one line, the two
          open buttons sharing the next. From `sm` up, everything on one row.
          Android has no open buttons: the Library tab browses storage.
          It sits above the scroller, so it never moves while the list scrolls. */}
      <div className="shrink-0 border-b border-ink-800/60">
        <header className="mx-auto grid max-w-6xl grid-cols-[1fr_auto] items-center gap-x-2 gap-y-4 px-4 py-3 sm:flex sm:flex-wrap sm:px-6 sm:py-4 md:px-10 2xl:max-w-[100rem]">
          <div className="flex min-w-0 items-baseline gap-3 sm:me-4 sm:gap-4">
            <span className="font-sans text-4xl font-bold text-accent sm:text-5xl" lang="fa">
              بیت
            </span>
            <span className="hidden text-zinc-400 sm:inline">{t("appTagline")}</span>
          </div>
          {!isAndroid && (
            <div className="col-span-2 row-start-2 grid grid-cols-2 gap-2 sm:ms-auto sm:flex">
              <Button
                icon="pi pi-play"
                label={t("openFile")}
                className="justify-center whitespace-nowrap"
                onClick={() => void pickFile()}
              />
              <Button
                icon="pi pi-folder-open"
                label={t("openFolder")}
                outlined
                className="justify-center whitespace-nowrap"
                onClick={() => void pickFolder()}
              />
            </div>
          )}
          <div className="col-start-2 row-start-1 flex items-center">
            {/* Keyboard shortcuts mean little without a keyboard. */}
            {keyboard && (
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
            )}
            <Button
              icon="pi pi-cog"
              rounded
              text
              severity="secondary"
              className="!h-12 !w-12 [&_.p-button-icon]:!text-2xl"
              aria-label={t("settings")}
              tooltip={`${t("settings")} (,)`}
              tooltipOptions={{ position: "bottom" }}
              onClick={onSettings}
            />
          </div>
        </header>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 pb-16 pt-4 sm:px-6 sm:pt-6 md:px-10 2xl:max-w-[100rem]">
          {isAndroid ? (
            <TabPage key={tab} animate={switched} forward={forward}>
              {pages[tab]?.content}
            </TabPage>
          ) : (
            <TabView className="beyt-tabs" activeIndex={tab} onTabChange={(e) => showTab(e.index)}>
              {pages.map((p) => (
                <TabPanel key={p.id} header={p.label} leftIcon={`${p.icon} me-2`}>
                  <TabPage animate={switched} forward={forward}>
                    {p.content}
                  </TabPage>
                </TabPanel>
              ))}
            </TabView>
          )}
        </div>
      </div>
      {isAndroid && <BottomNav pages={pages} active={tab} onChange={showTab} />}

      <PopupMenu ref={menu} model={menuModel} title={menuTitle} className="min-w-64" onHide={() => setMenuFor(null)} />
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

function SectionTitle({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold tracking-wide text-zinc-400 sm:mb-4">
      {children}
      {count !== undefined && (
        <span className="rounded-full bg-ink-800 px-2 py-0.5 text-xs font-medium tabular-nums text-zinc-500">{count}</span>
      )}
    </h2>
  );
}

interface Page {
  id: string;
  label: string;
  icon: string;
  content: React.ReactNode;
}

/** A tab's content, which slides in from the side it was picked from. */
function TabPage({ animate, forward, children }: { animate: boolean; forward: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (animate && ref.current) slideIn(ref.current, forward);
    // Only as it first shows.
  }, []);
  return <div ref={ref}>{children}</div>;
}

/** Android: the library's tabs as a bottom navigation bar, in thumb's reach. */
function BottomNav({ pages, active, onChange }: { pages: Page[]; active: number; onChange: (i: number) => void }) {
  return (
    <nav className="shrink-0 border-t border-ink-700/70 bg-ink-900">
      <div role="tablist" className="mx-auto grid max-w-lg" style={{ gridTemplateColumns: `repeat(${pages.length}, 1fr)` }}>
        {pages.map((p, i) => {
          const on = i === active;
          return (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onChange(i)}
              className="flex h-16 min-w-0 flex-col items-center justify-center gap-1 px-1 [-webkit-tap-highlight-color:transparent] focus-visible:outline-none"
            >
              <span className="relative grid h-8 w-16 place-items-center">
                {/* The active pill grows out from the icon's middle. */}
                <span
                  className={`absolute inset-0 rounded-full bg-accent/20 transition duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${
                    on ? "scale-x-100 opacity-100" : "scale-x-40 opacity-0"
                  }`}
                />
                <i
                  className={`${p.icon} relative text-lg transition duration-300 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${
                    on ? "scale-110 text-accent" : "text-zinc-400"
                  }`}
                />
              </span>
              <span className={`max-w-full truncate text-xs transition-colors duration-200 ${on ? "font-semibold text-zinc-100" : "text-zinc-400"}`}>
                {p.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function EmptyState({ icon, title, hint, children }: { icon: string; title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-ink-600 px-6 py-16 text-center sm:py-20">
      <i className={`${icon} text-5xl text-zinc-500`} />
      <p className="max-w-md text-lg text-zinc-300">{title}</p>
      {hint && <p className="text-sm text-zinc-500">{hint}</p>}
      {children}
    </div>
  );
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

/** Continue watching and the open folder lay their videos out alike: a list
 *  on a phone, a grid of cards from `sm` up. */
function VideoGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-y-3 sm:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] sm:gap-x-5 sm:gap-y-7">
      {children}
    </div>
  );
}

/** A video as a card: thumbnail, name, and a ⋯ button with its actions. On
 *  a phone the thumbnail sits beside the name, as a list row. */
function VideoCard({ video, meta, ...h }: { video: Video; meta?: string } & ItemHandlers) {
  const label = progressLabel(video);
  const [stem] = splitName(video.name);
  const active = h.menuFor === video.path;
  const editing = h.renaming === video.path;
  const reveal = active ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100";
  // Touch screens can't hover, so there the ⋯ button always shows (the play
  // overlay doesn't: tapping anywhere on the row plays).
  const revealMore = `${reveal} pointer-coarse:opacity-100`;
  // Names in either script line up with the page, not with their own direction.
  const align = getLang() === "fa" ? "text-right" : "text-left";

  return (
    <article
      title={video.path}
      className="group relative flex min-w-0 flex-row items-center gap-3 sm:flex-col sm:items-stretch"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        h.onMenu(video, e, true);
      }}
      onKeyDown={(e) => !editing && h.onKey(video, e)}
    >
      <button
        type="button"
        onClick={() => h.onPlay(video.path)}
        aria-label={`${t("play")}: ${stem}`}
        className={`block shrink-0 rounded-lg text-start transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:rounded-xl ${
          active ? "-translate-y-0.5" : "hover:-translate-y-0.5"
        }`}
      >
        <div
          className={`overflow-hidden rounded-lg border transition sm:rounded-xl ${
            active
              ? "border-accent/60 shadow-lg shadow-black/40"
              : "border-ink-700 group-hover:border-accent/60 group-hover:shadow-lg group-hover:shadow-black/40"
          }`}
        >
          <Thumbnail video={video}>
            <div className={`absolute inset-0 grid place-items-center bg-ink-950/35 transition ${reveal}`}>
              <span className="grid size-12 place-items-center rounded-full bg-accent text-ink-950">
                <i className="pi pi-play ms-0.5" />
              </span>
            </div>
            {label && (
              <span className="absolute end-2 top-2 hidden rounded-md bg-ink-950/80 px-1.5 py-0.5 text-xs font-medium text-zinc-200 sm:block">
                {label}
              </span>
            )}
          </Thumbnail>
        </div>
      </button>

      {editing ? (
        <div className="min-w-0 flex-1">
          <RenameField video={video} onSubmit={(s) => h.onRename(video, s)} onCancel={h.onCancelRename} />
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-1">
          <button type="button" onClick={() => h.onPlay(video.path)} tabIndex={-1} className="min-w-0 flex-1 text-start">
            <span
              className={`line-clamp-2 font-semibold break-words ${align} ${video.fraction >= WATCHED ? "text-zinc-400" : ""}`}
              dir="auto"
            >
              {stem}
            </span>
            {meta && (
              <span className={`mt-0.5 block truncate text-sm text-zinc-400 ${align}`} dir="auto">
                {meta}
              </span>
            )}
            {/* On a phone the thumbnail is too small for the badge. */}
            {label && <span className={`mt-0.5 block text-xs text-zinc-500 sm:hidden ${align}`}>{label}</span>}
          </button>
          <MoreButton video={video} onMenu={h.onMenu} className={`-mt-1.5 -me-2 transition ${revealMore}`} />
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

/** The open folder: where it is, its subfolders, then its videos. */
function FolderView({ folder, hidden, onOpen, handlers }: FolderProps) {
  const dirs = folder.entries.filter((e) => e.isDir);
  const videos = folder.entries.filter((e) => !e.isDir && !hidden.has(e.path));
  return (
    <section className="flex flex-col gap-8">
      <PathBar folder={folder} onOpen={onOpen} />

      {dirs.length > 0 && (
        <div>
          <SectionTitle count={dirs.length}>{t("subfolders")}</SectionTitle>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-2 sm:grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] sm:gap-3">
            {dirs.map((d) => (
              <FolderTile key={d.path} entry={d} onClick={() => onOpen(d.path)} />
            ))}
          </div>
        </div>
      )}

      {videos.length > 0 && (
        <div>
          <SectionTitle count={videos.length}>{t("videosTitle")}</SectionTitle>
          <VideoGrid>
            {videos.map((e) => (
              <VideoCard key={e.path} video={fromEntry(e)} {...handlers} />
            ))}
          </VideoGrid>
        </div>
      )}

      {!dirs.length && !videos.length && <EmptyState icon="pi pi-inbox" title={t("emptyFolder")} />}
    </section>
  );
}

/** Android's shared storage; nothing above it can be read. */
const ANDROID_ROOT = "/storage/emulated/0";

/** The folder's path as clickable steps, from the root down. */
function crumbsOf(path: string): { name: string; path: string }[] {
  const root = isAndroid && (path === ANDROID_ROOT || path.startsWith(`${ANDROID_ROOT}/`)) ? ANDROID_ROOT : "/";
  const crumbs = [{ name: "", path: root }];
  let at = root;
  for (const name of path.slice(root.length).split("/").filter(Boolean)) {
    at = at.endsWith("/") ? `${at}${name}` : `${at}/${name}`;
    crumbs.push({ name, path: at });
  }
  return crumbs;
}

/** An Up button and the path as a breadcrumb, scrolled so the open folder shows. */
export function PathBar({ folder, onOpen }: { folder: Folder; onOpen: (path: string) => void }) {
  const scroller = useRef<HTMLElement>(null);
  const crumbs = crumbsOf(folder.path);
  const atRoot = !folder.parent || crumbs.length === 1;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [folder.path]);

  return (
    <div className="flex min-w-0 items-center gap-1 rounded-xl border border-ink-700 bg-ink-900 p-1">
      <Button
        icon="pi pi-arrow-up"
        rounded
        text
        severity="secondary"
        disabled={atRoot}
        aria-label={t("up")}
        tooltip={t("up")}
        tooltipOptions={{ position: "bottom", showOnDisabled: false }}
        onClick={() => folder.parent && onOpen(folder.parent)}
        className="size-9! shrink-0"
      />
      <span className="h-5 w-px shrink-0 bg-ink-700" />
      <nav ref={scroller} aria-label={t("folder")} dir="ltr" className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
        <ol className="flex w-max items-center pe-1 text-sm">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={c.path} className="flex items-center">
                {i > 0 && <i className="pi pi-angle-right px-0.5 text-xs text-zinc-600" />}
                <button
                  type="button"
                  title={c.path}
                  aria-current={last ? "location" : undefined}
                  onClick={() => !last && onOpen(c.path)}
                  className={`rounded-md px-2 py-1.5 transition focus-visible:outline-2 focus-visible:outline-accent ${
                    last ? "cursor-default font-semibold text-zinc-100" : "text-zinc-400 hover:bg-ink-800 hover:text-zinc-100"
                  }`}
                >
                  {i === 0 ? <i className={`${isAndroid ? "pi pi-mobile" : "pi pi-server"} text-xs`} /> : <span dir="auto">{c.name}</span>}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}

function FolderTile({ entry, onClick }: { entry: FolderEntry; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={entry.path}
      className="group flex min-w-0 items-center gap-3 rounded-xl border border-ink-700 bg-ink-900 p-2 text-start transition hover:border-accent/50 hover:bg-ink-850 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:p-2.5"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent transition group-hover:bg-accent/20 sm:size-10">
        <i className="pi pi-folder" />
      </span>
      <span className={`min-w-0 flex-1 truncate text-sm font-medium ${getLang() === "fa" ? "text-right" : "text-left"}`} dir="auto">
        {entry.name}
      </span>
      <i className="pi pi-angle-right text-xs text-zinc-600 transition group-hover:text-zinc-400 rtl:rotate-180" />
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
