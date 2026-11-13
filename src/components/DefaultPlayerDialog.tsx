import { Button } from "primereact/button";
import { Dialog } from "primereact/dialog";

import { isAndroid } from "../api";
import { t } from "../i18n";
import { useDialogMotion } from "../motion";

interface Props {
  visible: boolean;
  onHide: () => void;
  onSkip: () => void;
  onSetDefault: () => void;
  loading?: boolean;
}

export function DefaultPlayerDialog({ visible, onHide, onSkip, onSetDefault, loading }: Props) {
  const motion = useDialogMotion();

  return (
    <Dialog
      visible={visible}
      onHide={onHide}
      dismissableMask
      draggable={false}
      showHeader={false}
      className="w-[min(28rem,95vw)] overflow-hidden"
      contentClassName="!p-0"
      {...motion}
    >
      <div className="flex flex-col gap-4 p-6 text-center sm:text-start">
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-accent/30 bg-accent/15 text-accent shadow-sm">
            <i className="pi pi-play text-xl" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-semibold text-white">
              {t("setDefaultPlayerTitle")}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-zinc-400">
              {t("setDefaultPlayerBody")}
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-white/5 bg-ink-850/60 p-3 text-start">
          <div className="flex items-start gap-2">
            <i className="pi pi-info-circle mt-0.5 shrink-0 text-xs text-accent" />
            <p className="text-[11px] leading-relaxed text-zinc-300">
              {isAndroid ? t("setDefaultPlayerHintAndroid") : t("setDefaultPlayerHintDesktop")}
            </p>
          </div>
        </div>

        <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            label={t("setDefaultPlayerSkip")}
            outlined
            severity="secondary"
            size="small"
            className="justify-center"
            onClick={onSkip}
            disabled={loading}
          />
          <Button
            label={t("setDefaultPlayerAction")}
            icon="pi pi-check"
            size="small"
            className="justify-center"
            onClick={onSetDefault}
            loading={loading}
          />
        </div>
      </div>
    </Dialog>
  );
}
