// The few things that differ between the Tauri shell and a plain browser:
// file pickers, file URLs, the app version and the Android back button. The
// Tauri modules load on demand, so a browser (or an app embedding Beyt) never
// runs them.

import { convertFileSrc } from "@tauri-apps/api/core";

import { isTauri } from "./api";
import { addDirectoryHandle, addFileList, addLooseFile } from "./backend/vfs";
import { SUBTITLE_EXTENSIONS, VIDEO_EXTENSIONS } from "./backend/subtitles";
import { VERSION } from "./version";

export { SUBTITLE_EXTENSIONS, VIDEO_EXTENSIONS };

/** Files the browser has no paths for are copied into memory, so picking works the same everywhere. */
const hasFsAccess = typeof window !== "undefined" && "showDirectoryPicker" in window;

type Picker = Window & {
  showDirectoryPicker?: (o?: { mode?: "read" }) => Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker?: (o?: {
    multiple?: boolean;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle[]>;
};

/** Opens the browser's file chooser through a throwaway <input>. */
function inputFiles(opts: { accept?: string; multiple?: boolean; directory?: boolean }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (opts.accept) input.accept = opts.accept;
    input.multiple = !!opts.multiple;
    if (opts.directory) input.setAttribute("webkitdirectory", "");
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

const dots = (exts: string[]) => exts.map((e) => `.${e}`);

async function pickFiles(exts: string[], description: string, multiple: boolean): Promise<File[]> {
  const w = window as Picker;
  if (w.showOpenFilePicker) {
    try {
      const handles = await w.showOpenFilePicker({
        multiple,
        types: [{ description, accept: { "application/octet-stream": dots(exts) } }],
      });
      return await Promise.all(handles.map((h) => h.getFile()));
    } catch {
      return []; // Cancelled.
    }
  }
  return inputFiles({ accept: dots(exts).join(","), multiple });
}

// ---------- pickers ----------

/** Asks for a video; resolves to its path, or null when cancelled. */
export async function pickVideo(defaultPath?: string): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      multiple: false,
      directory: false,
      defaultPath,
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
    return typeof path === "string" ? path : null;
  }
  const [file] = await pickFiles(VIDEO_EXTENSIONS, "Video", false);
  return file ? addLooseFile(file) : null;
}

export async function pickFolder(defaultPath?: string): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({ multiple: false, directory: true, defaultPath });
    return typeof path === "string" ? path : null;
  }
  if (hasFsAccess) {
    try {
      return await addDirectoryHandle(await (window as Picker).showDirectoryPicker!({ mode: "read" }));
    } catch {
      return null; // Cancelled.
    }
  }
  const files = await inputFiles({ directory: true });
  return files.length ? addFileList(files) : null;
}

/** Subtitle files, as paths. Filters are by name: SRT and WebVTT. */
export async function pickSubtitles(multiple: boolean, label: string, defaultPath?: string): Promise<string[]> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple,
      directory: false,
      defaultPath,
      filters: [{ name: label, extensions: SUBTITLE_EXTENSIONS }],
    });
    return Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
  }
  return (await pickFiles(SUBTITLE_EXTENSIONS, label, multiple)).map(addLooseFile);
}

/** Audio files for the desktop's "add audio". Browsers can't mix them in, so this is null there. */
export async function pickAudio(label: string, extensions: string[], defaultPath?: string): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ multiple: false, directory: false, defaultPath, filters: [{ name: label, extensions }] });
  return typeof path === "string" ? path : null;
}

/** Where to save `name`. A browser downloads it instead, so the name itself is the "path". */
export async function pickSavePath(name: string, ext: string, label: string): Promise<string | null> {
  if (!isTauri) return name;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath: name, filters: [{ name: label, extensions: [ext] }] });
}

// ---------- the rest ----------

/** A URL the page can load a local file (or an in-memory image) from. */
export function fileSrc(path: string): string {
  if (!isTauri || /^(data|blob):/.test(path)) return path;
  return convertFileSrc(path);
}


export async function appVersion(): Promise<string> {
  if (!isTauri) return VERSION;
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

/** Android's Back button. Returns a function that stops listening. */
export function onBackButton(cb: () => void): () => void {
  if (!isTauri) return () => {};
  let stop: (() => void) | undefined;
  let gone = false;
  void import("@tauri-apps/api/app").then(async ({ onBackButtonPress }) => {
    const l = await onBackButtonPress(cb);
    if (gone) void l.unregister();
    else stop = () => void l.unregister();
  });
  return () => {
    gone = true;
    stop?.();
  };
}
