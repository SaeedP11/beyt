import { Button } from "primereact/button";
import { Slider } from "primereact/slider";
import { useState } from "react";

import { api } from "../api";
import * as clock from "../clock";
import { player, usePlayback, usePlayer } from "../hooks";
import { t } from "../i18n";
import { fmtTime } from "../ui";

interface Props {
  visible: boolean;
  onBack: () => void;
  onToggleSubtitles: () => void;
  onToggleInfo: () => void;
  onToggleTranscript: () => void;
  onHelp: () => void;
  onSettings: () => void;
}

/** Title bar and control bar over the video; they fade out while watching. */
export function PlayerChrome({
  visible,
  onBack,
  onToggleSubtitles,
  onToggleInfo,
  onToggleTranscript,
  onHelp,
  onSettings,
}: Props) {
  usePlayer();
  const p = usePlayback(8);
  const [dragging, setDragging] = useState<number | null>(null);
  const time = dragging ?? p.time;
  const duration = Math.max(p.duration, 0.1);
  const fade = `transition-opacity duration-300 ${visible ? "opacity-100" : "pointer-events-none opacity-0"}`;

  const seek = (to: number) => {
    clock.jump(to);
    void api.seekAbsolute(to);
  };

  return (
    <>
      <div className={`absolute inset-x-0 top-0 flex items-center gap-3 bg-gradient-to-b from-black/75 to-transparent px-4 pb-10 pt-3 ${fade}`}>
        <Button
          icon="pi pi-arrow-left rtl:rotate-180"
          rounded
          text
          severity="secondary"
          aria-label={t("back")}
          tooltip={t("back")}
          tooltipOptions={{ position: "bottom" }}
          onClick={onBack}
          className="text-white"
        />
        <h1 className="truncate text-lg font-semibold drop-shadow" dir="auto">
          {player.media?.title}
        </h1>
      </div>

      <div className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-5 pb-3 pt-12 ${fade}`}>
        <div dir="ltr" className="px-1">
          <Slider
            value={time}
            min={0}
            max={duration}
            step={0.1}
            onChange={(e) => setDragging(e.value as number)}
            onSlideEnd={(e) => {
              setDragging(null);
              seek(e.value as number);
            }}
            className="w-full"
            aria-label="Seek"
          />
        </div>
        <div className="mt-3 flex items-center gap-1">
          <Button
            icon={p.paused ? "pi pi-play" : "pi pi-pause"}
            rounded
            text
            aria-label={p.paused ? t("play") : t("pause")}
            onClick={() => void api.togglePause()}
            className="text-white"
          />
          <span className="ms-2 text-sm tabular-nums text-zinc-200" dir="ltr">
            {fmtTime(time)} <span className="text-zinc-500">/ {fmtTime(p.duration)}</span>
          </span>
          <div className="flex-1" />
          <Button
            icon="pi pi-stopwatch"
            rounded
            text={!player.autoPause}
            aria-label={t("autoPause")}
            aria-pressed={player.autoPause}
            tooltip={`${t("autoPause")} (P)`}
            tooltipOptions={{ position: "top" }}
            onClick={() => player.toggleAutoPause()}
            className={player.autoPause ? "" : "text-white"}
          />
          <Button
            icon="pi pi-align-left"
            rounded
            text
            aria-label={t("transcript")}
            tooltip={`${t("transcript")} (R)`}
            tooltipOptions={{ position: "top" }}
            onClick={onToggleTranscript}
            className="text-white"
          />
          <Button
            icon="pi pi-comments"
            rounded
            text
            aria-label={t("tracks")}
            tooltip={`${t("tracks")} (L)`}
            tooltipOptions={{ position: "top" }}
            onClick={onToggleSubtitles}
            className="text-white"
          />
          <Button
            icon="pi pi-info-circle"
            rounded
            text
            aria-label={t("info")}
            tooltip={`${t("info")} (I)`}
            tooltipOptions={{ position: "top" }}
            onClick={onToggleInfo}
            className="text-white"
          />
          <Button
            icon="pi pi-question-circle"
            rounded
            text
            aria-label={t("shortcutsTitle")}
            tooltip={`${t("shortcutsTitle")} (?)`}
            tooltipOptions={{ position: "top" }}
            onClick={onHelp}
            className="text-white"
          />
          <Button
            icon="pi pi-cog"
            rounded
            text
            aria-label={t("settings")}
            tooltip={`${t("settings")} (,)`}
            tooltipOptions={{ position: "top" }}
            onClick={onSettings}
            className="text-white"
          />
          <Button
            icon="pi pi-window-maximize"
            rounded
            text
            aria-label={t("fullscreen")}
            tooltip={`${t("fullscreen")} (F)`}
            tooltipOptions={{ position: "top" }}
            onClick={() => void api.toggleFullscreen()}
            className="text-white"
          />
        </div>
      </div>
    </>
  );
}
