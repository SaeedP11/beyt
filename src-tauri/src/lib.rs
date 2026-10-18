// Beyt: a dual-subtitle video player for language learning.
//
// The app lives in this library so Android can load it as a shared library;
// `main.rs` only starts it on the desktop.

mod audio;
mod brightness;
mod dict;
mod info;
mod library;
mod media;
// Android has no GTK to host mpv's video, so it gets a stand-in until it has
// a player of its own.
#[cfg_attr(target_os = "android", path = "player_android.rs")]
mod player;
mod store;
mod subs;
mod sync;
mod vocab;

use std::{
    fmt::Display,
    path::{Path, PathBuf},
    sync::{
        Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};

use media::{Track, TrackSource, TrackStatus};
use player::Mpv;
use store::Store;

/// A file reopened within this many seconds of its start or end starts over.
const RESUME_MARGIN_START: f64 = 30.0;
const RESUME_MARGIN_END: f64 = 60.0;

struct App {
    mpv: &'static Mpv,
    store: Store,
    cache_dir: PathBuf,
    /// Cached video thumbnails for the library.
    thumb_dir: PathBuf,
    initial_file: Option<PathBuf>,
    current: Mutex<Option<Current>>,
    /// Screenshots and audio clips of saved vocabulary.
    vocab_media: PathBuf,
    /// Offline dictionary; `None` until it has been installed.
    dictionary: RwLock<Option<dict::Dictionary>>,
    dictionary_path: PathBuf,
    /// Set while `install_dictionary` runs, so two installs can't overlap.
    installing_dictionary: AtomicBool,
    /// The audio tracks last sent to the page (see `audio_changed`); cleared
    /// when a file opens, so its tracks are always sent.
    audio_signature: Mutex<Option<String>>,
}

struct Current {
    path: PathBuf,
    tracks: Vec<Track>,
}

impl App {
    fn current(&self) -> std::sync::MutexGuard<'_, Option<Current>> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn current_path(&self) -> Option<PathBuf> {
        self.current().as_ref().map(|c| c.path.clone())
    }

    fn audio_signature(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        self.audio_signature.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The open video's audio tracks, as the page shows them.
    fn audio_tracks(&self, video: &Path) -> Vec<audio::AudioTrack> {
        let mut tracks = player::audio_tracks(self.mpv);
        let added = self.store.added_audio(&video.to_string_lossy()).unwrap_or_default();
        audio::finish(&mut tracks, video.file_stem().and_then(|s| s.to_str()), &added);
        tracks
    }

    /// Sends `audio-tracks` when the open video's audio tracks have changed
    /// since they were last sent (they are only known once it has loaded).
    fn audio_changed(&self, handle: &AppHandle) {
        let Some(video) = self.current_path() else { return };
        let path = video.to_string_lossy().into_owned();
        let Some(signature) = player::audio_signature(self.mpv, &path) else { return };
        if self.audio_signature().as_ref() == Some(&signature) {
            return;
        }
        let tracks = self.audio_tracks(&video);
        *self.audio_signature() = Some(signature);
        let _ = handle.emit("audio-tracks", AudioUpdate { path, tracks });
    }

    /// Records how far the current file has been watched.
    fn save_position(&self) {
        let Some(path) = self.current().as_ref().map(|c| c.path.clone()) else { return };
        let p = player::playback(self.mpv);
        if p.time > 1.0 && p.duration > 0.0
            && let Err(err) = self.store.save_watch_state(&path.to_string_lossy(), p.time, p.duration) {
                eprintln!("beyt: saving position: {err:#}");
            }
    }
}

fn err(e: impl Display) -> String {
    e.to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Media {
    path: String,
    title: String,
    folder: String,
    tracks: Vec<Track>,
    /// Position playback resumed from, if any.
    resumed_at: Option<f64>,
    /// The series' saved subtitle settings (owned by the frontend).
    series: Option<serde_json::Value>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackUpdate {
    path: String,
    track: Track,
}

/// The `audio-tracks` event payload.
#[derive(Clone, Serialize)]
struct AudioUpdate {
    path: String,
    tracks: Vec<audio::AudioTrack>,
}

/// Settings that shape how a file opens.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenOptions {
    /// Languages to show by default when the series has no saved choice.
    preferred_languages: Vec<String>,
    /// Continue from the saved position.
    resume: bool,
}

// ---------- commands: opening media ----------

/// The file to open at startup. After the page reloads (to recover from an
/// error) this is the video that was playing, so it picks up where it was.
#[tauri::command]
fn initial_file(app: State<App>) -> Option<String> {
    let current = app.current().as_ref().map(|c| c.path.clone());
    current.or_else(|| app.initial_file.clone()).map(|p| p.to_string_lossy().into_owned())
}

/// Writes an error from the page to the log, since the page's own console is
/// gone once the app closes.
#[tauri::command]
fn log_error(message: String) {
    eprintln!("beyt: [page] {message}");
}

#[tauri::command]
async fn open_media(
    app: State<'_, App>,
    handle: AppHandle,
    path: String,
    options: OpenOptions,
) -> Result<Media, String> {
    let video = PathBuf::from(&path);
    if !video.is_file() {
        return Err(format!("not a file: {path}"));
    }
    app.save_position();

    let resumed_at = app
        .store
        .watch_state(&path)
        .map_err(err)?
        .filter(|w| {
            options.resume &&
                w.position > RESUME_MARGIN_START
                && (w.duration <= 0.0 || w.position < w.duration - RESUME_MARGIN_END)
        })
        .map(|w| w.position);
    let start = resumed_at.map_or_else(|| "none".to_string(), |p| format!("{p:.3}"));
    app.mpv.set_property("start", start.as_str()).map_err(|e| format!("{e:?}"))?;
    app.mpv.set_property("pause", false).map_err(|e| format!("{e:?}"))?;
    // Audio files added earlier, those still there. A content:// link from
    // Android's file picker may no longer be readable, so it isn't reopened.
    let audio: Vec<String> =
        app.store.added_audio(&path).map_err(err)?.into_iter().filter(|p| Path::new(p).is_file()).collect();
    player::load(app.mpv, &path, &audio).map_err(err)?;

    let added: Vec<PathBuf> =
        app.store.added_subtitles(&path).map_err(err)?.into_iter().map(PathBuf::from).collect();
    let tracks = media::tracks_for(&video, &added, &options.preferred_languages);
    *app.current() = Some(Current { path: video.clone(), tracks: tracks.clone() });
    // Sent for the new file even if its tracks look like the last file's.
    *app.audio_signature() = None;
    spawn_extraction(&handle, &video, &tracks);

    let folder = video.parent().unwrap_or(Path::new("/")).to_string_lossy().into_owned();
    Ok(Media {
        title: video.file_stem().unwrap_or_default().to_string_lossy().into_owned(),
        series: app.store.series_settings(&folder).map_err(err)?,
        folder,
        tracks,
        resumed_at,
        path,
    })
}

/// Extracts embedded text tracks in the background, sending each to the
/// overlay as a `track-updated` event when it is ready (or has failed).
fn spawn_extraction(handle: &AppHandle, video: &Path, tracks: &[Track]) {
    let pending: Vec<(usize, usize)> = tracks
        .iter()
        .filter(|t| t.status == TrackStatus::Loading)
        .filter_map(|t| match t.source {
            TrackSource::Embedded { stream, .. } => Some((t.id, stream)),
            TrackSource::File { .. } => None,
        })
        .collect();
    if pending.is_empty() {
        return;
    }
    let handle = handle.clone();
    let video = video.to_path_buf();
    std::thread::spawn(move || {
        let app = handle.state::<App>();
        let streams: Vec<usize> = pending.iter().map(|&(_, s)| s).collect();
        let results = media::extract_embedded(&video, &streams, &app.cache_dir);

        let mut current = app.current();
        let Some(cur) = current.as_mut().filter(|c| c.path == video) else {
            return; // Another file was opened meanwhile.
        };
        for (id, stream) in pending {
            let Some(track) = cur.tracks.iter_mut().find(|t| t.id == id) else { continue };
            match results.as_ref().map(|r| r.get(&stream)) {
                Ok(Some(Ok(loaded))) => {
                    track.status = TrackStatus::Ready;
                    track.rtl = loaded.rtl;
                    track.cues = loaded.cues.clone();
                }
                Ok(Some(Err(e))) => {
                    track.status = TrackStatus::Failed;
                    track.error = Some(format!("{e:#}"));
                }
                Ok(None) => continue,
                Err(e) => {
                    track.status = TrackStatus::Failed;
                    track.error = Some(format!("{e:#}"));
                }
            }
            let update = TrackUpdate { path: video.to_string_lossy().into_owned(), track: track.clone() };
            let _ = handle.emit("track-updated", update);
        }
    });
}

#[tauri::command]
async fn add_subtitle(app: State<'_, App>, path: String) -> Result<Track, String> {
    let mut current = app.current();
    let cur = current.as_mut().ok_or("no video is open")?;
    if cur.tracks.iter().any(|t| matches!(&t.source, TrackSource::File { path: p } if *p == path)) {
        return Err("This subtitle file is already loaded.".into());
    }
    let stem = cur.path.file_stem().and_then(|s| s.to_str()).map(str::to_owned);
    let track = media::file_track(Path::new(&path), stem.as_deref());
    if track.status == TrackStatus::Failed {
        return Err(track.error.unwrap_or_default());
    }
    // Remembered so the file loads again the next time this video is opened.
    app.store.add_subtitle(&cur.path.to_string_lossy(), &path).map_err(err)?;
    // Ids are never reused, since removing a track leaves a gap.
    let id = cur.tracks.iter().map(|t| t.id + 1).max().unwrap_or(0);
    cur.tracks.push(Track { id, added: true, ..track });
    media::assign_keys(&mut cur.tracks);
    Ok(cur.tracks.last().cloned().expect("just pushed"))
}

#[derive(Serialize)]
struct TrackKey {
    id: usize,
    key: String,
}

/// Removes a subtitle file the user added, and forgets it for this video.
/// Returns every track's key, since tracks after it may have moved up.
#[tauri::command]
fn remove_subtitle(app: State<App>, id: usize) -> Result<Vec<TrackKey>, String> {
    let mut current = app.current();
    let cur = current.as_mut().ok_or("no video is open")?;
    let index = cur.tracks.iter().position(|t| t.id == id && t.added).ok_or("not an added subtitle")?;
    if let TrackSource::File { path } = &cur.tracks[index].source {
        app.store.remove_subtitle(&cur.path.to_string_lossy(), path).map_err(err)?;
    }
    cur.tracks.remove(index);
    media::assign_keys(&mut cur.tracks);
    Ok(cur.tracks.iter().map(|t| TrackKey { id: t.id, key: t.key.clone() }).collect())
}

#[tauri::command]
async fn stop(app: State<'_, App>) -> Result<(), String> {
    app.save_position();
    *app.current() = None;
    *app.audio_signature() = None;
    app.mpv.command("stop", &[]).map_err(|e| format!("{e:?}"))
}

// ---------- commands: audio tracks ----------

/// The open video's audio tracks; `audio-tracks` events follow changes.
#[tauri::command]
async fn audio_tracks(app: State<'_, App>) -> Result<Vec<audio::AudioTrack>, String> {
    let video = app.current_path().ok_or("no video is open")?;
    Ok(app.audio_tracks(&video))
}

#[tauri::command]
async fn select_audio(app: State<'_, App>, id: i64) -> Result<(), String> {
    player::select_audio(app.mpv, id).map_err(|e| format!("{e:#}"))
}

/// Adds an audio file to the open video and switches to it. It is
/// remembered, so it loads again the next time this video is opened.
#[tauri::command]
async fn add_audio(app: State<'_, App>, path: String) -> Result<(), String> {
    let video = app.current_path().ok_or("no video is open")?;
    if app.audio_tracks(&video).iter().any(|t| t.file.as_deref() == Some(path.as_str())) {
        return Err("This audio file is already loaded.".into());
    }
    player::add_audio(app.mpv, &path).map_err(|e| format!("{e:#}"))?;
    app.store.add_audio(&video.to_string_lossy(), &path).map_err(err)
}

/// Removes an audio file the user added, and forgets it for this video.
#[tauri::command]
async fn remove_audio(app: State<'_, App>, id: i64) -> Result<(), String> {
    let video = app.current_path().ok_or("no video is open")?;
    let tracks = app.audio_tracks(&video);
    let file = tracks
        .iter()
        .find(|t| t.id == id && t.added)
        .and_then(|t| t.file.clone())
        .ok_or("not an added audio file")?;
    player::remove_audio(app.mpv, id).map_err(|e| format!("{e:#}"))?;
    app.store.remove_audio(&video.to_string_lossy(), &file).map_err(err)
}

// ---------- commands: dictionary ----------

/// Looks up a subtitle word: English words in Persian, Persian words in English.
#[tauri::command]
async fn lookup_word(app: State<'_, App>, word: String, lang: String) -> Result<dict::Lookup, String> {
    let guard = app.dictionary.read().unwrap_or_else(|e| e.into_inner());
    let dictionary = guard.as_ref().ok_or("dictionary-missing")?;
    if lang == "fa" { dictionary.lookup_persian(&word) } else { dictionary.lookup_english(&word) }.map_err(err)
}

/// Downloads Wiktionary's Persian entries and builds the offline dictionary,
/// replacing the installed one. Sends `dictionary-progress` with the fraction
/// downloaded (null when the size isn't known). Returns the entry count.
#[tauri::command]
async fn install_dictionary(app: State<'_, App>, handle: AppHandle) -> Result<i64, String> {
    if app.installing_dictionary.swap(true, Ordering::SeqCst) {
        return Err("already-installing".into());
    }
    let path = app.dictionary_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let built = dict::install(&path, |p| {
            let _ = handle.emit("dictionary-progress", p);
        })?;
        eprintln!("beyt: dictionary installed ({} entries, {} English keys)", built.entries, built.keys);
        dict::Dictionary::open(&path)
    })
    .await;
    app.installing_dictionary.store(false, Ordering::SeqCst);
    let dictionary = result.map_err(err)?.map_err(|e| {
        eprintln!("beyt: dictionary install failed: {e:#}");
        format!("{e:#}")
    })?;
    let entries = dictionary.entry_count().map_err(err)?;
    *app.dictionary.write().unwrap_or_else(|e| e.into_inner()) = Some(dictionary);
    Ok(entries)
}

