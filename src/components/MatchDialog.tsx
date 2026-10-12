import { Button } from "primereact/button";
import { Dialog } from "primereact/dialog";
import { ProgressBar } from "primereact/progressbar";
import { Tag } from "primereact/tag";
import { useEffect, useState } from "react";

import { api, events } from "../api";
import { usePlayer } from "../hooks";
import { languageName, t } from "../i18n";
import type { Candidate, MatchReason } from "../types";
import { toast } from "../ui";

interface Props {
  /** Subtitle files to compare; the dialog shows while this is non-empty. */
  files: string[];
  onHide: () => void;
}

type State =
  | { phase: "checking"; progress: number }
  | { phase: "done"; results: Candidate[] }
  | { phase: "error"; message: string };

/** Ranks subtitle files by how well they fit the video's soundtrack. */
export function MatchDialog({ files, onHide }: Props) {
  const player = usePlayer();
  const [state, setState] = useState<State>({ phase: "checking", progress: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const video = player.media?.path;

  useEffect(() => {
    if (!files.length || !video) return;
    let live = true;
    setState({ phase: "checking", progress: 0 });
    const unlisten = events.matchProgress((p) => {
      if (live) setState((s) => (s.phase === "checking" ? { phase: "checking", progress: p } : s));
    });
    api.matchSubtitles(video, files).then(
      (results) => live && setState({ phase: "done", results }),
      (e) => live && setState({ phase: "error", message: String(e) }),
    );
    return () => {
      live = false;
      void unlisten.then((fn) => fn());
    };
  }, [files, video]);

  const inUse = (path: string) =>
    player.views.some((v) => v.style.enabled && v.track.source.kind === "file" && v.track.source.path === path);

  const use = async (c: Candidate) => {
    setBusy(c.path);
    try {
      await player.useSubtitle(c.path, c.offset);
    } catch (e) {
      toast(String(e), 5000);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog
      header={t("matchTitle")}
      visible={files.length > 0}
      onHide={onHide}
      className="w-[min(44rem,95vw)]"
      dismissableMask
      draggable={false}
      footer={state.phase === "done" ? <p className="text-start text-sm text-zinc-400">{t("matchFooter")}</p> : undefined}
    >
      {state.phase === "checking" && (
        <div className="flex flex-col gap-3 py-6">
          <p className="font-medium">{t("matchChecking")}</p>
          <ProgressBar value={Math.round(state.progress * 100)} showValue={false} className="thin" />
          <p className="text-sm text-zinc-400">{t("matchCheckingHint")}</p>
        </div>
      )}

      {state.phase === "error" && (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <i className="pi pi-exclamation-circle text-3xl text-red-400" />
          <p>{t("matchError")}</p>
          <p className="max-w-full break-words text-xs text-zinc-500" dir="ltr">
            {state.message}
          </p>
        </div>
      )}

      {state.phase === "done" && (
        <ol className="flex flex-col gap-3">
          {state.results.map((c, i) => (
            <Result
              key={c.path}
              c={c}
              best={i === 0 && c.score > 0}
              inUse={inUse(c.path)}
              busy={busy === c.path}
              onUse={() => void use(c)}
            />
          ))}
        </ol>
      )}
    </Dialog>
  );
}

interface ResultProps {
  c: Candidate;
  best: boolean;
  inUse: boolean;
  busy: boolean;
  onUse: () => void;
}

function Result({ c, best, inUse, busy, onUse }: ResultProps) {
  const fits = c.verdict === "inSync" || c.verdict === "shifted";
  const useLabel = inUse
    ? t("inUse")
    : !fits
      ? t("useAnyway")
      : c.offset
        ? t("useWithOffset", { offset: fmtOffset(c.offset) })
        : t("useThis");

  return (
    <li
      className={`rounded-xl border p-4 ${best ? "border-accent/50 bg-ink-850" : "border-ink-700 bg-ink-900/60"}`}
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          {best && (
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-accent">{t("bestMatch")}</div>
          )}
          <div className="break-words font-semibold" dir="auto">
            {c.name}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <Tag value={languageName(c.lang)} severity="secondary" />
            <Verdict c={c} />
            {c.samples > 0 && (
              <span className="text-zinc-400">{t("agreeCount", { agree: c.agree, samples: c.samples })}</span>
            )}
            {c.cues > 0 && <span className="text-zinc-500">· {t("lineCount", { n: c.cues })}</span>}
          </div>
          {c.reasons.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1 text-sm text-zinc-400">
              {c.reasons.map((r, i) => (
                <li key={i} className="flex gap-2">
                  <i className={`pi ${r.kind === "sameRelease" ? "pi-check text-green-400" : "pi-info-circle"} mt-1 text-xs`} />
                  <span className="break-words">{reasonText(r)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex w-20 shrink-0 flex-col items-end gap-1">
          <span className={`text-2xl font-semibold tabular-nums ${scoreColor(c.score)}`} dir="ltr">
            {c.score}%
          </span>
          <ProgressBar value={c.score} showValue={false} className="thin w-full" />
        </div>
      </div>

      {c.verdict !== "unreadable" && (
        <div className="mt-3 flex justify-end">
          <Button
            label={useLabel}
            icon={inUse ? "pi pi-check" : undefined}
            size="small"
            outlined={!best || inUse}
            severity={fits ? undefined : "secondary"}
            disabled={inUse}
            loading={busy}
            onClick={onUse}
          />
        </div>
      )}
    </li>
  );
}

function Verdict({ c }: { c: Candidate }) {
  switch (c.verdict) {
    case "inSync":
      return <Tag value={t("v_inSync")} severity="success" icon="pi pi-check" />;
    case "shifted":
      return <Tag value={t("v_shifted", { offset: fmtOffset(c.offset) })} severity="info" icon="pi pi-arrows-h" />;
    case "drifts":
      return <Tag value={t("v_drifts")} severity="warning" icon="pi pi-exclamation-triangle" />;
    case "noMatch":
      return <Tag value={t("v_noMatch")} severity="danger" icon="pi pi-times" />;
    case "unreadable":
      return <Tag value={t("v_unreadable")} severity="danger" icon="pi pi-times" />;
  }
}

function reasonText(r: MatchReason): string {
  switch (r.kind) {
    case "sameRelease":
      return t("r_sameRelease", { group: r.group });
    case "otherEpisode":
      return t("r_otherEpisode", { subtitle: r.subtitle, video: r.video });
    case "frameRate":
      return t("r_frameRate", { subtitle: r.subtitle, video: r.video });
    case "endsAfter":
      return t("r_endsAfter", { seconds: r.seconds });
    case "partial":
      return t("r_partial", { percent: r.percent });
    case "error":
      return r.message;
  }
}

/** "+1.25" / "−3.45", in seconds. */
function fmtOffset(s: number): string {
  return `${s > 0 ? "+" : "−"}${Math.abs(s).toFixed(2)}`;
}

function scoreColor(score: number): string {
  if (score >= 60) return "text-green-400";
  if (score >= 30) return "text-amber-300";
  return "text-zinc-500";
}
