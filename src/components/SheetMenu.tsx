// Menus on small screens: a sheet of large rows from the screen's edge (see
// sheet.ts) in place of a small popup next to the button that opened it.

import { Menu } from "primereact/menu";
import type { MenuItem } from "primereact/menuitem";
import { Sidebar } from "primereact/sidebar";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";

import { getLang } from "../i18n";
import { popupMotions, usePanelMotion } from "../motion";
import { sheetEdge, useSheetEdge } from "../sheet";

interface ListProps {
  items: MenuItem[];
  onPick: () => void;
  /**
   * How an item with `items` shows them: as a submenu that opens in place
   * (a right-click menu's submenus), or as a titled group always shown (a
   * popup Menu's groups).
   */
  nested?: "submenu" | "group";
}

/** A menu as a list of large rows for a sheet. */
export function SheetMenu({ items, onPick, nested = "submenu" }: ListProps) {
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <ul className="flex flex-col">
      {items.map((item, i) => {
        if (item.separator) return <li key={i} role="separator" className="mx-3 my-1 border-t border-ink-700" />;
        const sub = item.items as MenuItem[] | undefined;
        if (sub && nested === "group") {
          return (
            <li key={i}>
              <div className="px-3 pb-1 pt-3 text-xs font-semibold tracking-wide text-zinc-500">{item.label}</div>
              <SheetMenu items={sub} onPick={onPick} nested="group" />
            </li>
          );
        }
        const open = expanded === i;
        const danger = item.className?.split(" ").includes("danger");
        return (
          <li key={i}>
            <button
              type="button"
              aria-expanded={sub ? open : undefined}
              disabled={item.disabled === true}
              onClick={(e) => {
                if (sub) return setExpanded(open ? null : i);
                onPick();
                item.command?.({ originalEvent: e, item });
              }}
              className={`flex w-full items-center gap-4 rounded-lg px-3 py-3 text-start transition hover:bg-ink-800 active:bg-ink-700 disabled:opacity-40 disabled:hover:bg-transparent ${danger ? "text-red-400" : "text-zinc-100"}`}
            >
              <span className={`w-4 shrink-0 ${danger ? "" : "text-zinc-400"} ${typeof item.icon === "string" ? item.icon : ""}`} />
              <span className="min-w-0 flex-1 truncate" dir="auto">
                {item.label}
              </span>
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

/** A sheet holding a menu, with an optional title in its header. */
export function MenuSheet({
  visible,
  title,
  items,
  nested,
  onHide,
}: {
  visible: boolean;
  title?: string;
  items: MenuItem[];
  nested?: ListProps["nested"];
  onHide: () => void;
}) {
  const edge = useSheetEdge();
  const motion = usePanelMotion(edge === "left" ? "left" : "right");
  // Mounted while a sheet could open, and while one closes after the screen grew.
  if (!edge && !visible) return null;
  return (
    <Sidebar
      visible={visible}
      onHide={onHide}
      {...motion}
      header={title && <span className="truncate text-base font-semibold" dir="auto">{title}</span>}
      pt={{ content: { className: "px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-0" } }}
    >
      <SheetMenu items={items} onPick={onHide} nested={nested} />
    </Sidebar>
  );
}

export interface PopupMenuHandle {
  show: (e: React.SyntheticEvent) => void;
  toggle: (e: React.SyntheticEvent) => void;
}

interface PopupMenuProps {
  model: MenuItem[];
  /** The sheet's title on small screens. */
  title?: string;
  className?: string;
  onShow?: () => void;
  onHide?: () => void;
}

/**
 * A popup `Menu` next to the button that opened it, or on small screens a
 * sheet from the screen's edge (see sheet.ts). Items with `items` are groups.
 */
export const PopupMenu = forwardRef<PopupMenuHandle, PopupMenuProps>(function PopupMenu(
  { model, title, className, onShow, onHide },
  ref,
) {
  const menu = useRef<Menu>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const open = useRef(false);
  const latest = useRef({ onShow, onHide });
  latest.current = { onShow, onHide };

  const setSheet = (visible: boolean) => {
    open.current = visible;
    setSheetOpen(visible);
    (visible ? latest.current.onShow : latest.current.onHide)?.();
  };

  useImperativeHandle(ref, () => ({
    show: (e) => (sheetEdge() ? setSheet(true) : menu.current?.show(e)),
    toggle: (e) => (sheetEdge() ? setSheet(!open.current) : menu.current?.toggle(e)),
  }));

  return (
    <>
      <Menu
        ref={menu}
        model={model}
        popup
        popupAlignment={getLang() === "fa" ? "left" : "right"}
        transitionOptions={popupMotions.connected}
        className={className}
        onShow={onShow}
        onHide={onHide}
      />
      <MenuSheet visible={sheetOpen} title={title} items={model} nested="group" onHide={() => setSheet(false)} />
    </>
  );
});