// ---------- commands: vocabulary ----------

/// Saves a word or line with a screenshot of the current frame and an audio
/// clip of the line.
#[tauri::command]
async fn save_vocab(
    app: State<'_, App>,
    item: store::NewVocab,
    capture: vocab::CaptureOptions,
) -> Result<store::VocabItem, String> {
    let id = app.store.add_vocab(&item).map_err(err)?;
    let span = (item.start, item.end);
    let (shot, audio) = vocab::capture(app.mpv, &app.vocab_media, id, Path::new(&item.video), span, &capture);
    app.store.set_vocab_media(id, shot.as_deref(), audio.as_deref()).map_err(err)?;
    app.store
        .list_vocab()
        .map_err(err)?
        .into_iter()
        .find(|v| v.id == id)
        .ok_or_else(|| "saved item disappeared".into())
}

#[tauri::command]
fn list_vocab(app: State<App>) -> Result<Vec<store::VocabItem>, String> {
    app.store.list_vocab().map_err(err)
}

#[tauri::command]
fn delete_vocab(app: State<App>, id: i64) -> Result<(), String> {
    if let Some(item) = app.store.delete_vocab(id).map_err(err)? {
        vocab::delete_media(&app.vocab_media, &item);
    }
    Ok(())
}

/// Sends items not yet exported to Anki through AnkiConnect.
#[tauri::command]
async fn export_anki(app: State<'_, App>, anki: vocab::AnkiConfig) -> Result<vocab::AnkiResult, String> {
    let pending: Vec<_> = app.store.list_vocab().map_err(err)?.into_iter().filter(|v| !v.exported).collect();
    let result = vocab::export_to_anki(&pending, &app.vocab_media, &anki).map_err(|e| format!("{e:#}"))?;
    app.store.mark_exported(&result.added).map_err(err)?;
    Ok(result)
}

