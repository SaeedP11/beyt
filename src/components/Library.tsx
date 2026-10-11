import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "primereact/button";
import { Dialog } from "primereact/dialog";
import { Dropdown } from "primereact/dropdown";
import { InputSwitch } from "primereact/inputswitch";
import { ProgressBar } from "primereact/progressbar";
import { useCallback, useEffect, useState } from "react";

import { api } from "../api";
import { useLang } from "../hooks";
import { type Lang, t } from "../i18n";
import type { Folder, FolderEntry, Recent } from "../types";
import { toast } from "../ui";

const VIDEO_EXTENSIONS = ["mkv", "mp4", "m4v", "webm", "avi", "mov", "ts", "m2ts", "wmv", "flv", "ogv"];
const WATCHED = 0.92;

interface Props {
  folder: string | null;
  autoplay: boolean;
  onPlay: (path: string) => void;
  onLanguage: (lang: Lang) => void;
  onAutoplay: (on: boolean) => void;
}

export function Library({ folder: initialFolder, autoplay, onPlay, onLanguage, onAutoplay }: Props) {
  const lang = useLang();
  const [recent, setRecent] = useState<Recent[]>([]);
  const [folder, setFolder] = useState<Folder | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const showFolder = useCallback(async (path: string) => {
    try {
      setFolder(await api.listFolder(path));
    } catch (e) {
      toast(String(e), 5000);
    }
  }, []);

  useEffect(() => {
    void api.recentFiles().then(setRecent, (e) => toast(String(e), 5000));
    if (initialFolder) void showFolder(initialFolder);
  }, [initialFolder, showFolder]);

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

  const empty = !recent.length && !folder;

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
              icon="pi pi-cog"
              rounded
              text
              severity="secondary"
              aria-label={t("settings")}
              tooltip={t("settings")}
              tooltipOptions={{ position: "bottom" }}
              onClick={() => setSettingsOpen(true)}
            />
          </div>
        </header>

        {empty && (
          <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-ink-600 px-6 py-20 text-center">
            <i className="pi pi-video text-5xl text-zinc-500" />
            <p className="text-lg text-zinc-300">{t("dropHint")}</p>
            <p className="text-sm text-zinc-500">{t("appTagline")}</p>
          </div>
        )}

        {recent.length > 0 && (
          <section className="mb-12">
            <SectionTitle>{t("recent")}</SectionTitle>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4">
              {recent.map((r) => (
                <RecentCard key={r.path} item={r} onPlay={onPlay} />
              ))}
            </div>
          </section>
        )}

        {folder && <FolderView folder={folder} onOpen={(p) => void showFolder(p)} onPlay={onPlay} />}
      </div>

      <Dialog
        header={t("settings")}
        visible={settingsOpen}
        onHide={() => setSettingsOpen(false)}
        className="w-[min(28rem,92vw)]"
        dismissableMask
        draggable={false}
      >
        <div className="flex flex-col gap-5 pt-1">
          <label className="flex items-center justify-between gap-4">
            <span>{t("uiLanguage")}</span>
            <Dropdown
              value={lang}
              options={[
                { label: "English", value: "en" },
                { label: "فارسی", value: "fa" },
              ]}
              onChange={(e) => onLanguage(e.value as Lang)}
              className="w-40"
            />
          </label>
          <label className="flex items-center justify-between gap-4">
            <span>{t("autoplayNext")}</span>
            <InputSwitch checked={autoplay} onChange={(e) => onAutoplay(!!e.value)} />
          </label>
        </div>
      </Dialog>
    </main>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-4 text-sm font-semibold tracking-wide text-zinc-400">{children}</h2>;
}

function RecentCard({ item, onPlay }: { item: Recent; onPlay: (path: string) => void }) {
  const fraction = item.duration > 0 ? item.position / item.duration : 0;
  const minutesLeft = Math.max(1, Math.round((item.duration - item.position) / 60));
  return (
    <button
      type="button"
      title={item.path}
      onClick={() => onPlay(item.path)}
      className="group flex flex-col gap-3 rounded-xl border border-ink-700 bg-ink-850 p-4 text-start transition hover:-translate-y-0.5 hover:border-accent/60 hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent/15 text-accent transition group-hover:bg-accent group-hover:text-ink-950">
          <i className="pi pi-play text-sm" />
        </span>
        <span className="truncate font-semibold" dir="auto">
          {item.title}
        </span>
      </div>
      <ProgressBar value={fraction * 100} showValue={false} className="thin" />
      <span className="text-xs text-zinc-400">
        {fraction >= WATCHED ? t("watched") : t("minutesLeft", { n: minutesLeft })}
      </span>
    </button>
  );
}

interface FolderProps {
  folder: Folder;
  onOpen: (path: string) => void;
  onPlay: (path: string) => void;
}

function FolderView({ folder, onOpen, onPlay }: FolderProps) {
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
            <Row icon="pi pi-arrow-up" label={t("up")} muted onClick={() => onOpen(folder.parent!)} />
          </li>
        )}
        {folder.entries.map((e) => (
          <li key={e.path}>
            <EntryRow entry={e} onClick={() => (e.isDir ? onOpen(e.path) : onPlay(e.path))} />
          </li>
        ))}
        {!folder.entries.length && <li className="px-5 py-8 text-center text-zinc-500">{t("emptyFolder")}</li>}
      </ul>
    </section>
  );
}

function EntryRow({ entry, onClick }: { entry: FolderEntry; onClick: () => void }) {
  const fraction = entry.duration ? (entry.position ?? 0) / entry.duration : 0;
  const watched = fraction >= WATCHED;
  return (
    <Row
      icon={entry.isDir ? "pi pi-folder" : watched ? "pi pi-check-circle" : "pi pi-play-circle"}
      label={entry.name}
      bold={entry.isDir}
      muted={watched}
      onClick={onClick}
      trailing={
        !entry.isDir && fraction > 0 && !watched ? (
          <ProgressBar value={fraction * 100} showValue={false} className="thin w-24" />
        ) : undefined
      }
    />
  );
}

interface RowProps {
  icon: string;
  label: string;
  bold?: boolean;
  muted?: boolean;
  trailing?: React.ReactNode;
  onClick: () => void;
}

function Row({ icon, label, bold, muted, trailing, onClick }: RowProps) {
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
      {trailing}
    </button>
  );
}
