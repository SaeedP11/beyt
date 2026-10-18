import { ConfirmDialog, confirmDialog } from "primereact/confirmdialog";
import { ConfirmPopup, confirmPopup } from "primereact/confirmpopup";

import { popupMotions, useDialogMotion } from "../motion";
import { sheetEdge } from "../sheet";

interface Options {
  message: string;
  icon: string;
  accept: () => void;
}

/**
 * Asks before a destructive action: a popup next to the button that asked,
 * or a sheet on small screens. Needs a `<ConfirmHost />` mounted.
 */
export function confirm(target: HTMLElement, { message, icon, accept }: Options): void {
  const shared = { message, icon, accept, acceptClassName: "p-button-danger" };
  if (sheetEdge()) confirmDialog({ ...shared, defaultFocus: "reject" });
  else confirmPopup({ ...shared, target, transitionOptions: popupMotions.connected });
}

/** Where `confirm` shows its questions. */
export function ConfirmHost() {
  const motion = useDialogMotion();
  return (
    <>
      <ConfirmPopup />
      <ConfirmDialog
        {...motion}
        draggable={false}
        dismissableMask
        className="w-[min(26rem,95vw)]"
      />
    </>
  );
}