/// Writes all items to a CSV file; returns the folder the media was copied to.
#[tauri::command]
async fn export_csv(app: State<'_, App>, path: String) -> Result<String, String> {
    let items = app.store.list_vocab().map_err(err)?;
    let media = vocab::export_csv(&items, &app.vocab_media, Path::new(&path)).map_err(|e| format!("{e:#}"))?;
    Ok(media.to_string_lossy().into_owned())
}

#[tauri::command]
fn vocab_media_dir(app: State<App>) -> String {
    app.vocab_media.to_string_lossy().into_owned()
}

#[tauri::command]
async fn test_anki(anki: vocab::AnkiConfig) -> Result<i64, String> {
    vocab::test_anki(&anki).map_err(|e| format!("{e:#}"))
}

// ---------- commands: settings and data ----------

/// mpv options the settings screen may change.
const MPV_OPTIONS: &[&str] = &["hwdec", "speed", "volume"];

#[tauri::command]
async fn set_mpv_option(app: State<'_, App>, name: String, value: String) -> Result<(), String> {
    if !MPV_OPTIONS.contains(&name.as_str()) {
        return Err(format!("not a settable option: {name}"));
    }
    app.mpv.set_property(&name, value.as_str()).map_err(|e| format!("{e:?}"))
}

/// Adds `delta` to volume (0–130) or speed (0.25–4); returns the new value.
#[tauri::command]
async fn adjust_property(app: State<'_, App>, name: String, delta: f64) -> Result<f64, String> {
    let (min, max) = match name.as_str() {
        "volume" => (0.0, 130.0),
        "speed" => (0.25, 4.0),
        _ => return Err(format!("not adjustable: {name}")),
    };
    let current: f64 = app.mpv.get_property(&name).map_err(|e| format!("{e:?}"))?;
    let next = ((current + delta) * 100.0).round() / 100.0;
    let next = next.clamp(min, max);
    app.mpv.set_property(&name, next).map_err(|e| format!("{e:?}"))?;
    Ok(next)
}

