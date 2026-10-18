import { Button } from "primereact/button";
import { Checkbox } from "primereact/checkbox";
import { ColorPicker } from "primereact/colorpicker";
import { Dialog } from "primereact/dialog";
import { Dropdown } from "primereact/dropdown";
import { InputNumber } from "primereact/inputnumber";
import { InputSwitch } from "primereact/inputswitch";
import { InputText } from "primereact/inputtext";
import { MultiSelect } from "primereact/multiselect";
import { SelectButton } from "primereact/selectbutton";
import { Slider } from "primereact/slider";
import { type ReactNode, createContext, useContext, useEffect, useState } from "react";

import { type Brightness, api } from "../api";
import { player } from "../hooks";
import { type StringKey, languageName, t } from "../i18n";
import { ACTIONS, type Action, DEFAULT_KEYS, GROUPS, eventKey, keysFor } from "../keymap";
import { type Settings, type SubtitleDefault, resetSettings, updateSettings, useSettings } from "../settings";
import { popupMotions, useDialogMotion } from "../motion";
import type { Position } from "../types";
import { toast } from "../ui";
import { DictionaryStatus } from "./DictionaryInstall";
import { confirm as ask } from "./Confirm";
import { KeyCaps } from "./KeyCaps";

export type Section = "general" | "playback" | "subtitles" | "learning" | "anki" | "shortcuts" | "data";

export const SECTIONS: { id: Section; icon: string; label: StringKey; summary: StringKey }[] = [
  { id: "general", icon: "pi pi-sliders-h", label: "secGeneral", summary: "secGeneralSummary" },
  { id: "playback", icon: "pi pi-play-circle", label: "secPlayback", summary: "secPlaybackSummary" },
  { id: "subtitles", icon: "pi pi-comments", label: "secSubtitles", summary: "secSubtitlesSummary" },
  { id: "learning", icon: "pi pi-book", label: "secLearning", summary: "secLearningSummary" },
  { id: "anki", icon: "pi pi-send", label: "secAnki", summary: "secAnkiSummary" },
  { id: "shortcuts", icon: "pi pi-key", label: "secShortcuts", summary: "secShortcutsSummary" },
  { id: "data", icon: "pi pi-database", label: "secData", summary: "secDataSummary" },
];

const LANGUAGES = ["fa", "en", "ar", "tr", "fr", "de", "es", "it", "ru", "ja", "ko", "zh"];
const PERSIAN_FONTS = ["Vazirmatn", "Noto Naskh Arabic", "Noto Sans Arabic", "Sahel", "Samim", "Shabnam", "IRANSans"];
const LATIN_FONTS = ["Inter", "Noto Sans", "Roboto", "Open Sans", "Ubuntu", "DejaVu Sans", "Arial"];
const SPEEDS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];

interface Props {
  visible: boolean;
  section: Section;
  onSection: (s: Section) => void;
  onHide: () => void;
}

