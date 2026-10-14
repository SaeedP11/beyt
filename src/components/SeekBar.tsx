import { useRef, useState } from "react";

import { fmtTime } from "../ui";

interface Props {
  time: number;
  duration: number;
  /** The time under the pointer while scrubbing, or null once released. */
  onScrub: (to: number | null) => void;
  onSeek: (to: number) => void;
}

/**
 * The timeline. A press anywhere in its tall hit area seeks there, and holding
 * scrubs; pointer capture keeps the drag alive when the pointer leaves the bar.
 * Hovering shows the time under the pointer.
 */
export function SeekBar({ time, duration, onScrub, onSeek }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [scrubbing, setScrubbing] = useState(false);

  const fraction = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };
  const at = (clientX: number) => fraction(clientX) * duration;

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setScrubbing(true);
    onScrub(at(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent) => {
    setHover(fraction(e.clientX));
    if (scrubbing) onScrub(at(e.clientX));
  };
  const finish = (e: React.PointerEvent, commit: boolean) => {
    if (!scrubbing) return;
    setScrubbing(false);
    onScrub(null);
    if (commit) onSeek(at(e.clientX));
  };

  const played = duration > 0 ? Math.min(1, time / duration) : 0;
  const active = scrubbing || hover !== null;

  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={fmtTime(time)}
      tabIndex={-1}
      className="group relative flex h-5 cursor-pointer touch-none items-center"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, true)}
      onPointerCancel={(e) => finish(e, false)}
      onPointerLeave={() => setHover(null)}
    >
      <div className={`relative w-full rounded-full bg-white/25 transition-[height] duration-150 ${active ? "h-1.5" : "h-1"}`}>
        {hover !== null && !scrubbing && (
          <div className="absolute inset-y-0 start-0 rounded-full bg-white/25" style={{ width: `${hover * 100}%` }} />
        )}
        <div className="absolute inset-y-0 start-0 rounded-full bg-accent" style={{ width: `${played * 100}%` }} />
        <div
          className={`absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-transform duration-150 ${active ? "scale-100" : "scale-0"}`}
          style={{ left: `${played * 100}%` }}
        />
      </div>
      {hover !== null && (
        <div
          className="pointer-events-none absolute bottom-full mb-1.5 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 text-xs tabular-nums text-white"
          style={{ left: `${(scrubbing ? played : hover) * 100}%` }}
        >
          {fmtTime((scrubbing ? played : hover) * duration)}
        </div>
      )}
    </div>
  );
}
