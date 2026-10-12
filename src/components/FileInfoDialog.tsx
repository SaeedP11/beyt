import { Button } from "primereact/button";
import { Dialog } from "primereact/dialog";
import { Skeleton } from "primereact/skeleton";
import { Tag } from "primereact/tag";
import { type ReactNode, useEffect, useState } from "react";

import { api } from "../api";
import { languageName, t } from "../i18n";
import type { AudioStream, FileInfo, Release, VideoStream } from "../types";
import { toast } from "../ui";

interface Props {
  visible: boolean;
  /** The open video. */
  path: string | null;
  onHide: () => void;
}

/** What the open video is (I): its codecs, resolution, frame rate and release name. */
export function FileInfoDialog({ visible, path, onHide }: Props) {
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);

  const load = (p: string) => {
    setInfo(null);
    setError(null);
    setLoadedPath(p);
    api.fileInfo(p).then(setInfo, (e) => setError(String(e)));
  };

  // Read once per file, the first time the dialog opens for it.
  useEffect(() => {
    if (visible && path && path !== loadedPath) load(path);
  }, [visible, path, loadedPath]);

  return (
    <Dialog
      header={t("fileInfo")}
      visible={visible}
      onHide={onHide}
      className="w-[min(42rem,95vw)]"
      dismissableMask
      draggable={false}
    >
      {error ? (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <i className="pi pi-exclamation-circle text-3xl text-red-400" />
          <p>{t("fileInfoError")}</p>
          <p className="max-w-full break-words text-xs text-zinc-500" dir="ltr">
            {error}
          </p>
          <Button label={t("retry")} icon="pi pi-refresh" outlined size="small" onClick={() => path && load(path)} />
        </div>
      ) : !info ? (
        <Loading />
      ) : (
        <Details info={info} />
      )}
    </Dialog>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-3" aria-busy>
      <Skeleton height="9rem" borderRadius="0.75rem" />
      <Skeleton width="40%" />
      <Skeleton />
      <Skeleton width="80%" />
    </div>
  );
}