export function SettingsDialog({ visible, section, onSection, onHide }: Props) {
  const motion = useDialogMotion();
  // A sheet is too narrow for the side menu, so the sections become a row of tabs.
  const sheet = motion.maskClassName ? motion.position : null;
  return (
    <Dialog
      header={t("settings")}
      visible={visible}
      onHide={onHide}
      className={sheet ? "w-[min(60rem,96vw)]" : "h-[min(44rem,90dvh)] w-[min(60rem,96vw)]"}
      contentClassName={sheet === "bottom" ? "p-0" : "flex min-h-0 flex-col p-0"}
      dismissableMask
      draggable={false}
      {...motion}
    >
      {/* On narrow windows the section list becomes a scrolling strip on top. */}
      <div
        className={
          sheet === "bottom"
            ? "flex h-[72dvh] flex-col"
            : sheet
              ? "flex min-h-0 flex-1 flex-col"
              : "flex min-h-0 flex-1 flex-col md:flex-row"
        }
      >
        <nav
          className={
            sheet
              ? "flex shrink-0 gap-1 overflow-x-auto border-b border-ink-700 px-3 pb-2"
              : "flex shrink-0 gap-1 overflow-x-auto border-b border-ink-700 p-2 md:block md:w-52 md:border-e md:border-b-0"
          }
        >
          {SECTIONS.map((s) => (
            <button
              type="button"
              key={s.id}
              // Keep the open section's tab in view in the row of tabs.
              ref={sheet && section === s.id ? (el) => el?.scrollIntoView({ block: "nearest", inline: "nearest" }) : undefined}
              onClick={() => onSection(s.id)}
              className={`flex shrink-0 items-center whitespace-nowrap px-3 py-2 text-start text-sm transition ${
                sheet ? "gap-3 rounded-full" : "gap-2 rounded-lg md:mb-0.5 md:w-full md:gap-3"
              } ${section === s.id ? "bg-accent/15 font-semibold text-accent" : "text-zinc-300 hover:bg-ink-800"}`}
            >
              <i className={s.icon} />
              {t(s.label)}
            </button>
          ))}
        </nav>
        <div className={`min-h-0 min-w-0 flex-1 overflow-y-auto py-4 ${sheet ? "px-5" : "px-4 sm:px-6"}`}>
          <h2 className="mb-2 text-lg font-semibold">{t(SECTIONS.find((s) => s.id === section)!.label)}</h2>
          <SectionContent section={section} />
        </div>
      </div>
    </Dialog>
  );
}

/** One section's settings, for the dialog or the phone's settings page. */
export function SectionContent({ section }: { section: Section }) {
  switch (section) {
    case "general":
      return <General />;
    case "playback":
      return <Playback />;
    case "subtitles":
      return <Subtitles />;
    case "learning":
      return <Learning />;
    case "anki":
      return <Anki />;
    case "shortcuts":
      return <Shortcuts />;
    case "data":
      return <Data />;
  }
}

// ---------- building blocks ----------

/** Set by the phone's settings page: rows sit in cards and wide controls
    take the full width under their label. */
export const Compact = createContext(false);

/** A width class for a wide control: the full width on a phone. */
function useWide(): (desktop: string) => string {
  const compact = useContext(Compact);
  return (desktop) => (compact ? "w-full" : desktop);
}

/** Rows that belong together: on a phone, a card with an optional caption;
    in the dialog, just the rows. */
function Group({ title, children }: { title?: string; children: ReactNode }) {
  if (!useContext(Compact)) return <>{children}</>;
  return (
    <section className="mb-5">
      {title && <h3 className="mb-2 px-4 text-xs font-semibold uppercase tracking-wider text-accent">{title}</h3>}
      <div className="divide-y divide-ink-700/60 overflow-hidden rounded-2xl border border-ink-700/60 bg-ink-900">{children}</div>
    </section>
  );
}

