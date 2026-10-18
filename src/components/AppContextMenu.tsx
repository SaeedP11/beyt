import { ContextMenu } from "primereact/contextmenu";
import { Sidebar } from "primereact/sidebar";
import type { MenuItem, MenuItemOptions } from "primereact/menuitem";
import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import * as clock from "../clock";
import { player } from "../hooks";
import { t } from "../i18n";
import { type Action, type Keymap, keyParts, keysFor } from "../keymap";
import { popupMotions, usePanelMotion } from "../motion";
import { getSettings } from "../settings";
import { sheetEdge, useSheetEdge } from "../sheet";
import { toast } from "../ui";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** Right-clicks here keep the browser's menu (copy and paste). */
const NATIVE = "input, textarea, [contenteditable='true']";
/** Right-clicks here show no menu at all: an app menu over a dialog or panel would be out of place. */
const QUIET = ".p-dialog-mask, .p-sidebar-mask.p-component-overlay, .p-sidebar, .p-overlaypanel, .p-contextmenu";

interface Props {
  screen: "loading" | "library" | "player";
  /** Runs an action the same way its keyboard shortcut does. */
  runAction: (action: Action) => void;
  /** Opens the dictionary popup for a subtitle word. */
  onLookUp: (event: MouseEvent, wordEl: HTMLElement) => void;
  onBack: () => void;
  onVisibleChange: (visible: boolean) => void;
}

/**
 * A menu row: icon slot, label, then the action's first shortcut or a submenu
 * arrow at the end. Every row uses this so icons and labels line up.
 */
function row(label: string, icon: string | null, end: string | MenuItem[] | undefined, command?: () => void): MenuItem {
  const items = Array.isArray(end) ? end : undefined;
  const keys = typeof end === "string" ? end : undefined;
  return {
    label,
    // For the sheet menu; the context menu draws rows with the template.
    icon: icon ?? undefined,
    command,
    items,
    template: (_item: MenuItem, o: MenuItemOptions) => (
      <a className={`${o.className} gap-3`}>
        <span className={`${o.iconClassName} m-0! w-4 shrink-0 ${icon ?? ""}`} />
        <span className={`${o.labelClassName} flex-1`}>{label}</span>
        {keys && (
          <span className="ps-6 text-xs text-zinc-500" dir="ltr">
            {keyParts(keys).join("+")}
          </span>
        )}
        {items && <span className="pi pi-angle-right text-xs text-zinc-500 rtl:rotate-180" />}
      </a>
    ),
  };
}

/** Beyt's own right-click menu, in place of the webview's browser menu. On
    small screens (a long press on touch) it opens as a sheet instead. */
export function AppContextMenu(props: Props) {
  const menu = useRef<ContextMenu>(null);
  const [model, setModel] = useState<MenuItem[]>([]);
  const edge = useSheetEdge();
  const sheetMotion = usePanelMotion(edge === "left" ? "left" : "right");
  const [sheetOpen, setSheetOpen] = useState(false);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(NATIVE)) return;
      // Shift+right-click still reaches Inspect Element while developing.
      if (import.meta.env.DEV && e.shiftKey) return;
      e.preventDefault();
      const p = latest.current;
      if (p.screen === "loading" || target.closest(QUIET)) return;

      const keymap = getSettings().keymap;
      setModel(p.screen === "player" ? playerItems(target, e, keymap, p) : libraryItems(keymap, p.runAction));
      if (sheetEdge()) {
        setSheetOpen(true);
        p.onVisibleChange(true);
      } else {
        menu.current?.show(e as unknown as React.SyntheticEvent);
      }
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const hideSheet = () => {
    setSheetOpen(false);
    props.onVisibleChange(false);
  };

  return (
    <>
      <ContextMenu
        transitionOptions={popupMotions.contextMenu}
        ref={menu}
        model={model}
        className="min-w-60"
        onShow={() => props.onVisibleChange(true)}
        onHide={() => props.onVisibleChange(false)}
      />
      {(edge || sheetOpen) && (
        <Sidebar visible={sheetOpen} onHide={hideSheet} {...sheetMotion} pt={{ content: { className: "px-2 pb-3 pt-0" } }}>
          <SheetMenu items={model} onPick={hideSheet} />
        </Sidebar>
      )}
    </>
  );
}

