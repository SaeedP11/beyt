// The Beyt server contract: everything a backend can store or do for Beyt, as
// one typed interface, plus an HTTP client for it.
//
// Playback itself always runs in the page. The server keeps what should
// outlive the browser (watch history, series settings, app settings, saved
// words) and can optionally take over features a browser can't do alone
// (dictionary, subtitle matching, renaming and trashing files).
// docs/BACKEND_API.md lists each method's HTTP route.

import type { Candidate, FileInfo, Lookup, VocabItem } from "../types";
import { webApi } from "./web";
import { store, type Data, type StoreSink, type Watch } from "./store";

/** Everything the server keeps. Returned by `loadState` when Beyt starts. */
export type BeytState = Partial<Data>;

/** The writes Beyt sends as the user watches and learns. All optional: leave out
 *  what your backend doesn't keep, and that part stays in the browser only. */
export interface BeytServer extends Partial<StoreSink> {
  /** GET /state. Called once at startup; failures leave the browser's own copy in use. */
  loadState?(): Promise<BeytState>;

  /** GET /dictionary/{lang}/{word}. Rejects with "dictionary-missing" if there is none. */
  lookupWord?(word: string, lang: string): Promise<Lookup>;
  /** POST /subtitles/match. Files are virtual paths, best fit first in the answer. */
  matchSubtitles?(path: string, files: string[]): Promise<Candidate[]>;
  /** GET /files/info?path= */
  fileInfo?(path: string): Promise<FileInfo>;
  /** POST /files/rename. Returns the new path; rejects with "name-taken". */
  renameVideo?(path: string, name: string): Promise<string>;
  /** POST /files/trash */
  trashVideo?(path: string, subtitles: boolean): Promise<void>;
  /** GET /files/thumbnail?path=&at= : a URL of a JPEG. */
  thumbnail?(path: string, at: number | null): Promise<string>;
}

export interface HttpServerOptions {
  /** e.g. "https://api.example.com/beyt/v1" */
  baseUrl: string;
  /** Extra headers on every call, e.g. `{ Authorization: "Bearer …" }`. */
  headers?: () => HeadersInit | Promise<HeadersInit>;
  fetch?: typeof fetch;
  /** Called when a background write fails, so the host can show it. Writes are not retried. */
  onError?: (error: Error) => void;
}

/** Sends the contract over HTTP + JSON. Routes are in docs/BACKEND_API.md. */
export function httpServer(opts: HttpServerOptions): Required<BeytServer> {
  const base = opts.baseUrl.replace(/\/$/, "");
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${route}`, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...((await opts.headers?.()) ?? {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      // Errors are { "error": "name-taken" }; the code becomes the message, as in the desktop core.
      const detail = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(detail?.error ?? `The server answered ${res.status} ${res.statusText}.`.trim());
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }
  // Writes happen in the background; a failure is reported, never thrown into the player.
  const send = (method: string, route: string, body?: unknown): void => {
    call(method, route, body).catch((e: unknown) => opts.onError?.(e instanceof Error ? e : new Error(String(e))));
  };
  const enc = encodeURIComponent;

  return {
    loadState: () => call<BeytState>("GET", "/state"),

    saveWatch: (path: string, w: Watch) => send("PUT", `/history?path=${enc(path)}`, w),
    forgetWatch: (path) => send("DELETE", `/history?path=${enc(path)}`),
    clearWatchHistory: () => send("DELETE", "/history"),
    addSubtitle: (video, path) => send("POST", "/subtitles/added", { video, path }),
    removeSubtitle: (video, path) => send("DELETE", `/subtitles/added?video=${enc(video)}&path=${enc(path)}`),
    saveSeries: (folder, settings) => send("PUT", `/series?folder=${enc(folder)}`, settings),
    setSetting: (key, value) => send("PUT", `/settings/${enc(key)}`, { value }),
    addVocab: (item: VocabItem) => send("POST", "/vocab", item),
    deleteVocab: (id) => send("DELETE", `/vocab/${id}`),
    markExported: (ids) => send("POST", "/vocab/exported", { ids }),

    lookupWord: (word, lang) => call<Lookup>("GET", `/dictionary/${enc(lang)}/${enc(word)}`),
    matchSubtitles: (path, files) => call<Candidate[]>("POST", "/subtitles/match", { path, files }),
    fileInfo: (path) => call<FileInfo>("GET", `/files/info?path=${enc(path)}`),
    renameVideo: async (path, name) => (await call<{ path: string }>("POST", "/files/rename", { path, name })).path,
    trashVideo: (path, subtitles) => call<void>("POST", "/files/trash", { path, subtitles }),
    thumbnail: async (path, at) =>
      (await call<{ url: string }>("GET", `/files/thumbnail?path=${enc(path)}${at == null ? "" : `&at=${at}`}`)).url,
  };
}

let connecting: { server: BeytServer; done: Promise<void> } | null = null;

/** Connects Beyt to a server: loads its state, sends later changes to it, and
 *  routes the optional features through it. Call before the first render.
 *  Resolves once the server's state is in (or has failed to load). */
export function connectServer(server: BeytServer, onError?: (e: Error) => void): Promise<void> {
  if (connecting) {
    if (connecting.server !== server) return Promise.reject(new Error("Beyt is already connected to another server."));
    return connecting.done; // Rendered twice (StrictMode) or remounted: connect once.
  }
  connecting = { server, done: attach(server, onError) };
  return connecting.done;
}

async function attach(server: BeytServer, onError?: (e: Error) => void): Promise<void> {
  // A method the server doesn't implement is left as the browser version has it.
  const route = <K extends keyof typeof webApi>(name: K, impl: unknown) => {
    if (impl) (webApi as Record<string, unknown>)[name] = impl;
  };
  route("lookupWord", server.lookupWord);
  route("matchSubtitles", server.matchSubtitles);
  route("renameVideo", server.renameVideo);
  route("trashVideo", server.trashVideo);
  route("thumbnail", server.thumbnail);
  if (server.fileInfo) {
    const local = webApi.fileInfo;
    const remote = server.fileInfo;
    route("fileInfo", async (path: string) => {
      try {
        return await remote(path);
      } catch {
        return local(path);
      }
    });
  }

  if (server.loadState) {
    try {
      store.hydrate(await server.loadState());
    } catch (e) {
      onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }
  store.attach(server);
}