/// The backlight level, or mpv's picture brightness without a backlight.
#[tauri::command]
async fn get_brightness(app: State<'_, App>) -> Result<brightness::Brightness, String> {
    brightness::get(app.mpv).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn set_brightness(app: State<'_, App>, level: f64) -> Result<brightness::Brightness, String> {
    brightness::set(app.mpv, level).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn toggle_mute(app: State<'_, App>) -> Result<bool, String> {
    app.mpv.command("cycle", &["mute"]).map_err(|e| format!("{e:?}"))?;
    app.mpv.get_property("mute").map_err(|e| format!("{e:?}"))
}

#[tauri::command]
fn clear_watch_history(app: State<App>) -> Result<(), String> {
    app.store.clear_watch_history().map_err(err)
}

#[tauri::command]
fn clear_subtitle_cache(app: State<App>) -> Result<(), String> {
    match std::fs::remove_dir_all(&app.cache_dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DataInfo {
    data_dir: String,
    dictionary_entries: Option<i64>,
}

#[tauri::command]
fn data_info(app: State<App>, handle: AppHandle) -> Result<DataInfo, String> {
    Ok(DataInfo {
        data_dir: handle.path().app_data_dir().map_err(err)?.to_string_lossy().into_owned(),
        dictionary_entries: app
            .dictionary
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(|d| d.entry_count().ok()),
    })
}

/// Streams, frame rate, release name and hash of a video, to find subtitles that fit it.
#[tauri::command]
async fn file_info(path: String) -> Result<info::FileInfo, String> {
    tauri::async_runtime::spawn_blocking(move || info::file_info(Path::new(&path)))
        .await
        .map_err(err)?
        .map_err(|e| format!("{e:#}"))
}

/// Ranks subtitle files by how well they fit the video's soundtrack, best
/// first, sending `match-progress` (0–1) while the audio is read.
#[tauri::command]
async fn match_subtitles(
    app: State<'_, App>,
    handle: AppHandle,
    path: String,
    files: Vec<String>,
) -> Result<Vec<sync::Candidate>, String> {
    let cache_dir = app.cache_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let files: Vec<PathBuf> = files.into_iter().map(PathBuf::from).collect();
        sync::rank(Path::new(&path), &files, &cache_dir, |p| {
            let _ = handle.emit("match-progress", p);
        })
    })
    .await
    .map_err(err)?
    .map_err(|e| format!("{e:#}"))
}

// ---------- commands: library ----------

#[tauri::command]
async fn list_folder(app: State<'_, App>, path: String) -> Result<serde_json::Value, String> {
    let folder = media::list_folder(Path::new(&path)).map_err(err)?;
    // Add how far each video has been watched.
    let mut value = serde_json::to_value(&folder).map_err(err)?;
    if let Some(entries) = value["entries"].as_array_mut() {
        for entry in entries {
            if let Some(p) = entry["path"].as_str()
                && let Ok(Some(w)) = app.store.watch_state(p) {
                    entry["position"] = w.position.into();
                    entry["duration"] = w.duration.into();
                }
        }
    }
    Ok(value)
}

#[tauri::command]
async fn list_subtitle_folder(path: String) -> Result<media::Folder, String> {
    media::list_subtitle_folder(Path::new(&path)).map_err(err)
}

#[tauri::command]
fn recent_files(app: State<App>) -> Result<Vec<store::Recent>, String> {
    let mut recent = app.store.recent(30).map_err(err)?;
    recent.retain(|r| Path::new(&r.path).is_file());
    recent.truncate(12);
    Ok(recent)
}

/// A cached frame of the video at `at` seconds (or 15% in), as a file path.
#[tauri::command]
async fn thumbnail(app: State<'_, App>, path: String, at: Option<f64>) -> Result<String, String> {
    let cache = app.thumb_dir.clone();
    tauri::async_runtime::spawn_blocking(move || library::thumbnail(Path::new(&path), at, &cache))
        .await
        .map_err(err)?
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| format!("{e:#}"))
}

/// Subtitle files that are renamed and trashed along with the video.
#[tauri::command]
fn video_sidecars(path: String) -> Vec<String> {
    library::sidecars(Path::new(&path)).into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// Renames a video and its subtitle files; returns the video's new path.
/// Fails with `name-taken` when a file already has a new name.
#[tauri::command]
fn rename_video(app: State<App>, path: String, name: String) -> Result<String, String> {
    if app.current().as_ref().is_some_and(|c| c.path == Path::new(&path)) {
        return Err("This video is playing.".into());
    }
    let moves = library::rename(Path::new(&path), &name).map_err(|e| format!("{e:#}"))?;
    let Some((_, to)) = moves.first() else { return Ok(path) };
    let new_path = to.to_string_lossy().into_owned();
    let moves: Vec<(String, String)> = moves
        .iter()
        .map(|(a, b)| (a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned()))
        .collect();
    app.store.rename_paths(&moves).map_err(err)?;
    Ok(new_path)
}

/// Moves a video, and its subtitle files if asked, to the Trash. Its watch
/// position and saved words stay, in case it is restored.
#[tauri::command]
async fn trash_video(app: State<'_, App>, path: String, subtitles: bool) -> Result<(), String> {
    let video = PathBuf::from(&path);
    if app.current().as_ref().is_some_and(|c| c.path == video) {
        return Err("This video is playing.".into());
    }
    let mut files = vec![video.clone()];
    if subtitles {
        files.extend(library::sidecars(&video));
    }
    tauri::async_runtime::spawn_blocking(move || library::trash(&files))
        .await
        .map_err(err)?
        .map_err(|e| format!("{e:#}"))
}

/// Takes a video off Continue watching, forgetting where it was stopped.
#[tauri::command]
fn forget_recent(app: State<App>, path: String) -> Result<(), String> {
    app.store.forget_watch(&path).map_err(err)
}

#[tauri::command]
async fn show_in_folder(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || library::show_in_folder(Path::new(&path)))
        .await
        .map_err(err)?
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn next_video(path: String) -> Option<String> {
    media::next_video(Path::new(&path)).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn save_series_settings(app: State<App>, folder: String, settings: serde_json::Value) -> Result<(), String> {
    app.store.save_series_settings(&folder, &settings).map_err(err)
}

#[tauri::command]
fn app_settings(app: State<App>) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    app.store.app_settings().map_err(err)
}

#[tauri::command]
fn set_app_setting(app: State<App>, key: String, value: serde_json::Value) -> Result<(), String> {
    app.store.set_app_setting(&key, &value).map_err(err)
}

// ---------- commands: playback ----------

// Commands that call mpv are async so they run on a worker thread. Plain
// commands run on the GTK main thread, which also renders mpv's video, and
// mpv's render API forbids blocking calls there: the core can be waiting on
// the renderer, so playback stalls (see mpv/render.h, "Threading").

#[tauri::command]
async fn toggle_pause(app: State<'_, App>, handle: AppHandle) -> Result<(), String> {
    app.mpv.command("cycle", &["pause"]).map_err(|e| format!("{e:?}"))?;
    // Tell the overlay now rather than on the next clock tick.
    let _ = handle.emit("playback", player::playback(app.mpv));
    Ok(())
}

#[tauri::command]
async fn set_pause(app: State<'_, App>, handle: AppHandle, paused: bool) -> Result<(), String> {
    app.mpv.set_property("pause", paused).map_err(|e| format!("{e:?}"))?;
    let _ = handle.emit("playback", player::playback(app.mpv));
    Ok(())
}

#[tauri::command]
async fn seek_absolute(app: State<'_, App>, time: f64) -> Result<(), String> {
    app.mpv
        .command("seek", &[&time.to_string(), "absolute+exact"])
        .map_err(|e| format!("{e:?}"))
}

/// The picture shapes the player offers; ratios are width:height.
const ASPECTS: &[&str] = &["auto", "original", "16:9", "4:3", "fill", "stretch"];

#[tauri::command]
async fn set_aspect(app: State<'_, App>, aspect: String) -> Result<(), String> {
    if !ASPECTS.contains(&aspect.as_str()) {
        return Err(format!("not an aspect ratio: {aspect}"));
    }
    player::set_aspect(app.mpv, &aspect).map_err(|e| format!("{e:#}"))
}

/// Shows a picture-based subtitle track drawn by mpv itself, or none.
#[tauri::command]
async fn set_mpv_subtitle(app: State<'_, App>, sid: Option<i64>) -> Result<(), String> {
    let value = sid.map_or_else(|| "no".to_string(), |s| s.to_string());
    app.mpv.set_property("sid", value.as_str()).map_err(|e| format!("{e:?}"))
}

#[tauri::command]
fn toggle_fullscreen(window: WebviewWindow) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let full = window.is_fullscreen().map_err(err)?;
        window.set_fullscreen(!full).map_err(err)
    }
    // Phone apps already fill the screen.
    #[cfg(mobile)]
    {
        let _ = window;
        Ok(())
    }
}

