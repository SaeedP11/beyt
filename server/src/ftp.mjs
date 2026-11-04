// FTP access through basic-ftp. One connection per request: simple and safe,
// at the cost of a login each time. A pool is the first thing to add if that
// becomes slow.

import { posix } from "node:path";
import { Client } from "basic-ftp";
import { Writable } from "node:stream";

/** Joins the source root and a client-supplied relative path, refusing escapes. */
export function resolvePath(root, rel) {
  const parts = String(rel ?? "").split("/").filter(Boolean);
  if (parts.some((p) => p === ".." || p === "." || p.includes("\0") || p.includes("\\"))) {
    throw httpError(400, "bad-path");
  }
  return posix.join(root || "/", ...parts);
}

export function httpError(status, code) {
  return Object.assign(new Error(code), { status, code });
}

async function connect(source) {
  const client = new Client(30_000);
  try {
    await client.access({
      host: source.host,
      port: source.port ?? 21,
      user: source.user ?? "anonymous",
      password: source.password ?? "anonymous@",
      secure: source.secure ?? false,
    });
  } catch (e) {
    client.close();
    throw httpError(502, "source-unreachable");
  }
  return client;
}

/** Runs `fn(client)` and always closes the connection. */
export async function withFtp(source, fn) {
  const client = await connect(source);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

export const listDir = (source, rel) =>
  withFtp(source, async (c) => {
    const path = resolvePath(source.root, rel);
    let items;
    try {
      items = await c.list(path);
    } catch {
      throw httpError(404, "not-found");
    }
    return items
      .filter((i) => i.isDirectory || i.isFile)
      .map((i) => ({ name: i.name, isDir: i.isDirectory, ...(i.isFile ? { size: i.size } : {}) }));
  });

/** Sends bytes [start, end] of a file to `out`; stops early (closing the FTP
 *  connection) when `signal` aborts or the range is complete. */
export async function pipeRange(source, rel, start, end, out, signal) {
  const client = await connect(source);
  let left = end - start + 1;
  const sink = new Writable({
    write(chunk, _enc, cb) {
      if (left <= 0) return cb();
      const part = chunk.length > left ? chunk.subarray(0, left) : chunk;
      left -= part.length;
      const ok = out.write(part);
      if (left <= 0) client.close(); // Done: stop the transfer.
      if (ok) cb();
      else out.once("drain", cb);
    },
  });
  const stop = () => client.close();
  signal.addEventListener("abort", stop, { once: true });
  try {
    await client.downloadTo(sink, resolvePath(source.root, rel), start);
  } catch (e) {
    if (left > 0 && !signal.aborted) throw e; // A real failure, not our own early close.
  } finally {
    signal.removeEventListener("abort", stop);
    client.close();
  }
}

export const sizeOf = (source, rel) =>
  withFtp(source, async (c) => {
    const path = resolvePath(source.root, rel);
    try {
      return await c.size(path);
    } catch {
      throw httpError(404, "not-found");
    }
  });

export const renameFile = (source, rel, newRel) =>
  withFtp(source, (c) => c.rename(resolvePath(source.root, rel), resolvePath(source.root, newRel)));

export const removeFile = (source, rel) => withFtp(source, (c) => c.remove(resolvePath(source.root, rel), true));
