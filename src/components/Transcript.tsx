import { Sidebar } from "primereact/sidebar";
import { useEffect, useMemo, useRef } from "react";

import { cueIndexAt } from "../cues";
import { usePlayback, usePlayer } from "../hooks";
import { t } from "../i18n";
import { usePanelMotion } from "../motion";
import { trackLabel } from "../player";
import type { Cue } from "../types";
import { fmtTime } from "../ui";

/** After the user scrolls the list, stop following playback for this long. */
const MANUAL_SCROLL_MS = 4000;

interface Row {
  cue: Cue;
  /** The other language's line that overlaps this one most. */
  other: string | null;
}

/** For each primary cue, the secondary cue with the most overlap (both sorted). */
function alignCues(primary: Cue[], secondary: Cue[]): Row[] {
  let j = 0;
  return primary.map((cue) => {
    while (j < secondary.length && secondary[j]!.end <= cue.start) j++;
    let best: Cue | null = null;
    let bestOverlap = 0;
    for (let k = j; k < secondary.length && secondary[k]!.start < cue.end; k++) {
      const s = secondary[k]!;
      const overlap = Math.min(s.end, cue.end) - Math.max(s.start, cue.start);
      if (overlap > bestOverlap) {
        best = s;
        bestOverlap = overlap;
      }
    }
    return { cue, other: best?.text ?? null };
  });
}

interface Props {
  visible: boolean;
  rtl: boolean;
  onHide: () => void;
}

/** Both languages line by line; follows playback, click a line to jump. */
export function Transcript({ visible, rtl, onHide }: Props) {
  const motion = usePanelMotion();
  const player = usePlayer();
  const p = usePlayback(4);
  const listRef = useRef<HTMLDivElement>(null);
  const manualScrollAt = useRef(0);

  const primary = player.selectedView();
  const secondary = player.views.find((v) => v !== primary && v.isText && v.style.enabled);
  const rows = useMemo(
    () => (primary ? alignCues(primary.track.cues, secondary?.track.cues ?? []) : []),
    // Track objects are replaced when they change, so identity is enough.
    [primary?.track, secondary?.track],
  );
  const current = primary ? cueIndexAt(primary.track.cues, primary.trackTime(p.time)) : -1;

  // Nothing to show once the last text subtitle is turned off or removed.
  useEffect(() => {
    if (visible && !primary) onHide();
  }, [visible, primary, onHide]);

  useEffect(() => {
    if (!visible || current < 0 || Date.now() - manualScrollAt.current < MANUAL_SCROLL_MS) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${current}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [current, visible]);

  return (
    <Sidebar
      visible={visible && !!primary}
      onHide={onHide}
      position={rtl ? "right" : "left"}
      modal={false}
      {...motion}
      className="panel w-[min(26rem,92vw)]"
      header={
        <div>
          <h2 className="text-lg font-semibold">{t("transcript")}</h2>
          {primary && (
            <p className="text-xs text-zinc-400" dir="auto">
              {trackLabel(primary.track)}
              {secondary ? ` + ${trackLabel(secondary.track)}` : ""}
            </p>
          )}
        </div>
      }
    >
      {primary && (
        <div
          ref={listRef}
          className="flex flex-col gap-1"
          onWheel={() => (manualScrollAt.current = Date.now())}
          onTouchMove={() => (manualScrollAt.current = Date.now())}
        >
          {rows.map((row, i) => (
            <button
              type="button"
              key={i}
              data-row={i}
              onClick={() => player.seekTo(row.cue.start + primary.style.offset)}
              className={`grid grid-cols-[3.25rem_1fr] gap-x-3 rounded-lg px-3 py-2 text-start transition ${
                i === current ? "bg-accent/15 ring-1 ring-accent/50" : "hover:bg-ink-800"
              }`}
            >
              <span className="pt-0.5 text-xs tabular-nums text-zinc-500" dir="ltr">
                {fmtTime(row.cue.start)}
              </span>
              <span className="flex flex-col gap-0.5">
                <span dir="auto" className={i === current ? "text-white" : "text-zinc-200"}>
                  {row.cue.text}
                </span>
                {row.other && (
                  <span dir="auto" className="text-sm text-zinc-400">
                    {row.other}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </Sidebar>
  );
}