#[derive(Serialize, serde::Deserialize)]
struct StorageAccess {
    /// Videos and their subtitle files can be read by path.
    granted: bool,
    /// Where the device's own files start (Android's shared storage).
    root: Option<String>,
}

/// Android needs all-files access before the library can browse folders.
/// Async, like the playback commands, so it never waits on the UI thread.
#[tauri::command]
async fn storage_access() -> Result<StorageAccess, String> {
    #[cfg(target_os = "android")]
    return player::run("storageAccess").map_err(|e| format!("{e:#}"));
    #[cfg(not(target_os = "android"))]
    Ok(StorageAccess { granted: true, root: None })
}

/// Opens Android's permission screen for all-files access.
#[tauri::command]
async fn request_storage_access() -> Result<(), String> {
    #[cfg(target_os = "android")]
    player::run::<serde_json::Value>("requestStorageAccess").map_err(|e| format!("{e:#}"))?;
    Ok(())
}

/// Android's Back button in the library: Beyt goes to the background, still
/// open, rather than closing.
#[tauri::command]
async fn move_to_background() -> Result<(), String> {
    #[cfg(target_os = "android")]
    player::run::<serde_json::Value>("moveToBack").map_err(|e| format!("{e:#}"))?;
    Ok(())
}

/// Android: shows `text` in the Google Translate app (or on its website),
/// translated into `to`.
#[tauri::command]
async fn translate_externally(text: String, to: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    return player::translate(&text, &to).map_err(|e| format!("{e:#}"));
    #[cfg(not(target_os = "android"))]
    {
        let _ = (text, to);
        Err("Translating with Google Translate is only on Android".into())
    }
}

