# Connecting Beyt to a backend

Beyt in the browser (`import { Beyt } from "beyt"`) can use two things your
backend provides. Both are optional and independent.

| You want…                                   | Use                                  |
| ------------------------------------------- | ------------------------------------ |
| Videos and subtitles from FTP, SFTP, WebDAV, S3, a NAS | a **file source** (`sources`) |
| Watch history, settings, saved words kept on a server, plus server-side dictionary, subtitle matching, rename and trash | the **Beyt server** (`server`) |

```tsx
import { Beyt, httpFileSource, httpServer } from "beyt";
import "beyt/style.css";

<Beyt
  sources={[httpFileSource({ id: "home-nas", label: "Home NAS", baseUrl: "/api/beyt/v1/sources/home-nas" })]}
  server={httpServer({ baseUrl: "/api/beyt/v1", headers: () => ({ Authorization: `Bearer ${token}` }) })}
  onError={(e) => console.warn(e)}
/>;
// or, without React: mountBeyt(element, { sources, server })
```

A working implementation of everything below is in [`server/`](../server/README.md): a Node gateway with FTP support and tests.

## Why FTP needs a gateway

A web page cannot open FTP or SFTP connections: browsers only speak HTTP(S) and
WebSocket. So Beyt never talks FTP itself. Your server connects to the FTP
host (with `basic-ftp`, `curl`, rclone, or any library) and exposes it over
HTTP with the two routes below. The same two routes serve any protocol, so
SFTP, WebDAV and S3 gateways look identical to Beyt.

If you need something other than this HTTP shape, implement `FileSource`
yourself (`list`, `url`, optionally `read`) and pass it in `sources`.

## File source routes

`{base}` is the `baseUrl` you gave `httpFileSource`, one per source.

### `GET {base}/list?path=<relative path>`

`path` is relative to the source root: empty for the root, then `Season 1/Ep 2`
(no leading slash). Answer:

```json
{ "entries": [ { "name": "Season 1", "isDir": true }, { "name": "Ep 1.mp4", "isDir": false, "size": 734003200 } ] }
```

Beyt filters by extension and hides dot files itself; list everything.

### `GET {base}/content?path=<relative path>`

The file's bytes. **It must honor `Range` requests** (`206 Partial Content`,
`Accept-Ranges: bytes`): without them the player cannot seek. Set
`Content-Type` (`video/mp4`, `video/webm`, `text/plain`…) and CORS headers if
the API is on another origin.

The `<video>` element cannot send an `Authorization` header. Authorize the
stream with a signed URL or a cookie: pass `streamUrl` to `httpFileSource`
to add the token.

```ts
httpFileSource({
  id: "home-nas", label: "Home NAS", baseUrl,
  headers: () => ({ Authorization: `Bearer ${token}` }),           // list + subtitles
  streamUrl: (_path, url) => `${url}&token=${signedToken()}`,       // video
});
```

Browsers play MP4 (H.264/AAC) and WebM. Other containers (MKV, AVI) will not
play over a source, and embedded subtitle tracks are not read: use `.srt` or
`.vtt` files next to the video.

Source ids are stable keys: watch history is stored under
`web:/<id>/<path>`. Do not change an id once people use it.

## The Beyt server

Playback runs in the page. The server stores what should outlive the browser.
At startup Beyt calls `GET /state` and replaces its local copy; afterwards every
change is saved locally **and** sent to the server in the background. A failed
write is reported to `onError` and not retried. If `/state` fails, Beyt keeps
working from the browser's own storage.

Every route is relative to `baseUrl`; bodies are JSON; errors are
`{ "error": "<code>" }` with a 4xx/5xx status. Send the user's identity in a
header (the server decides what "user" means). Implement any subset: a
`BeytServer` object can leave methods out, and those features stay in the
browser.

| Method / route | Purpose | Body → answer |
| --- | --- | --- |
| `GET /state` | everything below, at startup | → `{ watch, addedSubtitles, series, settings, vocab, nextVocabId }` |
| `PUT /history?path=` | position of a video | `{ position, duration, updatedAt }` |
| `DELETE /history?path=` | forget one video | |
| `DELETE /history` | clear all history | |
| `POST /subtitles/added` | subtitle file the user added to a video | `{ video, path }` |
| `DELETE /subtitles/added?video=&path=` | remove it | |
| `PUT /series?folder=` | per-folder subtitle styles and audio choice | `SeriesSettings` |
| `PUT /settings/{key}` | one app setting | `{ value }` |
| `POST /vocab` | a saved word (id is assigned by Beyt) | `VocabItem` |
| `DELETE /vocab/{id}` | | |
| `POST /vocab/exported` | mark cards sent to Anki | `{ ids }` |
| `GET /dictionary/{lang}/{word}` | lookup | → `Lookup`; 404 `{ "error": "dictionary-missing" }` if none |
| `POST /subtitles/match` | rank subtitle files against the soundtrack | `{ path, files }` → `Candidate[]` |
| `GET /files/info?path=` | media details (ffprobe) | → `FileInfo` |
| `POST /files/rename` | rename a video | `{ path, name }` → `{ path }`; 409 `{ "error": "name-taken" }` |
| `POST /files/trash` | delete a video | `{ path, subtitles }` |
| `GET /files/thumbnail?path=&at=` | a frame | → `{ url }` |

All shapes are TypeScript types in `src/types.ts` (`Lookup`, `Candidate`,
`FileInfo`, `SeriesSettings`, `VocabItem`) and `BeytServer` / `BeytState` in
`src/backend/remote.ts`, exported from the package. `path` values are Beyt's
virtual paths (`web:/home-nas/Season 1/Ep 1.mp4`): the server maps
`web:/<source id>/…` to its own storage.

Not served by the server: playback controls, the subtitle overlay and Anki
export (Anki runs on the user's machine and is called from the page).

### Without HTTP

`httpServer` is one implementation of the `BeytServer` interface. Pass your
own object (GraphQL, tRPC, WebSocket, IndexedDB sync…) with the same methods.
