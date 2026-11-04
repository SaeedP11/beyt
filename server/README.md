# Beyt gateway (reference)

A small Node server that lets Beyt in the browser use **FTP folders** and keep
its data on a server. It implements the routes in
[`../docs/BACKEND_API.md`](../docs/BACKEND_API.md) with `node:http` and
[`basic-ftp`](https://github.com/patrickjuchli/basic-ftp). Copy it, or use it as
a model for your own backend.

```sh
cd server
pnpm install
cp gateway.config.example.json gateway.config.json   # then edit it
pnpm start        # http://127.0.0.1:8787/beyt/v1
pnpm test         # integration tests against an in-process FTP server
```

Needs Node 20 or newer.

## Use it from the page

```tsx
import { Beyt, httpFileSource, httpServer } from "beyt";

const base = "http://127.0.0.1:8787/beyt/v1";
const token = "…the token from gateway.config.json…";
const headers = () => ({ Authorization: `Bearer ${token}` });

<Beyt
  sources={[
    httpFileSource({
      id: "home-nas", label: "Home NAS", baseUrl: `${base}/sources/home-nas`, headers,
      streamUrl: (_path, url) => `${url}&token=${token}`,   // <video> can't send headers
    }),
  ]}
  server={httpServer({ baseUrl: base, headers })}
/>;
```

The source `id` in the page must match the `id` in the gateway's config.

## What it does

- **Files:** `GET /sources/:id/list` and `/content` over FTP. `/content`
  answers Range requests, so seeking works; closing the response (seeking away)
  stops the FTP transfer.
- **State:** history, series and app settings, added subtitles and saved words
  in `data/state.json` (written atomically).
- **Rename and delete** of videos on the FTP server, only with
  `"allowWrite": true`. Off by default.
- **Not built in:** dictionary, subtitle matching, file info and thumbnails
  answer 404/501, and Beyt falls back to its in-browser behavior.

## Security notes

- A token of 16+ characters is required; the gateway refuses to start without
  one. Only `/content` also accepts `?token=` (a video element can't send
  headers), so that token can end up in logs and the browser's history. For
  anything public, issue short-lived signed URLs instead.
- It serves plain HTTP on `127.0.0.1`. Put it behind HTTPS (a reverse proxy)
  before exposing it, and set `allowOrigin` to your app's origin, not `*`.
- FTP credentials live in `gateway.config.json` (git-ignored). Plain FTP sends
  them unencrypted: use `"secure": true` (FTPS) where the server supports it.
- Paths with `..` are rejected, so a request can't leave the source's `root`.
- There is one token and one data file: this is a single-user reference. A
  multi-user backend should key state by user.
- One FTP login per request; add a connection pool if that's too slow.
