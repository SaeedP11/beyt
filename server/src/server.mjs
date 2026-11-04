// The Beyt gateway: serves the file-source routes (FTP -> HTTP with Range) and
// the Beyt server routes (state, history, vocabulary…) described in
// ../docs/BACKEND_API.md. Plain node:http, no framework.

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { extname, posix } from "node:path";

import { httpError, listDir, pipeRange, removeFile, renameFile, sizeOf } from "./ftp.mjs";
import { openState } from "./state.mjs";

const TYPES = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".srt": "text/plain; charset=utf-8", ".vtt": "text/vtt; charset=utf-8",
  ".ass": "text/plain; charset=utf-8", ".ssa": "text/plain; charset=utf-8",
};
const SUBTITLE = /\.(srt|vtt|ass|ssa|sub)$/i;
const MAX_BODY = 1 << 20;

const same = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** "bytes=a-b" | "bytes=a-" | "bytes=-n" -> [start, end], or null when unsatisfiable. */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!m || (m[1] === "" && m[2] === "")) return undefined; // Not a range: send everything.
  let start, end;
  if (m[1] === "") {
    const n = Number(m[2]);
    start = Math.max(size - n, 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? null : [start, end];
}

async function readJson(req) {
  let total = 0;
  const chunks = [];
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BODY) throw httpError(413, "too-large");
    chunks.push(c);
  }
  if (!total) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "bad-json");
  }
}

