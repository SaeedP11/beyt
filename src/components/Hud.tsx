import { usePlayback, usePlayer } from "../hooks";
import { t } from "../i18n";
import { trackLabel } from "../player";
import { fmtTime } from "../ui";

/** Info overlay (I): position, active tracks with their offsets, and keys. */
export function Hud() {
  const player = usePlayer();
  const p = usePlayback(4);
  const selected = player.selectedView();

  return (
    <div className="absolute start-4 top-16 max-w-[min(36rem,60%)] rounded-xl bg-black/70 p-4 text-sm leading-relaxed backdrop-blur">
      <div className="mb-2 tabular-nums" dir="ltr">
        {fmtTime(p.time)} / {fmtTime(p.duration)}
        {p.paused && <span className="ms-2 text-zinc-400">({t("paused")})</span>}
      </div>
      {player.views
        .filter((v) => v.style.enabled)
        .map((v) => {
          const ms = Math.round(v.style.offset * 1000);
          return (
            <div key={v.track.id} className={v === selected ? "text-amber-300" : "text-zinc-200"} dir="auto">
              {v === selected ? "▶ " : ""}
              {trackLabel(v.track)} · {t(v.style.position)} · {t(v.style.mode)} · {ms >= 0 ? "+" : ""}
              {ms} ms
            </div>
          );
        })}
      <div className="mt-3 text-xs text-zinc-400">{t("helpHint")}</div>
    </div>
  );
}
