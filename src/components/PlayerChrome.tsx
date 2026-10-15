import { Button } from "primereact/button";
import { Menu } from "primereact/menu";
import type { MenuItem } from "primereact/menuitem";
import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import * as clock from "../clock";
import { player, useMediaQuery, usePlayback, usePlayer } from "../hooks";
import { getLang, t } from "../i18n";
import { popupMotions } from "../motion";
import { fmtTime } from "../ui";
import { SeekBar } from "./SeekBar";

/** Below this width the less used buttons move into the ⋯ menu. */
const NARROW = "(max-width: 767px)";

interface Props {
  visible: boolean;
  onBack: () => void;
  onToggleSubtitles: () => void;
  onInfo: () => void;
  onToggleTranscript: () => void;
  onHelp: () => void;
  onSettings: () => void;
  /** The ⋯ menu opened or closed; the controls stay up while it's open. */
  onMenuVisibleChange: (visible: boolean) => void;
}

/** Title bar and control bar over the video; they fade out while watching. */
export function PlayerChrome({
  visible,
  onBack,
  onToggleSubtitles,
  onInfo,
  onToggleTranscript,
  onHelp,
  onSettings,
  onMenuVisibleChange,
}: Props) {
  usePlayer();
  const p = usePlayback(8);
  const narrow = useMediaQuery(NARROW);
  const more = useRef<Menu>(null);
  // Widening the window unmounts the menu without an onHide.
  useEffect(() => {
    if (!narrow) onMenuVisibleChange(false);
  }, [narrow, onMenuVisibleChange]);
  const moreItems: MenuItem[] = [
    { label: t("fileInfo"), icon: "pi pi-info-circle", command: onInfo },
    { label: t("shortcutsTitle"), icon: "pi pi-question-circle", command: onHelp },
    { label: t("settings"), icon: "pi pi-cog", command: onSettings },
  ];
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
      <div className={`absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/75 to-transparent px-2 pb-10 pt-2 sm:gap-3 sm:px-4 sm:pt-3 ${fade}`}>
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
        <h1 className="truncate text-base font-semibold drop-shadow sm:text-lg" dir="auto">
          {player.media?.title}
        </h1>
      </div>

      <div className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-3 pb-3 pt-12 sm:px-5 ${fade}`}>
        <div dir="ltr" className="px-1">
          <SeekBar time={time} duration={duration} onScrub={setDragging} onSeek={seek} />
        </div>
        <div className="mt-3 flex items-center gap-0.5 sm:gap-1">
          <Button
            icon={p.paused ? "pi pi-play" : "pi pi-pause"}
            rounded
            text
            aria-label={p.paused ? t("play") : t("pause")}
            onClick={() => void api.togglePause()}
            className="text-white"
          />
          <span className="ms-1 whitespace-nowrap text-sm tabular-nums text-zinc-200 sm:ms-2" dir="ltr">
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
          {player.selectedView() && (
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
          )}
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
          {narrow ? (
            <>
              <Button
                icon="pi pi-ellipsis-v"
                rounded
                text
                aria-label={t("moreActions")}
                aria-haspopup="menu"
                tooltip={t("moreActions")}
                tooltipOptions={{ position: "top" }}
                onClick={(e) => more.current?.toggle(e)}
                className="text-white"
              />
              <Menu
                ref={more}
                model={moreItems}
                popup
                popupAlignment={getLang() === "fa" ? "left" : "right"}
                transitionOptions={popupMotions.connected}
                onShow={() => onMenuVisibleChange(true)}
                onHide={() => onMenuVisibleChange(false)}
              />
            </>
          ) : (
            <>
              <Button
                icon="pi pi-info-circle"
                rounded
                text
                aria-label={t("fileInfo")}
                tooltip={`${t("fileInfo")} (I)`}
                tooltipOptions={{ position: "top" }}
                onClick={onInfo}
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
            </>
          )}
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