export async function createGateway(config) {
  const state = await openState(config.dataDir);
  const sources = new Map(config.sources.map((s) => [s.id, s]));
  const d = state.data;

  /** "web:/home-nas/Season 1/Ep 1.mp4" -> its source and path inside it. */
  function virtual(path) {
    const m = /^web:\/([^/]+)\/?(.*)$/.exec(path ?? "");
    const source = m && sources.get(m[1]);
    if (!source) throw httpError(404, "unknown-source");
    return { source, rel: m[2] };
  }
  const toVirtual = (source, rel) => `web:/${source.id}/${rel}`;

  const send = (res, status, body) => {
    if (body === undefined) return res.writeHead(status).end();
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  };
  const saved = async (res, status = 204) => {
    await state.save();
    send(res, status);
  };

  // ---------- file source routes ----------

  async function sourceRoute(req, res, url, id, action) {
    const source = sources.get(id);
    if (!source) throw httpError(404, "unknown-source");
    const rel = url.searchParams.get("path") ?? "";

    if (action === "list") {
      return send(res, 200, { entries: await listDir(source, rel) });
    }
    if (action !== "content") throw httpError(404, "not-found");

    const size = await sizeOf(source, rel);
    const type = TYPES[extname(rel).toLowerCase()] ?? "application/octet-stream";
    const range = parseRange(req.headers.range, size);
    if (range === null) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    const [start, end] = range ?? [0, size - 1];
    res.writeHead(range ? 206 : 200, {
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      "Content-Length": size === 0 ? 0 : end - start + 1,
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (size === 0) return res.end();
    // Closing the response (the player seeked away) stops the FTP transfer.
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      await pipeRange(source, rel, start, end, res, abort.signal);
      res.end();
    } catch {
      res.destroy(); // Headers are out already; cut the connection so the player retries.
    }
  }

  // ---------- Beyt server routes ----------

  async function beytRoute(req, res, url, route) {
    const q = (k) => url.searchParams.get(k);
    const m = req.method;
    const body = m === "GET" || m === "DELETE" ? undefined : await readJson(req);
    let hit;

    if (m === "GET" && route === "/state") return send(res, 200, d);

    if (route === "/history") {
      if (m === "PUT") { d.watch[q("path")] = body; return saved(res); }
      if (m === "DELETE") { q("path") ? delete d.watch[q("path")] : (d.watch = {}); return saved(res); }
    }
    if (route === "/subtitles/added") {
      if (m === "POST") {
        const list = d.addedSubtitles[body.video] ?? [];
        if (!list.includes(body.path)) d.addedSubtitles[body.video] = [...list, body.path];
        return saved(res);
      }
      if (m === "DELETE") {
        d.addedSubtitles[q("video")] = (d.addedSubtitles[q("video")] ?? []).filter((p) => p !== q("path"));
        return saved(res);
      }
    }
    if (route === "/series" && m === "PUT") { d.series[q("folder")] = body; return saved(res); }
    if ((hit = /^\/settings\/([^/]+)$/.exec(route)) && m === "PUT") {
      d.settings[decodeURIComponent(hit[1])] = body.value;
      return saved(res);
    }
    if (route === "/vocab" && m === "POST") {
      d.vocab = [body, ...d.vocab.filter((v) => v.id !== body.id)];
      d.nextVocabId = Math.max(d.nextVocabId, body.id + 1);
      return saved(res);
    }
    if ((hit = /^\/vocab\/(\d+)$/.exec(route)) && m === "DELETE") {
      d.vocab = d.vocab.filter((v) => v.id !== Number(hit[1]));
      return saved(res);
    }
    if (route === "/vocab/exported" && m === "POST") {
      for (const v of d.vocab) if (body.ids.includes(v.id)) v.exported = true;
      return saved(res);
    }

    // Writes to the file server are off unless the config allows them.
    if (route === "/files/rename" && m === "POST") {
      if (!config.allowWrite) throw httpError(403, "read-only");
      const { source, rel } = virtual(body.path);
      if (!body.name || /[/\\]/.test(body.name)) throw httpError(400, "bad-name");
      const dir = posix.dirname(rel) === "." ? "" : posix.dirname(rel);
      const siblings = await listDir(source, dir);
      if (siblings.some((e) => e.name === body.name)) throw httpError(409, "name-taken");
      const next = posix.join(dir, body.name);
      await renameFile(source, rel, next);
      const to = toVirtual(source, next);
      if (d.watch[body.path]) { d.watch[to] = d.watch[body.path]; delete d.watch[body.path]; }
      await state.save();
      return send(res, 200, { path: to });
    }
    if (route === "/files/trash" && m === "POST") {
      if (!config.allowWrite) throw httpError(403, "read-only");
      const { source, rel } = virtual(body.path);
      await removeFile(source, rel);
      if (body.subtitles) {
        const dir = posix.dirname(rel) === "." ? "" : posix.dirname(rel);
        const stem = posix.basename(rel).replace(/\.[^.]+$/, "");
        for (const e of await listDir(source, dir)) {
          if (!e.isDir && e.name.startsWith(stem) && SUBTITLE.test(e.name)) await removeFile(source, posix.join(dir, e.name));
        }
      }
      delete d.watch[body.path];
      return saved(res);
    }

    // Not built into the reference gateway: Beyt falls back to its own behavior.
    if (route === "/subtitles/match" || route === "/files/info" || route === "/files/thumbnail") {
      throw httpError(501, "not-implemented");
    }
    if (/^\/dictionary\//.test(route)) throw httpError(404, "dictionary-missing");
    throw httpError(404, "not-found");
  }

  // ---------- entry ----------

  const handle = async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", config.allowOrigin);
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
        "Access-Control-Max-Age": "600",
      }).end();
      return;
    }
    try {
      const url = new URL(req.url, "http://gateway");
      if (!url.pathname.startsWith(config.prefix + "/")) throw httpError(404, "not-found");
      const route = url.pathname.slice(config.prefix.length);

      // A <video> element can't send headers, so the stream route also takes ?token=.
      const streaming = /^\/sources\/[^/]+\/content$/.test(route);
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      const given = bearer ?? (streaming ? url.searchParams.get("token") : null);
      if (!given || !same(given, config.token)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        throw httpError(401, "unauthorized");
      }

      const src = /^\/sources\/([^/]+)\/(list|content)$/.exec(route);
      if (src) {
        if (req.method !== "GET") throw httpError(405, "method-not-allowed");
        return await sourceRoute(req, res, url, src[1], src[2]);
      }
      return await beytRoute(req, res, url, route);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      send(res, e.status ?? 500, { error: e.code ?? "internal" });
      if (!e.status) console.error(e);
    }
  };

  const server = createServer((req, res) => void handle(req, res));
  server.on("close", () => void state.flush());
  return server;
}