/** `stack`: on a phone, the control goes under its label at full width. */
function Row({ label, hint, stack, children }: { label: string; hint?: string; stack?: boolean; children: ReactNode }) {
  if (useContext(Compact)) {
    return (
      <div className={`flex min-h-14 gap-3 px-4 py-3 ${stack ? "flex-col" : "items-center"}`}>
        <div className="min-w-0 flex-1">
          <div className="text-[0.9375rem] font-medium text-zinc-100">{label}</div>
          {hint && <div className="mt-0.5 text-xs leading-relaxed text-zinc-400">{hint}</div>}
        </div>
        <div className={`flex items-center gap-3 ${stack ? "w-full" : "shrink-0"}`}>{children}</div>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-ink-700/70 py-4 last:border-b-0">
      <div className="min-w-48 flex-1">
        <div className="text-sm font-medium text-zinc-100">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-zinc-400">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  );
}

function Switch({ name }: { name: { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings] }) {
  const s = useSettings();
  return <InputSwitch checked={s[name]} onChange={(e) => updateSettings({ [name]: !!e.value })} />;
}

function SliderValue({
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const wide = useWide();
  return (
    <div className={`flex items-center gap-3 ${wide("w-56 sm:w-64")}`} dir="ltr">
      <Slider value={value} min={min} max={max} step={step} onChange={(e) => onChange(e.value as number)} className="flex-1" />
      <span className="w-14 text-end text-sm tabular-nums text-zinc-300">{format(value)}</span>
    </div>
  );
}

/** On a phone, a stepper's − and + are quiet, so a page of them isn't a wall of blue. */
function useStepperButtons(): { decrementButtonClassName?: string; incrementButtonClassName?: string } {
  const quiet = "p-button-text p-button-secondary";
  return useContext(Compact) ? { decrementButtonClassName: quiet, incrementButtonClassName: quiet } : {};
}

function Seconds({ value, min, max, step, onChange, disabled }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; disabled?: boolean }) {
  const buttons = useStepperButtons();
  return (
    <div dir="ltr">
      <InputNumber
        value={value}
        min={min}
        max={max}
        step={step}
        minFractionDigits={step < 1 ? 1 : 0}
        maxFractionDigits={step < 1 ? 1 : 0}
        showButtons
        buttonLayout="horizontal"
        decrementButtonIcon="pi pi-minus"
        incrementButtonIcon="pi pi-plus"
        {...buttons}
        suffix={` ${t("unitSeconds")}`}
        disabled={disabled}
        onValueChange={(e) => e.value != null && onChange(e.value)}
        inputClassName="w-20 text-center"
      />
    </div>
  );
}

// ---------- sections ----------

function General() {
  const s = useSettings();
  const wide = useWide();
  return (
    <>
      <Group>
        <Row label={t("uiLanguage")} hint={t("uiLanguageHint")} stack>
          <Dropdown
            transitionOptions={popupMotions.connected}
            value={s.uiLanguage ?? "system"}
            options={[
              { label: t("systemLanguage"), value: "system" },
              { label: "English", value: "en" },
              { label: "فارسی", value: "fa" },
            ]}
            onChange={(e) => updateSettings({ uiLanguage: e.value === "system" ? null : e.value })}
            className={wide("w-48")}
          />
        </Row>
      </Group>
      <Group>
        <Row label={t("resumePlayback")} hint={t("resumeHint")}>
          <Switch name="resumePlayback" />
        </Row>
        <Row label={t("autoplayNext")} hint={t("autoplayHint")}>
          <Switch name="autoplayNext" />
        </Row>
        <Row label={t("autoplayDelay")}>
          <Seconds value={s.autoplayDelay} min={2} max={30} step={1} disabled={!s.autoplayNext} onChange={(v) => updateSettings({ autoplayDelay: v })} />
        </Row>
      </Group>
      <Group>
        <Row label={t("seekStep")}>
          <Seconds value={s.seekStep} min={1} max={60} step={1} onChange={(v) => updateSettings({ seekStep: v })} />
        </Row>
        <Row label={t("controlsHide")}>
          <Seconds value={s.controlsHideDelay} min={1} max={10} step={0.5} onChange={(v) => updateSettings({ controlsHideDelay: v })} />
        </Row>
      </Group>
    </>
  );
}

function Playback() {
  const s = useSettings();
  const wide = useWide();
  return (
    <>
      <Group>
        <Row label={t("hwdec")} hint={t("hwdecHint")}>
          <InputSwitch checked={s.hwdec !== "no"} onChange={(e) => updateSettings({ hwdec: e.value ? "auto-safe" : "no" })} />
        </Row>
        <Row label={t("defaultSpeed")} stack>
          <Dropdown
            transitionOptions={popupMotions.connected}
            value={s.defaultSpeed}
            options={SPEEDS.map((v) => ({ label: `${v}×`, value: v }))}
            onChange={(e) => updateSettings({ defaultSpeed: e.value })}
            className={wide("w-32")}
          />
        </Row>
        <Row label={t("defaultVolume")} stack>
          <SliderValue value={s.defaultVolume} min={0} max={130} step={5} format={(v) => `${v}%`} onChange={(v) => updateSettings({ defaultVolume: v })} />
        </Row>
        <BrightnessRow />
      </Group>
    </>
  );
}

/** The screen's brightness right now (not a saved setting): the backlight,
    or the picture where there is none. Hidden if neither can be read. */
function BrightnessRow() {
  const [b, setB] = useState<Brightness | null>(null);
  useEffect(() => {
    api.getBrightness().then(setB, () => setB(null));
  }, []);
  if (!b) return null;

  const backlight = b.source === "backlight";
  const change = (level: number) => {
    setB({ ...b, level });
    void player.setBrightness(level);
  };
  return (
    <Row label={t("brightness")} hint={t(backlight ? "brightnessBacklightHint" : "brightnessVideoHint")} stack>
      <SliderValue value={b.level} min={backlight ? 5 : 50} max={backlight ? 100 : 115} step={5} format={(v) => `${v}%`} onChange={change} />
    </Row>
  );
}

function Preview() {
  const s = useSettings();
  const compact = useContext(Compact);
  const line = (d: SubtitleDefault, text: string, persian: boolean) => (
    <div
      dir={persian ? "rtl" : "ltr"}
      style={{
        fontSize: d.size * 0.6,
        color: d.color,
        fontFamily: persian ? "var(--sub-font-persian)" : "var(--sub-font-latin)",
        textShadow: "var(--sub-outline)",
      }}
    >
      <span className={d.boxed ? "rounded-md bg-black/55 px-2" : ""}>{text}</span>
    </div>
  );
  // On a phone it stays in view while the controls under it scroll.
  return (
    <div
      className={`overflow-hidden rounded-xl border border-ink-700 bg-[linear-gradient(135deg,#2b3a55,#3d2b44_55%,#1f2b2a)] ${
        compact ? "sticky top-0 z-10 mb-5 shadow-lg shadow-ink-950/60" : "mt-3 mb-2"
      }`}
    >
      <div className="px-3 pt-2 text-[0.65rem] font-semibold uppercase tracking-wider text-white/60">{t("preview")}</div>
      <div
        className={`flex ${compact ? "h-28" : "h-36"} flex-col items-center justify-end pb-[var(--sub-bottom)] text-center`}
        style={{ gap: "var(--sub-gap)" }}
      >
        {line(s.subtitleDefaults.en, "Hello, how are you?", false)}
        {line(s.subtitleDefaults.fa, "سلام، حالت چطوره؟", true)}
      </div>
    </div>
  );
}

function StyleCard({ title, value, onChange }: { title: string; value: SubtitleDefault; onChange: (v: SubtitleDefault) => void }) {
  const set = (patch: Partial<SubtitleDefault>) => onChange({ ...value, ...patch });
  const compact = useContext(Compact);
  return (
    <div className={compact ? "rounded-2xl border border-ink-700/60 bg-ink-900 p-4" : "rounded-xl border border-ink-700 bg-ink-850 p-3"}>
      <div className="mb-3 text-sm font-semibold">{title}</div>
      <div className="grid grid-cols-[5rem_1fr] items-center gap-x-3 gap-y-3 text-sm">
        <span className="text-zinc-400">{t("position")}</span>
        <SelectButton
          value={value.position}
          options={(["bottom", "top"] as Position[]).map((v) => ({ label: t(v), value: v }))}
          onChange={(e) => e.value && set({ position: e.value })}
          allowEmpty={false}
          pt={{ button: { className: "py-1 px-2.5 text-xs" } }}
        />
        <span className="text-zinc-400">{t("size")}</span>
        <div className="flex items-center gap-2" dir="ltr">
          <Slider value={value.size} min={16} max={64} onChange={(e) => set({ size: e.value as number })} className="flex-1" />
          <span className="w-6 text-end tabular-nums text-zinc-400">{value.size}</span>
        </div>
        <span className="text-zinc-400">{t("color")}</span>
        <div className="flex items-center gap-3">
          <ColorPicker value={value.color.replace("#", "")} onChange={(e) => typeof e.value === "string" && set({ color: `#${e.value}` })} transitionOptions={popupMotions.connected} />
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox checked={value.boxed} onChange={(e) => set({ boxed: !!e.checked })} />
            {t("boxed")}
          </label>
        </div>
      </div>
    </div>
  );
}

function Subtitles() {
  const s = useSettings();
  const setDefault = (lang: keyof Settings["subtitleDefaults"]) => (v: SubtitleDefault) =>
    updateSettings({ subtitleDefaults: { ...s.subtitleDefaults, [lang]: v } });
  const wide = useWide();
  const compact = useContext(Compact);
  return (
    <>
      <Preview />
      <Group>
        <Row label={t("preferredLanguages")} hint={t("preferredHint")} stack>
          <MultiSelect
            transitionOptions={popupMotions.connected}
            value={s.preferredLanguages}
            options={LANGUAGES.map((code) => ({ label: languageName(code), value: code }))}
            onChange={(e) => updateSettings({ preferredLanguages: e.value })}
            display="chip"
            className={wide("w-64")}
          />
        </Row>
      </Group>
      <Group>
        <Row label={t("fontPersian")} hint={t("fontHint")} stack>
          <Dropdown value={s.fontPersian} options={PERSIAN_FONTS} editable onChange={(e) => updateSettings({ fontPersian: e.value })} className={wide("w-56")} transitionOptions={popupMotions.connected} />
        </Row>
        <Row label={t("fontLatin")} stack>
          <Dropdown value={s.fontLatin} options={LATIN_FONTS} editable onChange={(e) => updateSettings({ fontLatin: e.value })} className={wide("w-56")} transitionOptions={popupMotions.connected} />
        </Row>
      </Group>
      <Group>
        <Row label={t("outline")} stack>
          <SliderValue value={s.outline} min={0} max={4} step={0.5} format={(v) => `${v}px`} onChange={(v) => updateSettings({ outline: v })} />
        </Row>
        <Row label={t("trackGap")} stack>
          <SliderValue value={s.trackGap} min={0} max={1.5} step={0.05} format={(v) => `${v.toFixed(2)}em`} onChange={(v) => updateSettings({ trackGap: v })} />
        </Row>
        <Row label={t("bottomMargin")} stack>
          <SliderValue value={s.bottomMargin} min={0} max={30} step={1} format={(v) => `${v}%`} onChange={(v) => updateSettings({ bottomMargin: v })} />
        </Row>
      </Group>
      <div className={compact ? "" : "pt-4"}>
        <div className={compact ? "px-4 text-xs font-semibold uppercase tracking-wider text-accent" : "text-sm font-medium"}>{t("defaultStyles")}</div>
        <div className={`mb-3 text-xs text-zinc-400 ${compact ? "mt-1 px-4" : ""}`}>{t("defaultStylesHint")}</div>
        <div className="grid gap-3 lg:grid-cols-3">
          <StyleCard title={languageName("fa")} value={s.subtitleDefaults.fa} onChange={setDefault("fa")} />
          <StyleCard title={languageName("en")} value={s.subtitleDefaults.en} onChange={setDefault("en")} />
          <StyleCard title={t("otherLanguages")} value={s.subtitleDefaults.other} onChange={setDefault("other")} />
        </div>
      </div>
    </>
  );
}

function Learning() {
  const s = useSettings();
  const buttons = useStepperButtons();
  return (
    <>
      <Group>
        <Row label={t("autoPauseDefault")}>
          <Switch name="autoPauseDefault" />
        </Row>
        <Row label={t("popupPauses")}>
          <Switch name="popupPauses" />
        </Row>
        <Row label={t("clipPadding")} hint={t("clipPaddingHint")}>
          <div dir="ltr">
            <InputNumber
              value={s.clipPadding}
              min={0}
              max={2000}
              step={50}
              showButtons
              buttonLayout="horizontal"
              decrementButtonIcon="pi pi-minus"
              incrementButtonIcon="pi pi-plus"
              {...buttons}
              suffix=" ms"
              onValueChange={(e) => e.value != null && updateSettings({ clipPadding: e.value })}
              inputClassName="w-24 text-center"
            />
          </div>
        </Row>
        <Row label={t("saveScreenshots")}>
          <Switch name="saveScreenshots" />
        </Row>
      </Group>
      <Group>
        <Row label={t("dictionary")} hint={t("dictionarySettingsHint")} stack>
          <DictionaryStatus />
        </Row>
      </Group>
    </>
  );
}

function Anki() {
  const s = useSettings();
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const wide = useWide();
  const compact = useContext(Compact);
  const test = async () => {
    setTesting(true);
    try {
      const v = await api.testAnki({ url: s.ankiUrl, deck: s.ankiDeck });
      setStatus({ ok: true, text: t("ankiOk", { v }) });
    } catch (e) {
      setStatus({ ok: false, text: String(e) });
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <Group>
        <Row label={t("ankiUrl")} hint={t("ankiUrlHint")} stack>
          <InputText value={s.ankiUrl} onChange={(e) => updateSettings({ ankiUrl: e.target.value })} className={wide("w-64")} dir="ltr" />
        </Row>
        <Row label={t("ankiDeck")} stack>
          <InputText value={s.ankiDeck} onChange={(e) => updateSettings({ ankiDeck: e.target.value })} className={wide("w-64")} />
        </Row>
      </Group>
      <div className={`flex flex-wrap items-center gap-3 ${compact ? "" : "pt-4"}`}>
        <Button
          icon="pi pi-bolt"
          label={t("testConnection")}
          outlined
          loading={testing}
          className={compact ? "w-full justify-center" : ""}
          onClick={() => void test()}
        />
        {status && (
          <span className={`text-sm ${status.ok ? "text-emerald-300" : "text-amber-300"}`}>
            <i className={`pi ${status.ok ? "pi-check-circle" : "pi-exclamation-triangle"} me-2`} />
            {status.text}
          </span>
        )}
      </div>
    </>
  );
}

function Shortcuts() {
  const { keymap } = useSettings();
  const [recording, setRecording] = useState<Action | null>(null);
  const compact = useContext(Compact);

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(null);
      const key = eventKey(e);
      if (!key) return;
      const next = { ...keymap, [recording]: [key] };
      // A key can only do one thing: take it away from any other action.
      for (const a of ACTIONS) {
        if (a.id === recording) continue;
        const keys = keysFor(a.id, next);
        if (keys.includes(key)) {
          next[a.id] = keys.filter((k) => k !== key);
          toast(t("keyInUse", { key, action: t(`act_${a.id}` as StringKey) }), 4000);
        }
      }
      updateSettings({ keymap: next });
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [recording, keymap]);

  const resetOne = (id: Action) => {
    const next = { ...keymap };
    delete next[id];
    updateSettings({ keymap: next });
  };

  return (
    <>
      {GROUPS.map((group) => (
        <ShortcutGroup key={group} title={t(`grp_${group}` as StringKey)}>
          {ACTIONS.filter((a) => a.group === group).map((a) => {
            const changed = keymap[a.id] !== undefined && keymap[a.id]!.join() !== DEFAULT_KEYS[a.id].join();
            return (
              <div
                key={a.id}
                className={`flex items-center gap-3 ${compact ? "min-h-14 py-1.5 ps-4 pe-2" : "border-b border-ink-700/70 py-2 last:border-b-0"}`}
              >
                <span className="flex-1 text-sm">{t(`act_${a.id}` as StringKey)}</span>
                {recording === a.id ? (
                  <span className="animate-pulse rounded-md border border-accent px-2 py-0.5 text-xs text-accent">{t("pressKey")}</span>
                ) : (
                  <KeyCaps bindings={keysFor(a.id, keymap)} empty={t("unbound")} />
                )}
                <Button
                  label={t("change")}
                  size="small"
                  text
                  disabled={a.id === "back"}
                  onClick={() => setRecording(recording === a.id ? null : a.id)}
                />
                <Button
                  icon="pi pi-undo"
                  size="small"
                  text
                  rounded
                  severity="secondary"
                  aria-label={t("reset")}
                  tooltip={t("reset")}
                  className={changed ? "" : "invisible"}
                  onClick={() => resetOne(a.id)}
                />
              </div>
            );
          })}
        </ShortcutGroup>
      ))}
      <Button
        icon="pi pi-refresh"
        label={t("resetAllShortcuts")}
        outlined
        severity="secondary"
        size="small"
        className={compact ? "w-full justify-center" : ""}
        onClick={() => updateSettings({ keymap: {} })}
      />
    </>
  );
}

function ShortcutGroup({ title, children }: { title: string; children: ReactNode }) {
  if (useContext(Compact)) return <Group title={title}>{children}</Group>;
  return (
    <section className="mb-4">
      <h3 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wider text-accent">{title}</h3>
      {children}
    </section>
  );
}

function Data() {
  const [dataDir, setDataDir] = useState("");
  useEffect(() => void api.dataInfo().then((d) => setDataDir(d.dataDir)), []);

  const confirm = (event: React.MouseEvent<HTMLButtonElement>, run: () => Promise<void> | void) =>
    ask(event.currentTarget, {
      message: t("confirmAction"),
      icon: "pi pi-exclamation-triangle",
      accept: async () => {
        try {
          await run();
          toast(t("done"));
        } catch (e) {
          toast(String(e), 5000);
        }
      },
    });

  const compact = useContext(Compact);
  return (
    <>
      <Group>
        <Row label={t("dataFolder")} stack>
          <code className={`truncate rounded bg-ink-800 px-2 py-1 text-xs ${compact ? "min-w-0 flex-1" : "max-w-80"}`} dir="ltr" title={dataDir}>
            {dataDir}
          </code>
          <Button icon="pi pi-copy" rounded text severity="secondary" aria-label="Copy" onClick={() => void navigator.clipboard.writeText(dataDir)} />
        </Row>
      </Group>
      <Group>
        <DangerRow label={t("clearHistory")} hint={t("clearHistoryHint")} icon="pi pi-history" onClick={(e) => confirm(e, api.clearWatchHistory)} />
        <DangerRow label={t("clearCache")} hint={t("clearCacheHint")} icon="pi pi-eraser" onClick={(e) => confirm(e, api.clearSubtitleCache)} />
        <DangerRow label={t("resetSettings")} hint={t("resetSettingsHint")} icon="pi pi-refresh" onClick={(e) => confirm(e, resetSettings)} />
      </Group>
    </>
  );
}

/** Something that can't be undone. On a phone the whole row is the button;
    in the dialog, a red button beside the explanation. */
function DangerRow({ label, hint, icon, onClick }: { label: string; hint: string; icon: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  if (useContext(Compact)) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex min-h-14 w-full items-center gap-4 px-4 py-3 text-start transition-colors [-webkit-tap-highlight-color:transparent] active:bg-red-500/10 focus-visible:bg-red-500/10 focus-visible:outline-none"
      >
        <i className={`${icon} text-red-400`} />
        <span className="min-w-0 flex-1">
          <span className="block text-[0.9375rem] font-medium text-red-300">{label}</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-zinc-400">{hint}</span>
        </span>
      </button>
    );
  }
  return (
    <Row label={label} hint={hint}>
      <Button label={label} outlined severity="danger" size="small" onClick={onClick} />
    </Row>
  );
}

