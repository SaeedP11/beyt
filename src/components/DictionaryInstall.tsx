import { Button } from "primereact/button";
import { ProgressBar } from "primereact/progressbar";

import { type DictionaryState, installDictionary, useDictionary } from "../dictionary";
import { t } from "../i18n";

/** "Downloading… 42%", or "Finishing up…" once the download is in. */
function progressLabel(progress: number | null): string {
  if (progress === null) return t("dictionaryDownloading");
  if (progress >= 1) return t("dictionaryFinishing");
  return t("dictionaryDownloadingPct", { pct: Math.round(progress * 100) });
}

function Progress({ state }: { state: Extract<DictionaryState, { kind: "installing" }> }) {
  const known = state.progress !== null && state.progress < 1;
  return (
    <ProgressBar
      value={known ? Math.round(state.progress! * 100) : undefined}
      mode={known ? "determinate" : "indeterminate"}
      showValue={false}
      className="thin w-full"
    />
  );
}

/** Shown in the word popup when there's no dictionary to look the word up in. */
export function DictionaryInstallCard() {
  const state = useDictionary();

  if (state.kind === "installing") {
    return (
      <div className="flex flex-col gap-2 py-1" role="status" aria-live="polite">
        <p className="text-sm text-zinc-300">{progressLabel(state.progress)}</p>
        <Progress state={state} />
        <p className="text-xs text-zinc-500">{t("dictionaryInstallingHint")}</p>
      </div>
    );
  }

  const failed = state.kind === "failed";
  return (
    <div className="flex flex-col gap-3 py-1">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent/15 text-accent">
          <i className={failed ? "pi pi-exclamation-triangle" : "pi pi-book"} />
        </span>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-zinc-100">
            {failed ? t("dictionaryInstallFailed") : t("dictionaryNotInstalled")}
          </p>
          <p className="text-xs leading-relaxed text-zinc-400">
            {failed ? t("dictionaryInstallFailedHint") : t("dictionaryInstallHint")}
          </p>
          {failed && (
            <p className="break-words text-xs text-zinc-500" dir="ltr">
              {state.error}
            </p>
          )}
        </div>
      </div>
      <Button
        icon={failed ? "pi pi-refresh" : "pi pi-download"}
        label={failed ? t("retry") : t("installDictionary")}
        size="small"
        className="self-start"
        onClick={() => void installDictionary()}
      />
    </div>
  );
}

/** The dictionary row in Settings: its state, with Install or Update. */
export function DictionaryStatus() {
  const state = useDictionary();
  switch (state.kind) {
    case "unknown":
      return <i className="pi pi-spin pi-spinner text-zinc-400" />;
    case "installing":
      return (
        <div className="flex w-56 flex-col gap-1.5" role="status" aria-live="polite">
          <span className="text-xs text-zinc-400">{progressLabel(state.progress)}</span>
          <Progress state={state} />
        </div>
      );
    case "ready":
      return (
        <>
          <span className="flex items-center gap-2 text-sm text-emerald-300">
            <i className="pi pi-check-circle" />
            {t("dictionaryEntries", { n: state.entries.toLocaleString() })}
          </span>
          <Button
            label={t("update")}
            size="small"
            text
            tooltip={t("dictionaryUpdateHint")}
            tooltipOptions={{ position: "top" }}
            onClick={() => void installDictionary()}
          />
        </>
      );
    case "missing":
    case "failed":
      return (
        <>
          {state.kind === "failed" && (
            <span className="text-sm text-amber-300" title={state.error}>
              {t("dictionaryInstallFailed")}
            </span>
          )}
          <Button
            icon={state.kind === "failed" ? "pi pi-refresh" : "pi pi-download"}
            label={state.kind === "failed" ? t("retry") : t("installDictionary")}
            size="small"
            outlined
            onClick={() => void installDictionary()}
          />
        </>
      );
  }
}
