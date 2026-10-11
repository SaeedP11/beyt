import { Button } from "primereact/button";
import { Dialog } from "primereact/dialog";
import { IconField } from "primereact/iconfield";
import { InputIcon } from "primereact/inputicon";
import { InputText } from "primereact/inputtext";
import { useState } from "react";

import { type StringKey, t } from "../i18n";
import { ACTIONS, GROUPS, keysFor } from "../keymap";
import { useSettings } from "../settings";
import { KeyCaps } from "./KeyCaps";

interface Props {
  visible: boolean;
  onHide: () => void;
  onCustomise: () => void;
}

/** Every keyboard shortcut, grouped and searchable (? or F1). */
export function ShortcutsDialog({ visible, onHide, onCustomise }: Props) {
  const { keymap } = useSettings();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const groups = GROUPS.map((group) => ({
    group,
    rows: ACTIONS.filter((a) => a.group === group)
      .map((a) => ({ id: a.id, label: t(`act_${a.id}` as StringKey), keys: keysFor(a.id, keymap) }))
      .filter((r) => !q || r.label.toLowerCase().includes(q) || r.keys.some((k) => k.toLowerCase().includes(q))),
  })).filter((g) => g.rows.length);

  return (
    <Dialog
      header={t("shortcutsTitle")}
      visible={visible}
      onHide={onHide}
      onShow={() => setQuery("")}
      className="w-[min(52rem,95vw)]"
      contentClassName="pb-2"
      dismissableMask
      draggable={false}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-start text-sm text-zinc-400">{t("helpTip")}</span>
          <Button icon="pi pi-pencil" label={t("customise")} outlined size="small" onClick={onCustomise} />
        </div>
      }
    >
      <IconField iconPosition="left" className="mb-5">
        <InputIcon className="pi pi-search" />
        <InputText
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchShortcuts")}
          className="w-full"
          autoFocus
        />
      </IconField>

      <div className="columns-1 gap-8 md:columns-2">
        {groups.map(({ group, rows }) => (
          <section key={group} className="mb-6 break-inside-avoid">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-accent">
              {t(`grp_${group}` as StringKey)}
            </h3>
            <ul className="divide-y divide-ink-700/70">
              {rows.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-4 py-2">
                  <span className="text-sm text-zinc-200">{row.label}</span>
                  <KeyCaps bindings={row.keys} empty={t("unbound")} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
