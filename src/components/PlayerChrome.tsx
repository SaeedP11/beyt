import { Button } from "primereact/button";
import { Menu } from "primereact/menu";
import type { MenuItem } from "primereact/menuitem";
import { useEffect, useRef, useState } from "react";

import { api, isAndroid } from "../api";
import { audioItems, audioMenuLabel } from "../audio";
import * as clock from "../clock";
import { player, useHardKeyboard, useMediaQuery, usePlayback, usePlayer } from "../hooks";
import { getLang, t } from "../i18n";
import { keyParts, keysFor } from "../keymap";
import { popupMotions } from "../motion";
import { ASPECTS, aspectLabel } from "../player";
import { useSettings } from "../settings";
import { fmtTime } from "../ui";
import { SeekBar } from "./SeekBar";

/** Below this width the less used buttons move into the ⋯ menu. */
const NARROW = "(max-width: 767px)";

interface Props {
  visible: boolean;
  /** Every control but the lock button is shown disabled. */
  locked: boolean;
  onToggleLock: () => void;
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
  locked,
  onToggleLock,
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
  const keyboard = useHardKeyboard();
  const { keymap } = useSettings();
  const lockKey = keysFor("lock", keymap)[0];
  const audioKey = keysFor("cycleAudio", keymap)[0];
  const lockLabel = locked ? t("unlock") : t("lock");
  const more = useRef<Menu>(null);
  /** The ⋯ button, which the aspect menu opens from on narrow screens. */
  const moreButton = useRef<EventTarget | null>(null);
  const aspectMenu = useRef<Menu>(null);
  const audioMenu = useRef<Menu>(null);
  // Widening the window unmounts the menu without an onHide.
  useEffect(() => {
    if (!narrow) onMenuVisibleChange(false);
  }, [narrow, onMenuVisibleChange]);
  const moreItems: MenuItem[] = [
    { label: t("fileInfo"), icon: "pi pi-info-circle", command: onInfo },
    ...(keyboard ? [{ label: t("shortcutsTitle"), icon: "pi pi-question-circle", command: onHelp }] : []),
    { label: t("settings"), icon: "pi pi-cog", command: onSettings },
    { separator: true },
    {
      label: audioMenuLabel(),
      icon: "pi pi-headphones",
      command: () => setTimeout(() => audioMenu.current?.show({ currentTarget: moreButton.current } as never)),
    },
    {
      label: `${t("aspect")}: ${aspectLabel(player.aspect)}`,
      icon: "pi pi-expand",
      // Opens from the ⋯ button once this menu has closed.
      command: () => setTimeout(() => aspectMenu.current?.show({ currentTarget: moreButton.current } as never)),
    },
    // Phone apps already fill the screen.
    ...(isAndroid ? [] : [{ label: t("fullscreen"), icon: "pi pi-window-maximize", command: () => void api.toggleFullscreen() }]),
  ];
  const aspectItems: MenuItem[] = [
    {
      label: t("aspect"),
      items: ASPECTS.map((a) => ({
        label: aspectLabel(a),
        icon: a === player.aspect ? "pi pi-check" : "pi pi-fw",
        command: () => player.setAspect(a),
      })),
    },
  ];
  const audio = audioItems((label, icon, command, disabled) => ({ label, icon: icon ?? "pi pi-fw", command, disabled }));
  const audioMenuItems: MenuItem[] = [
    ...(audio.tracks.length ? [{ label: t("audioTrack"), items: audio.tracks }, { separator: true }] : []),
    ...audio.actions,
  ];
  const [dragging, setDragging] = useState<number | null>(null);
  const time = dragging ?? p.time;
  const duration = Math.max(p.duration, 0.1);
  const fade = `transition-opacity duration-300 ${visible ? "opacity-100" : "pointer-events-none opacity-0"}`;
  // Smaller buttons on phones, so the whole bar fits a 320px-wide screen.
  const size = narrow ? "size-10" : "";
  const plain = `${size} text-white`;
  const popupAlignment = getLang() === "fa" ? "left" : "right";
  // Locked controls stay in view, dimmed, so it's clear why they don't respond.
  const disabled = `transition-opacity duration-200 ${locked ? "opacity-35" : ""}`;

  const seek = (to: number) => {
    clock.jump(to);
    void api.seekAbsolute(to);
  };

