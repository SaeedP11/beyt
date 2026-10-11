import { Button } from "primereact/button";
import { ProgressBar } from "primereact/progressbar";

import { usePlayer } from "../hooks";
import { t } from "../i18n";


/** "Up next" card shown at the end of an episode, counting down to autoplay. */
export function UpNextCard() {
  const player = usePlayer();
  const next = player.upNext;
  if (!next) return null;

  return (
    <div className="absolute bottom-28 end-6 w-80 rounded-2xl border border-ink-600 bg-ink-900/95 p-4 shadow-2xl backdrop-blur">
      <div className="text-xs font-semibold uppercase tracking-wider text-accent">{t("upNext")}</div>
      <div className="mt-1 truncate text-base font-semibold" dir="auto">
        {next.name}
      </div>
      <ProgressBar
        value={((next.total - next.seconds) / next.total) * 100}
        showValue={false}
        className="thin mt-3"
      />
      <div className="mt-1 text-xs text-zinc-400">{t("playingIn", { n: next.seconds })}</div>
      <div className="mt-4 flex gap-2">
        <Button icon="pi pi-play" label={t("playNow")} size="small" className="flex-1" onClick={() => void player.playUpNext()} />
        <Button label={t("cancel")} size="small" outlined severity="secondary" onClick={() => player.cancelCountdown()} />
      </div>
    </div>
  );
}