/** The menu as a list of large rows for a sheet; a submenu opens in place. */
function SheetMenu({ items, onPick }: { items: MenuItem[]; onPick: () => void }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <ul className="flex flex-col">
      {items.map((item, i) => {
        if (item.separator) return <li key={i} role="separator" className="mx-3 my-1 border-t border-ink-700" />;
        const sub = item.items as MenuItem[] | undefined;
        const open = expanded === i;
        return (
          <li key={i}>
            <button
              type="button"
              aria-expanded={sub ? open : undefined}
              onClick={(e) => {
                if (sub) return setExpanded(open ? null : i);
                onPick();
                item.command?.({ originalEvent: e, item });
              }}
              className="flex w-full items-center gap-4 rounded-lg px-3 py-3 text-start text-zinc-100 transition hover:bg-ink-800 active:bg-ink-700"
            >
              <span className={`w-4 shrink-0 text-zinc-400 ${typeof item.icon === "string" ? item.icon : ""}`} />
              <span className="flex-1">{item.label}</span>
              {sub && <span className={`pi pi-angle-down text-xs text-zinc-500 transition ${open ? "rotate-180" : ""}`} />}
            </button>
            {sub && open && (
              <div className="ps-8">
                <SheetMenu items={sub} onPick={onPick} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function actionRow(action: Action, label: string, icon: string | null, keymap: Keymap, run: (a: Action) => void) {
  return row(label, icon, keysFor(action, keymap)[0], () => run(action));
}

function libraryItems(keymap: Keymap, run: (a: Action) => void): MenuItem[] {
  return [
    actionRow("help", t("shortcutsTitle"), "pi pi-question-circle", keymap, run),
    actionRow("settings", t("settings"), "pi pi-cog", keymap, run),
    actionRow("fullscreen", t("fullscreen"), "pi pi-window-maximize", keymap, run),
    { separator: true },
    actionRow("quit", t("act_quit"), "pi pi-power-off", keymap, run),
  ];
}

function playerItems(
  target: HTMLElement,
  event: MouseEvent,
  keymap: Keymap,
  { runAction: run, onLookUp, onBack }: Props,
): MenuItem[] {
  const items: MenuItem[] = [];

  // A subtitle line under the pointer comes first: that's what was clicked.
  const line = target.closest(".track .line") ? player.lineAt(target) : null;
  if (line) {
    const isWord = target.tagName === "SPAN" && !target.classList.contains("line");
    const word = isWord ? (target.textContent ?? "").trim() : "";
    if (word) {
      // After the menu's own click has finished, or the popup would see it as an outside click.
      items.push(row(t("lookUp", { word }), "pi pi-book", undefined, () => setTimeout(() => onLookUp(event, target))));
    }
    items.push(
      row(t("playThisLine"), "pi pi-replay", undefined, () => player.playLine(line)),
      row(t("copyLine"), "pi pi-copy", undefined, () => {
        void navigator.clipboard.writeText(line.cue.text).then(() => toast(t("copied")));
      }),
      row(t("saveThisLine"), "pi pi-bookmark", undefined, () => void player.saveLine(line)),
      { separator: true },
    );
  }

  const { paused, speed } = clock.snapshot();
  items.push(
    actionRow("togglePause", paused ? t("play") : t("pause"), paused ? "pi pi-play" : "pi pi-pause", keymap, run),
  );
  if (!line) items.push(actionRow("replayLine", t("act_replayLine"), "pi pi-replay", keymap, run));
  items.push(
    actionRow("autoPause", t("autoPause"), player.autoPause ? "pi pi-check" : null, keymap, run),
    row(
      `${t("speed")}: ${Math.abs(speed - 1) < 0.01 ? t("speedNormal") : `${speed.toFixed(2).replace(/0$/, "")}×`}`,
      "pi pi-gauge",
      SPEEDS.map((n) =>
        row(n === 1 ? t("speedNormal") : `${n}×`, Math.abs(n - speed) < 0.01 ? "pi pi-check" : null, undefined, () => {
          void api.setMpvOption("speed", String(n)).then(() => toast(t("speedToast", { n: n === 1 ? "1.0" : n })));
        }),
      ),
    ),
    { separator: true },
    actionRow("subtitles", t("tracks"), "pi pi-comments", keymap, run),
    actionRow("transcript", t("transcript"), "pi pi-align-left", keymap, run),
    actionRow("info", t("fileInfo"), "pi pi-info-circle", keymap, run),
    { separator: true },
    actionRow("fullscreen", t("fullscreen"), "pi pi-window-maximize", keymap, run),
    actionRow("help", t("shortcutsTitle"), "pi pi-question-circle", keymap, run),
    actionRow("settings", t("settings"), "pi pi-cog", keymap, run),
    { separator: true },
    // Not the "back" action: with a panel open that only closes the panel.
    row(t("back"), "pi pi-arrow-left rtl:rotate-180", keysFor("back", keymap)[0], onBack),
  );
  return items;
}
