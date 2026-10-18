import { useEffect, useRef } from "react";

import { usePlayer } from "../hooks";
import { t } from "../i18n";
import { fade } from "../motion";
import type { LevelChange } from "../player";

/** How long the indicator stays up after the last change. */
const SHOW_MS = 1200;

function icon({ kind, level, muted }: LevelChange): string {
  if (kind === "brightness") return "pi-sun";
  if (muted || level === 0) return "pi-volume-off";
  return level < 50 ? "pi-volume-down" : "pi-volume-up";
}

/** Volume or brightness, shown for a moment while it changes. */
export function LevelIndicator() {
  const { level: change } = usePlayer();
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = el.current;
    if (!node || !change) return;
    fade(node, true, 120);
    const timer = window.setTimeout(() => fade(node, false, 300), SHOW_MS);
    return () => clearTimeout(timer);
  }, [change]);

  const level = change?.level ?? 0;
  const muted = change?.muted ?? false;
  // The bar is full at 100%; volume and picture boosts above that show in amber.
  const boosted = level > 100;
  const label = !change
    ? ""
    : change.kind === "brightness"
      ? t("brightnessToast", { n: level })
      : muted
        ? t("muted")
        : t("volumeToast", { n: level });

  return (
    <div
      ref={el}
      role="status"
      aria-label={label}
      className="dark pointer-events-none absolute inset-x-0 top-20 mx-auto flex w-fit items-center gap-3 rounded-full border border-ink-600 bg-ink-900/85 px-4 py-2 shadow-xl backdrop-blur"
      style={{ opacity: 0 }}
    >
      <i className={`pi ${change ? icon(change) : ""} w-4 text-sm ${muted ? "text-zinc-500" : "text-zinc-100"}`} />
      <div className="h-1.5 w-36 overflow-hidden rounded-full bg-ink-600">
        <div
          className={`h-full rounded-full ${muted ? "bg-zinc-500" : boosted ? "bg-amber-400" : "bg-accent"}`}
          style={{ width: `${Math.min(level, 100)}%` }}
        />
      </div>
      <span className={`w-10 text-end text-sm tabular-nums ${muted ? "text-zinc-500" : "text-zinc-100"}`}>
        {level}%
      </span>
    </div>
  );
}
