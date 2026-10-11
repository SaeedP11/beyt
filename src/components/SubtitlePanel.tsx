import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "primereact/button";
import { Checkbox } from "primereact/checkbox";
import { ColorPicker } from "primereact/colorpicker";
import { InputNumber } from "primereact/inputnumber";
import { InputSwitch } from "primereact/inputswitch";
import { SelectButton } from "primereact/selectbutton";
import { Sidebar } from "primereact/sidebar";
import { Slider } from "primereact/slider";
import { Tag } from "primereact/tag";

import { usePlayer } from "../hooks";
import { t } from "../i18n";
import type { TrackView } from "../overlay";
import { trackLabel } from "../player";
import type { Mode, Position, TrackStyle } from "../types";
import { toast } from "../ui";

interface Props {
  visible: boolean;
  rtl: boolean;
  onHide: () => void;
}

export function SubtitlePanel({ visible, rtl, onHide }: Props) {
  const player = usePlayer();

  const addFile = async () => {
    const path = await open({
      multiple: false,
      directory: false,
      defaultPath: player.media?.folder,
      filters: [{ name: t("tracks"), extensions: ["srt", "vtt"] }],
    });
    if (typeof path !== "string") return;
    try {
      await player.addSubtitle(path);
    } catch (e) {
      toast(String(e), 5000);
    }
  };

  return (
    <Sidebar
      visible={visible}
      onHide={onHide}
      position={rtl ? "left" : "right"}
      modal={false}
      className="panel w-[min(24rem,92vw)]"
      header={<h2 className="text-lg font-semibold">{t("tracks")}</h2>}
    >
      <div className="flex flex-col gap-3">
        {player.views.length === 0 && <p className="py-6 text-center text-zinc-400">{t("noTracks")}</p>}
        {player.views.map((view) => (
          <TrackCard
            key={view.track.id}
            view={view}
            onChange={(patch) => player.updateStyle(view, patch)}
          />
        ))}
        <Button
          icon="pi pi-plus"
          label={t("addSubtitle")}
          outlined
          className="mt-2 w-full"
          onClick={() => void addFile()}
        />
      </div>
    </Sidebar>
  );
}

function TrackCard({ view, onChange }: { view: TrackView; onChange: (patch: Partial<TrackStyle>) => void }) {
  const { track, style } = view;
  const editable = style.enabled && view.isText;

  return (
    <div
      className={`rounded-xl border p-3 transition ${
        style.enabled ? "border-accent/40 bg-ink-850" : "border-ink-700 bg-ink-900/60"
      }`}
    >
      <label className="flex cursor-pointer items-start gap-3" title={track.error ?? undefined}>
        <InputSwitch
          checked={style.enabled}
          disabled={track.status === "failed"}
          onChange={(e) => onChange({ enabled: !!e.value })}
          className="mt-0.5 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold" dir="auto">
            {trackLabel(track)}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {track.source.kind === "embedded" && <Tag value={t("embedded")} severity="secondary" />}
            {track.source.kind === "embedded" && track.source.forced && <Tag value={t("forced")} severity="warning" />}
            {track.status === "loading" && <Tag value={t("loading")} severity="info" icon="pi pi-spin pi-spinner" />}
            {track.status === "image" && <Tag value={t("imageTrack")} severity="secondary" />}
            {track.status === "failed" && <Tag value={t("failed")} severity="danger" />}
          </div>
        </div>
      </label>

      {editable && (
        <div className="mt-4 grid grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-3 text-sm">
          <span className="text-zinc-400">{t("position")}</span>
          <SelectButton
            value={style.position}
            options={(["bottom", "top"] as Position[]).map((v) => ({ label: t(v), value: v }))}
            onChange={(e) => e.value && onChange({ position: e.value as Position })}
            allowEmpty={false}
            pt={{ button: { className: "py-1.5 px-3 text-sm" } }}
          />

          <span className="text-zinc-400">{t("mode")}</span>
          <SelectButton
            value={style.mode}
            options={(["show", "blur", "hide"] as Mode[]).map((v) => ({ label: t(v), value: v }))}
            onChange={(e) => e.value && onChange({ mode: e.value as Mode })}
            allowEmpty={false}
            pt={{ button: { className: "py-1.5 px-3 text-sm" } }}
          />

          <span className="text-zinc-400">{t("size")}</span>
          <div className="flex items-center gap-3" dir="ltr">
            <Slider
              value={style.size}
              min={16}
              max={64}
              onChange={(e) => onChange({ size: e.value as number })}
              className="flex-1"
            />
            <span className="w-7 text-end tabular-nums text-zinc-400">{style.size}</span>
          </div>

          <span className="text-zinc-400">{t("color")}</span>
          <div className="flex items-center gap-4">
            <ColorPicker
              value={style.color.replace("#", "")}
              onChange={(e) => typeof e.value === "string" && onChange({ color: `#${e.value}` })}
            />
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox checked={style.boxed} onChange={(e) => onChange({ boxed: !!e.checked })} />
              <span>{t("boxed")}</span>
            </label>
          </div>

          <span className="text-zinc-400">{t("offset")}</span>
          <div dir="ltr">
            <InputNumber
              value={style.offset}
              onValueChange={(e) => onChange({ offset: Math.round((e.value ?? 0) * 10) / 10 })}
              showButtons
              buttonLayout="horizontal"
              step={0.1}
              minFractionDigits={1}
              maxFractionDigits={1}
              suffix=" s"
              decrementButtonIcon="pi pi-minus"
              incrementButtonIcon="pi pi-plus"
              inputClassName="w-20 text-center"
            />
          </div>
        </div>
      )}
    </div>
  );
}
