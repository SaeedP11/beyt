// `pnpm dev` in server/: a throwaway FTP server with two demo episodes
// (MP4 + English and Persian subtitles) and the gateway in front of it, for
// trying Beyt's remote sources without any real server. Needs ffmpeg.
// Loopback only, fixed demo token: never expose this.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import FtpSrv from "ftp-srv";

import { normalize } from "./src/config.mjs";
import { createGateway } from "./src/server.mjs";

export const DEV_TOKEN = "beyt-dev-token-0000";
const root = mkdtempSync(join(tmpdir(), "beyt-demo-"));
const show = join(root, "Demo Show", "Season 1");
mkdirSync(show, { recursive: true });

const seconds = 30;
execFileSync("ffmpeg", [
  "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", `testsrc2=size=854x480:rate=30:duration=${seconds}`,
  "-f", "lavfi", "-i", `sine=frequency=660:beep_factor=4:duration=${seconds}`,
  "-vf", "drawtext=text='%{pts\\:hms}':fontsize=72:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=12:x=(w-tw)/2:y=h*0.3",
  "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart",
  join(show, "Episode 1.mp4"),
]);
copyFileSync(join(show, "Episode 1.mp4"), join(show, "Episode 2.mp4"));

const ts = (t) => `00:00:${String(t).padStart(2, "0")},000`;
const fa = (n) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
for (const ep of ["Episode 1", "Episode 2"]) {
  let en = "", faText = "";
  for (let i = 0, t = 2; t < seconds - 2; i++, t += 3) {
    en += `${i + 1}\n${ts(t)} --> ${ts(t + 2)}\nLine ${i + 1} starts at ${t} seconds\n\n`;
    faText += `${i + 1}\n${ts(t)} --> ${ts(t + 2)}\nخط ${fa(i + 1)} در ثانیهٔ ${fa(t)} شروع می‌شود\n\n`;
  }
  writeFileSync(join(show, `${ep}.en.srt`), en);
  writeFileSync(join(show, `${ep}.fa.srt`), faText);
}

const ftp = new FtpSrv({ url: "ftp://127.0.0.1:2121", pasv_url: "127.0.0.1", pasv_min: 2200, pasv_max: 2250, anonymous: false, log: { child: () => ({ trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } }), trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} } });
ftp.on("login", ({ username, password }, ok, fail) =>
  username === "demo" && password === "demo" ? ok({ root }) : fail(new Error("bad login")));
await ftp.listen();

const config = normalize({
  token: DEV_TOKEN,
  dataDir: join(root, "data"),
  allowWrite: false,
  sources: [{ id: "demo", label: "Demo FTP", host: "127.0.0.1", port: 2121, user: "demo", password: "demo", root: "/" }],
});
const gateway = await createGateway(config);
gateway.listen(config.port, config.host, () => {
  console.log(`Demo FTP on ftp://127.0.0.1:2121 (demo/demo), files in ${root}`);
  console.log(`Gateway on http://${config.host}:${config.port}${config.prefix}`);
  console.log("Now run `pnpm dev:gateway` in the project root and open http://localhost:1420/");
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void ftp.close().finally(() => process.exit(0)));
