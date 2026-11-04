// A small virtual file system for the browser backend.
//
// Browsers don't give out paths, so every folder or file the user picks is
// registered here and gets a virtual path ("web:/r3/Season 1/Ep 1.mkv"). The
// rest of the app treats those like the real paths of the desktop build.
// Folders chosen with the File System Access API are remembered across reloads.

import { naturalCompare } from "./subtitles";

export interface VEntry {
  name: string;
  path: string;
  isDir: boolean;
}

interface FileNode {
  name: string;
  file: () => Promise<File>;
  /** Remote files: a URL the <video> streams from, so nothing is downloaded up front. */
  url?: () => Promise<string>;
  size?: number;
}
interface DirNode {
  name: string;
  list: () => Promise<(FileNode | DirNode)[]>;
}
type Node = FileNode | DirNode;

type DirHandleWithValues = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };

const isDirNode = (n: Node): n is DirNode => "list" in n;

const PREFIX = "web:/";
const roots = new Map<string, Node>();
let counter = 0;

// ---------- persistence of folder handles ----------

const DB = "beyt-web";
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("handles");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = run(d.transaction("handles", mode).objectStore("handles"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------- building nodes ----------

function fromHandle(handle: FileSystemDirectoryHandle): DirNode {
  return {
    name: handle.name,
    async list() {
      await ensurePermission(handle);
      const out: Node[] = [];
      for await (const h of (handle as DirHandleWithValues).values()) {
        out.push(
          h.kind === "directory"
            ? fromHandle(h as FileSystemDirectoryHandle)
            : { name: h.name, file: () => (h as FileSystemFileHandle).getFile() },
        );
      }
      return out;
    },
  };
}

async function ensurePermission(handle: FileSystemHandle): Promise<void> {
  const h = handle as FileSystemHandle & {
    queryPermission?: (d: { mode: "read" }) => Promise<PermissionState>;
    requestPermission?: (d: { mode: "read" }) => Promise<PermissionState>;
  };
  if (!h.queryPermission || (await h.queryPermission({ mode: "read" })) === "granted") return;
  if ((await h.requestPermission?.({ mode: "read" })) !== "granted") {
    throw new Error("Beyt needs permission to read this folder again. Open it from the library to allow it.");
  }
}

/** A tree built from a flat list of files with relative paths (<input webkitdirectory>). */
function fromFileList(files: File[]): DirNode {
  type Tree = { name: string; dirs: Map<string, Tree>; files: File[] };
  const root: Tree = { name: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = (f.webkitRelativePath || f.name).split("/");
    root.name ||= parts.length > 1 ? parts[0]! : "";
    let at = root;
    for (const dir of parts.slice(1, -1)) {
      if (!at.dirs.has(dir)) at.dirs.set(dir, { name: dir, dirs: new Map(), files: [] });
      at = at.dirs.get(dir)!;
    }
    at.files.push(f);
  }
  const toNode = (t: Tree): DirNode => ({
    name: t.name,
    list: async () => [
      ...[...t.dirs.values()].map(toNode),
      ...t.files.map((f) => ({ name: f.name, file: async () => f })),
    ],
  });
  return toNode(root);
}

// ---------- public API ----------

function register(node: Node): string {
  const id = `r${++counter}`;
  roots.set(id, node);
  return `${PREFIX}${id}`;
}

/** Registers a picked folder; returns its virtual path. */
export async function addDirectoryHandle(handle: FileSystemDirectoryHandle, remember = true): Promise<string> {
  // The same folder picked again keeps its path, so history and settings still match.
  for (const [id, node] of roots) {
    const known = (node as DirNode & { handle?: FileSystemDirectoryHandle }).handle;
    if (known && (await known.isSameEntry(handle))) return `${PREFIX}${id}`;
  }
  const node = fromHandle(handle) as DirNode & { handle?: FileSystemDirectoryHandle };
  node.handle = handle;
  const path = register(node);
  if (remember) await idb("readwrite", (s) => s.put(handle, path.slice(PREFIX.length))).catch(() => {});
  return path;
}

export function addFileList(files: File[]): string {
  return register(fromFileList(files));
}

/** A single picked file, as the only file of its own folder. Returns the file's path. */
export function addLooseFile(file: File): string {
  const dir = register({ name: "", list: async () => [{ name: file.name, file: async () => file }] });
  return `${dir}/${file.name}`;
}

/** Mounts a folder tree that lives somewhere else (see sources.ts) under a stable
 *  path, so watch history and settings still match after a reload. */
export function mountNode(id: string, node: DirNode): string {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`invalid source id: ${id}`);
  roots.set(id, node);
  return `${PREFIX}${id}`;
}

export type { FileNode as VFileNode, DirNode as VDirNode };

/** What the player needs to open a file: a URL, and a way to give it back. */
export interface Playable {
  name: string;
  size: number | null;
  url: string;
  release: () => void;
}

export async function getPlayable(path: string): Promise<Playable> {
  const node = await resolve(path);
  if (isDirNode(node)) throw new Error(`not a file: ${path}`);
  if (node.url) return { name: node.name, size: node.size ?? null, url: await node.url(), release: () => {} };
  const file = await node.file();
  const url = URL.createObjectURL(file);
  return { name: file.name, size: file.size, url, release: () => URL.revokeObjectURL(url) };
}

/** Puts back the folders remembered from earlier visits (they may still need permission). */
export async function restoreRoots(): Promise<void> {
  try {
    const d = await db();
    const keys = await new Promise<IDBValidKey[]>((res, rej) => {
      const r = d.transaction("handles").objectStore("handles").getAllKeys();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    for (const key of keys) {
      const handle = await idb<FileSystemDirectoryHandle>("readonly", (s) => s.get(key));
      const id = String(key);
      const node = fromHandle(handle) as DirNode & { handle?: FileSystemDirectoryHandle };
      node.handle = handle;
      roots.set(id, node);
      counter = Math.max(counter, Number(id.slice(1)) || 0);
    }
  } catch {
    // No IndexedDB (private window): folders just aren't remembered.
  }
}

function split(path: string): string[] {
  if (!path.startsWith(PREFIX)) throw new Error(`not available in this browser: ${path}`);
  return path.slice(PREFIX.length).split("/").filter(Boolean);
}

async function resolve(path: string): Promise<Node> {
  await restored;
  const [id = "", ...rest] = split(path);
  let node = roots.get(id);
  if (!node) throw new Error("This file isn't open any more. Pick it again.");
  for (const part of rest) {
    if (!isDirNode(node)) throw new Error(`not a folder: ${path}`);
    const next: Node | undefined = (await node.list()).find((n) => n.name === part);
    if (!next) throw new Error(`not found: ${path}`);
    node = next;
  }
  return node;
}

export const isKnownRoot = (path: string): boolean => {
  try {
    return roots.has(split(path)[0] ?? "");
  } catch {
    return false;
  }
};

export async function getFile(path: string): Promise<File> {
  const node = await resolve(path);
  if (isDirNode(node)) throw new Error(`not a file: ${path}`);
  return node.file();
}

export const baseName = (path: string): string => path.split("/").pop() ?? path;

export function parentOf(path: string): string | null {
  const parts = split(path);
  return parts.length <= 1 ? null : PREFIX + parts.slice(0, -1).join("/");
}

/** Entries of a folder with the given filter, folders first, in natural order.
 *  Hidden files are left out, as on the desktop. */
export async function listDir(path: string, wanted: (name: string) => boolean): Promise<VEntry[]> {
  const node = await resolve(path);
  if (!isDirNode(node)) throw new Error(`not a folder: ${path}`);
  const base = path.replace(/\/$/, "");
  const entries: VEntry[] = (await node.list())
    .filter((n) => !n.name.startsWith(".") && (isDirNode(n) || wanted(n.name)))
    .map((n) => ({ name: n.name, path: `${base}/${n.name}`, isDir: isDirNode(n) }));
  return entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || naturalCompare(a.name, b.name));
}

/** Display name for a folder path ("Season 1"), falling back to the picked folder's name. */
export async function folderTitle(path: string): Promise<string> {
  const parts = split(path);
  if (parts.length > 1) return parts[parts.length - 1]!;
  return (await resolve(path)).name;
}

/** Resolves once the folders from earlier visits are back (or there were none). */
export const restored: Promise<void> = typeof indexedDB === "undefined" ? Promise.resolve() : restoreRoots();
