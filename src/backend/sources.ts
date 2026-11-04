// Remote file sources: folders of videos and subtitles that live somewhere
// other than the user's disk (an FTP/SFTP/WebDAV/S3 server, a NAS, a cloud
// bucket).
//
// A browser cannot open FTP or SFTP connections, so a source never speaks the
// protocol itself. The host app implements `FileSource` on top of whatever it
// can reach: usually its own server, which talks FTP and exposes the files over
// HTTP with Range support. `httpFileSource` is a ready-made source for the
// gateway contract documented in docs/BACKEND_API.md.

import { mountNode, type VDirNode, type VFileNode } from "./vfs";

export interface RemoteEntry {
  name: string;
  isDir: boolean;
  /** Bytes. Optional; only shown in file info. */
  size?: number;
}

export interface FileSource {
  /** Stable id: lowercase letters, digits and dashes ("home-nas"). Watch history is keyed by it. */
  id: string;
  /** Shown in the library ("Home NAS"). */
  label: string;
  /** Entries of a folder. `path` is relative to the source: "" is its root, then "Season 1/Ep 2". */
  list(path: string): Promise<RemoteEntry[]>;
  /** A URL the <video> element can stream from. It must honor HTTP Range requests,
   *  or seeking will not work. Signed, short-lived URLs are fine: it is asked for on every open. */
  url(path: string): string | Promise<string>;
  /** Bytes of a small file (a subtitle). Defaults to fetching `url(path)`. */
  read?(path: string): Promise<Blob>;
}

export interface MountedSource {
  id: string;
  label: string;
  /** Virtual path to give the library's `listFolder`. */
  path: string;
}

const mounted = new Map<string, MountedSource>();
const listeners = new Set<() => void>();

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

function dirNode(source: FileSource, dir: string, name: string): VDirNode {
  return {
    name,
    async list() {
      const entries = await source.list(dir);
      return entries.map((e): VDirNode | VFileNode => {
        const path = join(dir, e.name);
        if (e.isDir) return dirNode(source, path, e.name);
        return {
          name: e.name,
          ...(e.size !== undefined ? { size: e.size } : {}),
          url: async () => source.url(path),
          file: async () => {
            const blob = source.read ? await source.read(path) : await (await fetchOk(await source.url(path))).blob();
            return new File([blob], e.name, { type: blob.type });
          },
        };
      });
    },
  };
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The file server answered ${res.status} ${res.statusText}.`.trim());
  return res;
}

/** Makes a source browsable in the library. Mounting an id again replaces the source. */
export function mountSource(source: FileSource): MountedSource {
  const path = mountNode(source.id, dirNode(source, "", source.label));
  const info = { id: source.id, label: source.label, path };
  mounted.set(source.id, info);
  listeners.forEach((l) => l());
  return info;
}

export function unmountSource(id: string): void {
  mounted.delete(id);
  listeners.forEach((l) => l());
}

export const listSources = (): MountedSource[] => [...mounted.values()];

/** Calls `cb` whenever sources are mounted or removed. Returns a function that stops. */
export function onSourcesChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

// ---------- the HTTP gateway ----------

export interface HttpFileSourceOptions {
  id: string;
  label: string;
  /** Where the gateway lives, e.g. "https://api.example.com/beyt/v1/sources/home-nas". */
  baseUrl: string;
  /** Extra headers for the listing calls (an Authorization token, say). Video
   *  elements can't send headers, so `streamUrl` is how the stream is authorized. */
  headers?: () => HeadersInit | Promise<HeadersInit>;
  /** Builds the stream URL, e.g. adds a signed token. Defaults to
   *  `${baseUrl}/content?path=…`. */
  streamUrl?: (path: string, defaultUrl: string) => string | Promise<string>;
  fetch?: typeof fetch;
}

/** A source backed by a gateway that speaks the file contract of docs/BACKEND_API.md:
 *  `GET {baseUrl}/list?path=` and `GET {baseUrl}/content?path=` (with Range). */
export function httpFileSource(opts: HttpFileSourceOptions): FileSource {
  const base = opts.baseUrl.replace(/\/$/, "");
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const content = (path: string) => `${base}/content?path=${encodeURIComponent(path)}`;
  return {
    id: opts.id,
    label: opts.label,
    async list(path) {
      const res = await doFetch(`${base}/list?path=${encodeURIComponent(path)}`, {
        headers: (await opts.headers?.()) ?? {},
      });
      if (!res.ok) throw new Error(`The file server answered ${res.status} ${res.statusText}.`.trim());
      const body = (await res.json()) as { entries: RemoteEntry[] };
      return body.entries;
    },
    url: (path) => (opts.streamUrl ? opts.streamUrl(path, content(path)) : content(path)),
    async read(path) {
      const res = await doFetch(content(path), { headers: (await opts.headers?.()) ?? {} });
      if (!res.ok) throw new Error(`The file server answered ${res.status} ${res.statusText}.`.trim());
      return res.blob();
    },
  };
}
