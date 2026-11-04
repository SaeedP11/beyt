import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import FtpSrv from "ftp-srv";

import { normalize } from "../src/config.mjs";
import { parseRange, createGateway } from "../src/server.mjs";

const TOKEN = "test-token-0123456789";
const VIDEO = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
let ftp, gateway, base, root, data;

const call = (path, init = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers } });

before(async () => {
  root = await mkdtemp(join(tmpdir(), "beyt-ftp-"));
  data = await mkdtemp(join(tmpdir(), "beyt-data-"));
  await mkdir(join(root, "Videos", "Season 1"), { recursive: true });
  await writeFile(join(root, "Videos", "Season 1", "Ep 1.mp4"), VIDEO);
  await writeFile(join(root, "Videos", "Season 1", "Ep 1.en.srt"), "1\n00:00:01,000 --> 00:00:02,000\nHi\n");

  ftp = new FtpSrv({ url: "ftp://127.0.0.1:2121", pasv_url: "127.0.0.1", pasv_min: 2200, pasv_max: 2250, anonymous: false });
  ftp.on("login", ({ username, password }, ok, fail) =>
    username === "u" && password === "p" ? ok({ root }) : fail(new Error("bad login")));
  await ftp.listen();

  const config = normalize({
    token: TOKEN, dataDir: data, allowWrite: true,
    sources: [{ id: "nas", label: "NAS", host: "127.0.0.1", port: 2121, user: "u", password: "p", root: "/Videos" }],
  });
  gateway = await createGateway(config);
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${gateway.address().port}${config.prefix}`;
});

after(async () => {
  gateway.close();
  await ftp.close();
});

test("parseRange", () => {
  assert.deepEqual(parseRange("bytes=0-9", 100), [0, 9]);
  assert.deepEqual(parseRange("bytes=90-", 100), [90, 99]);
  assert.deepEqual(parseRange("bytes=-10", 100), [90, 99]);
  assert.deepEqual(parseRange("bytes=0-999", 100), [0, 99]);
  assert.equal(parseRange("bytes=100-", 100), null);
  assert.equal(parseRange(undefined, 100), undefined);
});

test("requires the token", async () => {
  assert.equal((await fetch(`${base}/state`)).status, 401);
  assert.equal((await fetch(`${base}/sources/nas/list`, { headers: { Authorization: "Bearer nope" } })).status, 401);
  // ?token= works only for the stream.
  assert.equal((await fetch(`${base}/state?token=${TOKEN}`)).status, 401);
  assert.equal((await fetch(`${base}/sources/nas/content?path=Season%201/Ep%201.mp4&token=${TOKEN}`)).status, 200);
});

test("lists folders over FTP", async () => {
  const root1 = await (await call("/sources/nas/list?path=")).json();
  assert.deepEqual(root1.entries, [{ name: "Season 1", isDir: true }]);
  const dir = await (await call("/sources/nas/list?path=Season%201")).json();
  const ep = dir.entries.find((e) => e.name === "Ep 1.mp4");
  assert.deepEqual(ep, { name: "Ep 1.mp4", isDir: false, size: VIDEO.length });
});

test("streams whole files and ranges", async () => {
  const path = "/sources/nas/content?path=Season%201/Ep%201.mp4";
  const whole = await call(path);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), VIDEO);

  const part = await call(path, { headers: { Range: "bytes=1000-1999" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 1000-1999/${VIDEO.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), VIDEO.subarray(1000, 2000));

  const tail = await call(path, { headers: { Range: "bytes=4990-" } });
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), VIDEO.subarray(4990));

  assert.equal((await call(path, { headers: { Range: "bytes=9999-" } })).status, 416);
});

test("refuses paths that escape the source and unknown things", async () => {
  assert.equal((await call("/sources/nas/list?path=..%2F..")).status, 400);
  assert.equal((await call("/sources/nas/content?path=Season%201/../../x")).status, 400);
  assert.equal((await call("/sources/other/list")).status, 404);
  assert.equal((await call("/sources/nas/list?path=Nope")).status, 404);
});

test("keeps Beyt's data and survives a restart", async () => {
  const json = { "Content-Type": "application/json" };
  await call("/history?path=web%3A%2Fnas%2Fa.mp4", { method: "PUT", headers: json, body: JSON.stringify({ position: 5, duration: 60, updatedAt: 1 }) });
  await call("/settings/uiLang", { method: "PUT", headers: json, body: JSON.stringify({ value: "fa" }) });
  await call("/vocab", { method: "POST", headers: json, body: JSON.stringify({ id: 7, word: "hi", exported: false }) });
  await call("/vocab/exported", { method: "POST", headers: json, body: JSON.stringify({ ids: [7] }) });
  const s = await (await call("/state")).json();
  assert.equal(s.watch["web:/nas/a.mp4"].position, 5);
  assert.equal(s.settings.uiLang, "fa");
  assert.equal(s.vocab[0].exported, true);
  assert.equal(s.nextVocabId, 8);

  const again = await createGateway(normalize({ token: TOKEN, dataDir: data, sources: [] }));
  await new Promise((r) => again.listen(0, "127.0.0.1", r));
  const back = await (await fetch(`http://127.0.0.1:${again.address().port}/beyt/v1/state`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
  again.close();
  assert.equal(back.settings.uiLang, "fa");
});

test("dictionary and matching fall back cleanly", async () => {
  const d = await call("/dictionary/en/hello");
  assert.equal(d.status, 404);
  assert.deepEqual(await d.json(), { error: "dictionary-missing" });
  assert.equal((await call("/subtitles/match", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 501);
});

test("rename and trash (allowed in this config)", async () => {
  const json = { "Content-Type": "application/json" };
  const post = (p, b) => call(p, { method: "POST", headers: json, body: JSON.stringify(b) });
  assert.equal((await post("/files/rename", { path: "web:/nas/Season 1/Ep 1.mp4", name: "Ep 1.en.srt" })).status, 409);
  const r = await post("/files/rename", { path: "web:/nas/Season 1/Ep 1.mp4", name: "Pilot.mp4" });
  assert.deepEqual(await r.json(), { path: "web:/nas/Season 1/Pilot.mp4" });
  assert.equal((await post("/files/rename", { path: "web:/nas/Season 1/Pilot.mp4", name: "a/b" })).status, 400);
  assert.equal((await post("/files/trash", { path: "web:/nas/Season 1/Pilot.mp4", subtitles: false })).status, 204);
  assert.deepEqual(await readdir(join(root, "Videos", "Season 1")), ["Ep 1.en.srt"]);
});

test("writes are refused unless enabled", async () => {
  const ro = await createGateway(normalize({ token: TOKEN, dataDir: data, sources: [] }));
  await new Promise((r) => ro.listen(0, "127.0.0.1", r));
  const res = await fetch(`http://127.0.0.1:${ro.address().port}/beyt/v1/files/trash`, {
    method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ path: "web:/nas/x", subtitles: false }),
  });
  ro.close();
  assert.equal(res.status, 403);
});
