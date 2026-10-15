// The audio track menu, shared by the control bar and the right-click menu.

import { open } from "@tauri-apps/plugin-dialog";
import type { MenuItem } from "primereact/menuitem";

import { player } from "./hooks";
import { t } from "./i18n";
import { audioLabel } from "./player";
import { toast } from "./ui";

/** Audio files the add dialog offers (see audio.rs). */
const EXTENSIONS = ["mka", "mp3", "m4a", "aac", "ac3", "eac3", "dts", "flac", "ogg", "oga", "opus", "wav", "wv"];

/** Asks for an audio file and plays it alongside the video, e.g. a dub kept next to it. */
export async function addAudioFile(): Promise<void> {
  const path = await open({
    multiple: false,
    directory: false,
    defaultPath: player.media?.folder,
    filters: [{ name: t("audioFiles"), extensions: EXTENSIONS }],
  });
  if (typeof path !== "string") return;
  await player.addAudio(path).catch((e) => toast(String(e), 5000));
}

/** Builds one menu row in the caller's style. */
export type AudioRow = (label: string, icon: string | null, command: () => void, disabled?: boolean) => MenuItem;

/** The tracks (the playing one ticked), and the actions: adding a file and
 *  removing added ones. Each menu lays the two parts out its own way. */
export function audioItems(row: AudioRow): { tracks: MenuItem[]; actions: MenuItem[] } {
  const tracks = player.audio.map((a) =>
    row(
      a.supported ? audioLabel(a) : `${audioLabel(a)} (${t("cantPlay")})`,
      a.selected ? "pi pi-check" : null,
      () => player.selectAudio(a),
      !a.supported,
    ),
  );
  const remove = player.audio
    .filter((a) => a.added)
    .map((a) =>
      row(t("removeAudio", { name: a.detail }), "pi pi-trash", () => {
        void player.removeAudio(a).catch((e) => toast(String(e), 5000));
      }),
    );
  return { tracks, actions: [row(t("addAudio"), "pi pi-plus", () => void addAudioFile()), ...remove] };
}

/** "Audio track: English · 5.1", for a menu row that opens the track menu. */
export function audioMenuLabel(): string {
  const playing = player.selectedAudio();
  return playing ? `${t("audioTrack")}: ${audioLabel(playing)}` : t("audioTrack");
}