  return (
    <>
      <div className={`absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/75 to-transparent px-2 pb-10 pt-2 sm:gap-3 sm:px-4 sm:pt-3 ${fade}`}>
        <div inert={locked} className={`flex min-w-0 flex-1 items-center gap-2 sm:gap-3 ${disabled}`}>
          <Button
            icon="pi pi-arrow-left rtl:rotate-180"
            rounded
            text
            severity="secondary"
            aria-label={t("back")}
            tooltip={t("back")}
            tooltipOptions={{ position: "bottom" }}
            onClick={onBack}
            className="shrink-0 text-white"
          />
          <h1 className="min-w-0 truncate text-base font-semibold drop-shadow sm:text-lg" dir="auto">
            {player.media?.title}
          </h1>
        </div>
        <Button
          icon={locked ? "pi pi-lock" : "pi pi-lock-open"}
          rounded
          text={!locked}
          aria-label={lockLabel}
          aria-pressed={locked}
          tooltip={keyboard && lockKey ? `${lockLabel} (${keyParts(lockKey).join("+")})` : lockLabel}
          tooltipOptions={{ position: "bottom" }}
          onClick={onToggleLock}
          className={`shrink-0 ${locked ? "" : "text-white"}`}
        />
      </div>

      <div
        inert={locked}
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/50 to-transparent px-2 pb-2 pt-12 sm:px-5 sm:pb-3 ${fade}`}
      >
        <div className={disabled}>
          <div dir="ltr" className="px-2 sm:px-1">
            <SeekBar time={time} duration={duration} onScrub={setDragging} onSeek={seek} />
          </div>
          <div className="mt-2 flex items-center gap-0.5 sm:mt-3 sm:gap-1">
            <Button
              icon={p.paused ? "pi pi-play" : "pi pi-pause"}
              rounded
              text
              aria-label={p.paused ? t("play") : t("pause")}
              onClick={() => void api.togglePause()}
              className={plain}
            />
            <span className="ms-1 min-w-0 truncate whitespace-nowrap text-sm tabular-nums text-zinc-200 sm:ms-2" dir="ltr">
              {fmtTime(time)} <span className="text-zinc-500">/ {fmtTime(p.duration)}</span>
            </span>
            <div className="flex-1" />
            {/* Both work on the selected subtitle track's lines. */}
            {player.selectedView() && (
              <>
                <Button
                  icon="pi pi-stopwatch"
                  rounded
                  text={!player.autoPause}
                  aria-label={t("autoPause")}
                  aria-pressed={player.autoPause}
                  tooltip={`${t("autoPause")} (P)`}
                  tooltipOptions={{ position: "top" }}
                  onClick={() => player.toggleAutoPause()}
                  className={player.autoPause ? size : plain}
                />
                <Button
                  icon="pi pi-align-left"
                  rounded
                  text
                  aria-label={t("transcript")}
                  tooltip={`${t("transcript")} (R)`}
                  tooltipOptions={{ position: "top" }}
                  onClick={onToggleTranscript}
                  className={plain}
                />
              </>
            )}
            <Button
              icon="pi pi-comments"
              rounded
              text
              aria-label={t("tracks")}
              tooltip={`${t("tracks")} (L)`}
              tooltipOptions={{ position: "top" }}
              onClick={onToggleSubtitles}
              className={plain}
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
                  onClick={(e) => {
                    moreButton.current = e.currentTarget;
                    more.current?.toggle(e);
                  }}
                  className={plain}
                />
                <Menu
                  ref={more}
                  model={moreItems}
                  popup
                  popupAlignment={popupAlignment}
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
                  className={plain}
                />
                {keyboard && (
                  <Button
                    icon="pi pi-question-circle"
                    rounded
                    text
                    aria-label={t("shortcutsTitle")}
                    tooltip={`${t("shortcutsTitle")} (?)`}
                    tooltipOptions={{ position: "top" }}
                    onClick={onHelp}
                    className={plain}
                  />
                )}
                <Button
                  icon="pi pi-cog"
                  rounded
                  text
                  aria-label={t("settings")}
                  tooltip={`${t("settings")} (,)`}
                  tooltipOptions={{ position: "top" }}
                  onClick={onSettings}
                  className={plain}
                />
                <Button
                  icon="pi pi-headphones"
                  rounded
                  text
                  aria-label={t("audioTrack")}
                  aria-haspopup="menu"
                  tooltip={audioKey ? `${t("audioTrack")} (${keyParts(audioKey).join("+")})` : t("audioTrack")}
                  tooltipOptions={{ position: "top" }}
                  onClick={(e) => audioMenu.current?.toggle(e)}
                  className={plain}
                />
                <Button
                  icon="pi pi-expand"
                  rounded
                  text
                  aria-label={t("aspect")}
                  aria-haspopup="menu"
                  tooltip={`${t("aspect")} (Z)`}
                  tooltipOptions={{ position: "top" }}
                  onClick={(e) => aspectMenu.current?.toggle(e)}
                  className={plain}
                />
                {/* Phone apps already fill the screen. */}
                {!isAndroid && (
                  <Button
                    icon="pi pi-window-maximize"
                    rounded
                    text
                    aria-label={t("fullscreen")}
                    tooltip={`${t("fullscreen")} (F)`}
                    tooltipOptions={{ position: "top" }}
                    onClick={() => void api.toggleFullscreen()}
                    className={plain}
                  />
                )}
              </>
            )}
            <Menu
              ref={audioMenu}
              model={audioMenuItems}
              popup
              popupAlignment={popupAlignment}
              transitionOptions={popupMotions.connected}
              className="max-w-[min(24rem,92vw)]"
              onShow={() => onMenuVisibleChange(true)}
              onHide={() => onMenuVisibleChange(false)}
            />
            <Menu
              ref={aspectMenu}
              model={aspectItems}
              popup
              popupAlignment={popupAlignment}
              transitionOptions={popupMotions.connected}
              onShow={() => onMenuVisibleChange(true)}
              onHide={() => onMenuVisibleChange(false)}
            />
          </div>
        </div>
      </div>
    </>
  );
}
