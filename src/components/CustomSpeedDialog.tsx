import { Button } from "primereact/button";
import { Dialog } from "primereact/dialog";
import { Slider } from "primereact/slider";
import { useEffect, useState } from "react";

import { api } from "../api";
import { t } from "../i18n";
import { useDialogMotion } from "../motion";
import { formatSpeed, SPEEDS } from "../player";
import { toast } from "../ui";

interface Props {
  visible: boolean;
  currentSpeed: number;
  onHide: () => void;
}

export function CustomSpeedDialog({ visible, currentSpeed, onHide }: Props) {
  const motion = useDialogMotion();
  const [speed, setSpeed] = useState(currentSpeed);

  useEffect(() => {
    if (visible) setSpeed(currentSpeed);
  }, [visible, currentSpeed]);

  const applySpeed = (val: number) => {
    const clamped = Math.min(4, Math.max(0.25, Math.round(val * 100) / 100));
    setSpeed(clamped);
    void api.setMpvOption("speed", String(clamped));
  };

  const handleClose = () => {
    toast(t("speedToast", { n: speed === 1 ? "1.0" : formatSpeed(speed).replace("×", "") }));
    onHide();
  };

  return (
    <Dialog
      header={t("customSpeedTitle")}
      visible={visible}
      onHide={handleClose}
      className="w-[min(26rem,95vw)]"
      dismissableMask
      draggable={false}
      {...motion}
    >
      <div className="flex flex-col items-center gap-5 py-2">
        <div className="text-4xl font-bold tabular-nums text-primary-500 drop-shadow" dir="ltr">
          {formatSpeed(speed)}
        </div>

        <div className="flex w-full items-center gap-3 px-2" dir="ltr">
          <Button
            icon="pi pi-minus"
            rounded
            text
            size="small"
            aria-label="Decrease speed"
            onClick={() => applySpeed(speed - 0.05)}
            disabled={speed <= 0.25}
          />
          <Slider
            value={speed}
            min={0.25}
            max={4.0}
            step={0.05}
            onChange={(e) => typeof e.value === "number" && applySpeed(e.value)}
            className="flex-1"
          />
          <Button
            icon="pi pi-plus"
            rounded
            text
            size="small"
            aria-label="Increase speed"
            onClick={() => applySpeed(speed + 0.05)}
            disabled={speed >= 4.0}
          />
        </div>

        {/* Quick preset chips */}
        <div className="flex flex-wrap justify-center gap-1.5" dir="ltr">
          {SPEEDS.map((s) => (
            <Button
              key={s}
              label={s === 1 ? `1× (${t("speedNormal")})` : `${s}×`}
              size="small"
              rounded
              outlined={Math.abs(s - speed) >= 0.01}
              onClick={() => applySpeed(s)}
            />
          ))}
        </div>

        {/* Footer controls */}
        <div className="mt-2 flex w-full items-center justify-between border-t border-zinc-700/50 pt-3">
          <Button
            label={t("resetSpeed")}
            text
            severity="secondary"
            size="small"
            onClick={() => applySpeed(1)}
          />
          <Button
            label={t("apply")}
            size="small"
            onClick={handleClose}
          />
        </div>
      </div>
    </Dialog>
  );
}