/// Whether a physical keyboard is attached; the `hard-keyboard` event follows
/// changes. Desktops are taken to always have one.
#[tauri::command]
fn hard_keyboard() -> bool {
    #[cfg(target_os = "android")]
    return player::hard_keyboard();
    #[cfg(not(target_os = "android"))]
    true
}

#[tauri::command]
fn quit(app: State<App>, handle: AppHandle) {
    app.save_position();
    handle.exit(0);
}

/// Sends the playback position to the overlay 20 times a second, keeps the
/// `auto` aspect fitted, checks the audio tracks 4 times a second and saves
/// the watch position every 5 seconds.
fn spawn_clock(handle: AppHandle) {
    std::thread::spawn(move || {
        let app = handle.state::<App>();
        let mut tick = 0u64;
        loop {
            tick += 1;
            let _ = handle.emit("playback", player::playback(app.mpv));
            player::fit_auto(app.mpv);
            if tick.is_multiple_of(5) {
                app.audio_changed(&handle);
            }
            if tick.is_multiple_of(100) {
                app.save_position();
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });
}

/// Sends stderr to `beyt.log` in the data folder when Beyt was started from
/// the desktop rather than a terminal, so a freeze or crash leaves a trace.
/// The previous run's log is kept as `beyt.log.old`.
fn log_to_file(data_dir: &Path) {
    use std::os::fd::AsRawFd;
    if unsafe { libc::isatty(libc::STDERR_FILENO) } == 1 {
        return;
    }
    let path = data_dir.join("beyt.log");
    let _ = std::fs::create_dir_all(data_dir);
    let _ = std::fs::rename(&path, data_dir.join("beyt.log.old"));
    match std::fs::File::create(&path) {
        // The file stays open for the life of the process as fd 2.
        Ok(file) => unsafe {
            libc::dup2(file.as_raw_fd(), libc::STDERR_FILENO);
        },
        Err(e) => eprintln!("beyt: opening {}: {e}", path.display()),
    }
    eprintln!("beyt {} started", env!("CARGO_PKG_VERSION"));
}

/// Reloads the page if WebKit's page process crashes or is killed, which
/// otherwise leaves the window blank and unresponsive. `initial_file` then
/// reopens the video that was playing.
#[cfg(target_os = "linux")]
fn reload_if_page_dies(window: &WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| {
        use webkit2gtk::WebViewExt;
        webview.inner().connect_web_process_terminated(|view, reason| {
            eprintln!("beyt: the page process ended ({reason:?}); reloading");
            view.reload();
        });
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cli_file = std::env::args_os().nth(1).map(PathBuf::from);

    let mpv = player::create_mpv().unwrap_or_else(|e| {
        eprintln!("beyt: {e:#}");
        std::process::exit(1);
    });

    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    // Android's video player, in PlayerPlugin.kt.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(player::plugin());

    builder
        .invoke_handler(tauri::generate_handler![
            initial_file,
            open_media,
            add_subtitle,
            remove_subtitle,
            file_info,
            match_subtitles,
            lookup_word,
            install_dictionary,
            save_vocab,
            list_vocab,
            delete_vocab,
            export_anki,
            export_csv,
            vocab_media_dir,
            test_anki,
            set_mpv_option,
            adjust_property,
            toggle_mute,
            get_brightness,
            set_brightness,
            clear_watch_history,
            clear_subtitle_cache,
            data_info,
            stop,
            list_folder,
            list_subtitle_folder,
            recent_files,
            thumbnail,
            video_sidecars,
            rename_video,
            trash_video,
            forget_recent,
            show_in_folder,
            next_video,
            save_series_settings,
            app_settings,
            set_app_setting,
            toggle_pause,
            set_pause,
            seek_absolute,
            set_mpv_subtitle,
            audio_tracks,
            select_audio,
            add_audio,
            remove_audio,
            set_aspect,
            toggle_fullscreen,
            quit,
            log_error,
            storage_access,
            request_storage_access,
            move_to_background,
            hard_keyboard,
            translate_externally,
        ])
        .setup(move |app| {
            let paths = app.path();
            log_to_file(&paths.app_data_dir()?);
            let store = Store::open(&paths.app_data_dir()?.join("beyt.db"))?;
            let cache_dir = paths.app_cache_dir()?.join("subtitles");
            let thumb_dir = paths.app_cache_dir()?.join("thumbnails");
            let dictionary_path = paths.app_data_dir()?.join("dictionary.db");
            let dictionary = dict::Dictionary::open(&dictionary_path)
                .inspect_err(|e| eprintln!("beyt: no offline dictionary yet ({e:#})"))
                .ok();
            app.manage(App {
                mpv,
                store,
                cache_dir,
                thumb_dir,
                vocab_media: paths.app_data_dir()?.join("vocab-media"),
                initial_file: cli_file,
                current: Mutex::new(None),
                dictionary: RwLock::new(dictionary),
                dictionary_path,
                installing_dictionary: AtomicBool::new(false),
                audio_signature: Mutex::new(None),
            });

            let window = app.get_webview_window("main").expect("main window");
            player::attach_video(&window, mpv)?;
            #[cfg(target_os = "linux")]
            reload_if_page_dies(&window)?;
            spawn_clock(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                window.state::<App>().save_position();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Beyt");
}
