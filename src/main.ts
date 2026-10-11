import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import * as clock from "./clock";
import { cueIndexAt, neighbourCue } from "./cues";
import { TrackView } from "./overlay";
import type { Mode, Playback, Track } from "./types";
import "./style.css";

let views: TrackView[] = [];
let selected = 0;

// ---------- player commands ----------

function seekTo(time: number): void {
  const t = Math.max(0, time);
  clock.jump(t);
  void invoke("seek_absolute", { time: t });
}

function selectedView(): TrackView | undefined {
  return views[selected];
}

function jumpLine(delta: -1 | 1): void {
  const v = selectedView();
  if (!v) return;
  const i = neighbourCue(v.track.cues, v.trackTime(clock.now()), delta);
  if (i >= 0) seekTo(v.track.cues[i]!.start + v.style.offset);
}

function replayLine(): void {
  const v = selectedView();
  if (!v) return;
  const i = cueIndexAt(v.track.cues, v.trackTime(clock.now()));
  if (i >= 0) seekTo(v.track.cues[i]!.start + v.style.offset);
}

// ---------- HUD and toast ----------

const hud = document.getElementById("hud")!;

function fmt(t: number): string {
  const sign = t < 0 ? "-" : "";
  t = Math.abs(t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2).padStart(5, "0");
  return `${sign}${h ? `${h}:` : ""}${String(m).padStart(2, "0")}:${s}`;
}

function updateHud(t: number): void {
  if (hud.hidden) return;
  const p = clock.snapshot();
  document.getElementById("hud-time")!.textContent =
    `${fmt(t)} / ${fmt(p.duration)}${p.paused ? "  (paused)" : ""}`;
  const rows = views.map((v, i) => {
    const off = Math.round(v.style.offset * 1000);
    const row = document.createElement("div");
    row.classList.toggle("selected", i === selected);
    row.textContent =
      `${i === selected ? "▶" : " "} ${v.track.label} · ${v.style.position} · ` +
      `${v.style.mode} · offset ${off >= 0 ? "+" : ""}${off} ms · ${v.track.cues.length} lines`;
    return row;
  });
  document.getElementById("hud-tracks")!.replaceChildren(...rows);
}

let toastTimer: number | undefined;
function toast(msg: string): void {
  const el = document.getElementById("toast")!;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 1400);
}

// ---------- keyboard ----------

const MODES: Mode[] = ["show", "blur", "hide"];

function onKey(e: KeyboardEvent): void {
  const v = selectedView();
  switch (e.key.toLowerCase()) {
    case " ":
      void invoke("toggle_pause");
      break;
    case "arrowleft":
      seekTo(clock.now() - 5);
      break;
    case "arrowright":
      seekTo(clock.now() + 5);
      break;
    case "a":
      jumpLine(-1);
      break;
    case "d":
      jumpLine(1);
      break;
    case "s":
      replayLine();
      break;
    case "tab":
      if (views.length) {
        selected = (selected + 1) % views.length;
        toast(`Selected: ${views[selected]!.track.label}`);
      }
      break;
    case "[":
    case "]":
      if (!v) break;
      v.style.offset = Math.round((v.style.offset + (e.key === "]" ? 0.1 : -0.1)) * 10) / 10;
      v.invalidate();
      toast(`${v.track.label}: offset ${Math.round(v.style.offset * 1000)} ms`);
      break;
    case "b":
      if (!v) break;
      v.style.mode = MODES[(MODES.indexOf(v.style.mode) + 1) % MODES.length]!;
      v.applyStyle();
      toast(`${v.track.label}: ${v.style.mode}`);
      break;
    case "t":
      if (!v) break;
      v.style.position = v.style.position === "top" ? "bottom" : "top";
      v.applyStyle();
      toast(`${v.track.label}: ${v.style.position}`);
      break;
    case "i":
      hud.hidden = !hud.hidden;
      break;
    case "f":
      void invoke("toggle_fullscreen");
      break;
    case "q":
      void invoke("quit");
      break;
    default:
      return;
  }
  e.preventDefault();
}

// ---------- startup ----------

function frame(): void {
  const t = clock.now();
  for (const v of views) v.render(t);
  updateHud(t);
  requestAnimationFrame(frame);
}

async function init(): Promise<void> {
  await listen<Playback>("playback", (e) => clock.update(e.payload));
  const tracks = await invoke<Track[]>("get_tracks");
  views = tracks.map((t) => new TrackView(t));
  if (!views.length) toast("No subtitle tracks found");

  window.addEventListener("keydown", onKey);
  window.addEventListener("dblclick", () => void invoke("toggle_fullscreen"));
  requestAnimationFrame(frame);
}

void init();