function Details({ info }: { info: FileInfo }) {
  const r = info.release;
  const video = info.video[0];
  const query = searchName(r);

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-xl border border-accent/40 bg-ink-850 p-4">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-accent">{t("fileInfoFind")}</h3>
        <p className="mb-3 text-sm text-zinc-400">{t("fileInfoFindHint")}</p>
        <Rows>
          {query && <Row label={t("searchName")} value={query} copy />}
          {releaseTags(r) && <Row label={t("release")} value={releaseTags(r)} />}
          {video?.fps && <Row label={t("frameRate")} value={fmtFps(video.fps)} />}
          {info.duration !== null && <Row label={t("duration")} value={fmtDuration(info.duration)} />}
          <Row label={t("fileSize")} value={`${fmtBytes(info.size)} (${info.size.toLocaleString("en")} B)`} />
          {info.hash && <Row label={t("hash")} value={info.hash} copy mono />}
        </Rows>
      </section>

      <Section title={t("video")}>
        {info.video.length === 0 ? (
          <None />
        ) : (
          info.video.map((v, i) => <VideoRows key={i} v={v} />)
        )}
      </Section>

      <Section title={t("audio")}>
        {info.audio.length === 0 ? (
          <None />
        ) : (
          <ul className="divide-y divide-ink-700/70">
            {info.audio.map((a, i) => (
              <AudioRow key={i} a={a} />
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("embeddedSubs")}>
        {info.subtitles.length === 0 ? (
          <None />
        ) : (
          <ul className="divide-y divide-ink-700/70">
            {info.subtitles.map((s, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className="font-medium">{languageName(s.lang)}</span>
                <span className="text-zinc-400" dir="ltr">
                  {codecName(s.codec)}
                </span>
                {s.title && (
                  <span className="truncate text-zinc-400" dir="auto">
                    · {s.title}
                  </span>
                )}
                {s.forced && <Tag value={t("forced")} severity="warning" />}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("file")}>
        <Rows>
          <Row label={t("fileName")} value={info.name} copy />
          <Row label={t("folder")} value={info.folder} />
          {info.titleTag && <Row label={t("titleTag")} value={info.titleTag} copy />}
          {info.container && <Row label={t("container")} value={containerName(info.container)} />}
          {info.bitrate && <Row label={t("bitrate")} value={fmtBitrate(info.bitrate)} />}
        </Rows>
      </Section>
    </div>
  );
}

function VideoRows({ v }: { v: VideoStream }) {
  const depth = [v.bitDepth ? `${v.bitDepth}-bit` : null, v.hdr ? "HDR" : null].filter(Boolean).join(" · ");
  return (
    <Rows>
      <Row label={t("codec")} value={[codecName(v.codec), v.profile].filter(Boolean).join(" · ")} />
      <Row label={t("resolution")} value={`${v.width} × ${v.height}  (${resolutionName(v.width, v.height)})`} />
      {v.fps && <Row label={t("frameRate")} value={fmtFps(v.fps)} />}
      {depth && <Row label={t("bitDepth")} value={depth} />}
    </Rows>
  );
}

function AudioRow({ a }: { a: AudioStream }) {
  const tech = [
    codecName(a.codec),
    a.channels ? channelsName(a.channels) : null,
    a.sampleRate ? `${(a.sampleRate / 1000).toLocaleString("en")} kHz` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
      <span className="min-w-24 font-medium">{languageName(a.lang)}</span>
      <span className="text-zinc-300" dir="ltr">
        {tech}
      </span>
      {a.title && (
        <span className="truncate text-zinc-400" dir="auto">
          {a.title}
        </span>
      )}
      {a.default && <Tag value={t("isDefault")} severity="secondary" />}
    </li>
  );
}

// ---------- layout ----------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-accent">{title}</h3>
      {children}
    </section>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[9rem_1fr] items-center gap-x-4 gap-y-2 text-sm">{children}</dl>;
}

function Row({ label, value, copy, mono }: { label: string; value: string; copy?: boolean; mono?: boolean }) {
  return (
    <>
      <dt className="text-zinc-400">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1">
        <span className={`min-w-0 select-text break-words ${mono ? "font-mono" : ""}`} dir="auto">
          {value}
        </span>
        {copy && (
          <Button
            icon="pi pi-copy"
            rounded
            text
            size="small"
            severity="secondary"
            aria-label={t("copy")}
            tooltip={t("copy")}
            tooltipOptions={{ position: "top" }}
            className="-my-2 h-8 w-8 shrink-0"
            onClick={() => void navigator.clipboard.writeText(value).then(() => toast(t("copied")))}
          />
        )}
      </dd>
    </>
  );
}

function None() {
  return <p className="text-sm text-zinc-500">{t("noneFound")}</p>;
}

// ---------- formatting ----------

/** What to type into a subtitle site: "The Office S02E05" or "Inception 2010". */
function searchName(r: Release): string {
  if (!r.title) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  if (r.season !== null) return `${r.title} S${pad(r.season)}${r.episode !== null ? `E${pad(r.episode)}` : ""}`;
  return r.year ? `${r.title} ${r.year}` : r.title;
}

function releaseTags(r: Release): string {
  return [r.source, r.resolution, r.group].filter(Boolean).join(" · ");
}

/** 23.976 stays exact, 25 stays whole. */
function fmtFps(fps: number): string {
  return `${Number(fps.toFixed(3)).toLocaleString("en")} fps`;
}

/** h:mm:ss.mmm, the precision subtitle sites list. */
function fmtDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = (s % 60).toFixed(3).padStart(6, "0");
  return `${h}:${m}:${sec}`;
}

function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i >= 3 ? 2 : i ? 1 : 0)} ${units[i]}`;
}

function fmtBitrate(bps: number): string {
  return bps >= 1_000_000 ? `${(bps / 1_000_000).toFixed(1)} Mb/s` : `${Math.round(bps / 1000)} kb/s`;
}

function resolutionName(w: number, h: number): string {
  if (w >= 3800 || h >= 2100) return "4K";
  if (w >= 2500 || h >= 1400) return "1440p";
  if (w >= 1900 || h >= 1000) return "1080p";
  if (w >= 1260 || h >= 700) return "720p";
  if (h >= 560) return "576p";
  if (h >= 470) return "480p";
  return "SD";
}

function channelsName(n: number): string {
  return { 1: "Mono", 2: "Stereo", 3: "2.1", 6: "5.1", 7: "6.1", 8: "7.1" }[n] ?? `${n} ch`;
}

const CODECS: Record<string, string> = {
  h264: "H.264 (AVC)",
  hevc: "H.265 (HEVC)",
  av1: "AV1",
  vp9: "VP9",
  vp8: "VP8",
  mpeg4: "MPEG-4 Part 2",
  mpeg2video: "MPEG-2",
  aac: "AAC",
  ac3: "AC-3 (Dolby Digital)",
  eac3: "E-AC-3 (Dolby Digital Plus)",
  truehd: "Dolby TrueHD",
  dts: "DTS",
  opus: "Opus",
  vorbis: "Vorbis",
  flac: "FLAC",
  mp3: "MP3",
  pcm_s16le: "PCM",
  pcm_s24le: "PCM",
  subrip: "SRT",
  ass: "ASS",
  ssa: "SSA",
  webvtt: "WebVTT",
  mov_text: "MP4 text",
  hdmv_pgs_subtitle: "PGS (picture)",
  dvd_subtitle: "VobSub (picture)",
  dvb_subtitle: "DVB (picture)",
};

function codecName(codec: string): string {
  return CODECS[codec] ?? codec.toUpperCase();
}

function containerName(format: string): string {
  if (format.startsWith("matroska")) return "Matroska (MKV)";
  if (format.startsWith("mov,mp4")) return "MP4";
  if (format === "avi") return "AVI";
  if (format === "mpegts") return "MPEG-TS";
  return format;
}
