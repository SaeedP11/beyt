// Beyt: a dual-subtitle video player for language learning.

mod media;
mod player;
mod store;
mod subs;

use std::{
    fmt::Display,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use libmpv2::Mpv;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};

use media::{Track, TrackSource, TrackStatus};
use store::Store;

/// A file reopened within this many seconds of its start or end starts over.
const RESUME_MARGIN_START: f64 = 30.0;
const RESUME_MARGIN_END: f64 = 60.0;

struct App {
    mpv: &'static Mpv,
    store: Store,
    cache_dir: PathBuf,
    initial_file: Option<PathBuf>,
    current: Mutex<Option<Current>>,
}

struct Current {
    path: PathBuf,
    tracks: Vec<Track>,
}

impl App {
    fn current(&self) -> std::sync::MutexGuard<'_, Option<Current>> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
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

// ---------- commands: opening media ----------

#[tauri::command]
fn initial_file(app: State<App>) -> Option<String> {
    app.initial_file.as_ref().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
async fn open_media(app: State<'_, App>, handle: AppHandle, path: String) -> Result<Media, String> {
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
            w.position > RESUME_MARGIN_START
                && (w.duration <= 0.0 || w.position < w.duration - RESUME_MARGIN_END)
        })
        .map(|w| w.position);
    let start = resumed_at.map_or_else(|| "none".to_string(), |p| format!("{p:.3}"));
    app.mpv.set_property("start", start.as_str()).map_err(|e| format!("{e:?}"))?;
    app.mpv.set_property("pause", false).map_err(|e| format!("{e:?}"))?;
    player::load(app.mpv, &path).map_err(err)?;

    let tracks = media::tracks_for(&video);
    *app.current() = Some(Current { path: video.clone(), tracks: tracks.clone() });
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
            let Some(track) = cur.tracks.get_mut(id) else { continue };
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
    let stem = cur.path.file_stem().and_then(|s| s.to_str()).map(str::to_owned);
    let track = media::file_track(Path::new(&path), stem.as_deref());
    if track.status == TrackStatus::Failed {
        return Err(track.error.unwrap_or_default());
    }
    cur.tracks.push(track);
    let first = cur.tracks.len() - 1;
    media::number_tracks(&mut cur.tracks, first);
    Ok(cur.tracks[first].clone())
}

#[tauri::command]
fn stop(app: State<App>) -> Result<(), String> {
    app.save_position();
    *app.current() = None;
    app.mpv.command("stop", &[]).map_err(|e| format!("{e:?}"))
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
fn recent_files(app: State<App>) -> Result<Vec<store::Recent>, String> {
    let mut recent = app.store.recent(30).map_err(err)?;
    recent.retain(|r| Path::new(&r.path).is_file());
    recent.truncate(12);
    Ok(recent)
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

#[tauri::command]
fn toggle_pause(app: State<App>, handle: AppHandle) -> Result<(), String> {
    app.mpv.command("cycle", &["pause"]).map_err(|e| format!("{e:?}"))?;
    // Tell the overlay now rather than on the next clock tick.
    let _ = handle.emit("playback", player::playback(app.mpv));
    Ok(())
}

#[tauri::command]
fn seek_absolute(app: State<App>, time: f64) -> Result<(), String> {
    app.mpv
        .command("seek", &[&time.to_string(), "absolute+exact"])
        .map_err(|e| format!("{e:?}"))
}

/// Shows a picture-based subtitle track drawn by mpv itself, or none.
#[tauri::command]
fn set_mpv_subtitle(app: State<App>, sid: Option<i64>) -> Result<(), String> {
    let value = sid.map_or_else(|| "no".to_string(), |s| s.to_string());
    app.mpv.set_property("sid", value.as_str()).map_err(|e| format!("{e:?}"))
}

#[tauri::command]
fn toggle_fullscreen(window: WebviewWindow) -> Result<(), String> {
    let full = window.is_fullscreen().map_err(err)?;
    window.set_fullscreen(!full).map_err(err)
}

#[tauri::command]
fn quit(app: State<App>, handle: AppHandle) {
    app.save_position();
    handle.exit(0);
}

/// Sends the playback position to the overlay 20 times a second, and saves
/// the watch position every 5 seconds.
fn spawn_clock(handle: AppHandle) {
    std::thread::spawn(move || {
        let app = handle.state::<App>();
        let mut tick = 0u64;
        loop {
            tick += 1;
            let _ = handle.emit("playback", player::playback(app.mpv));
            if tick.is_multiple_of(100) {
                app.save_position();
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });
}

fn main() {
    let cli_file = std::env::args_os().nth(1).map(PathBuf::from);

    let mpv = player::create_mpv().unwrap_or_else(|e| {
        eprintln!("beyt: {e:#}");
        std::process::exit(1);
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            initial_file,
            open_media,
            add_subtitle,
            stop,
            list_folder,
            recent_files,
            next_video,
            save_series_settings,
            app_settings,
            set_app_setting,
            toggle_pause,
            seek_absolute,
            set_mpv_subtitle,
            toggle_fullscreen,
            quit,
        ])
        .setup(move |app| {
            let paths = app.path();
            let store = Store::open(&paths.app_data_dir()?.join("beyt.db"))?;
            let cache_dir = paths.app_cache_dir()?.join("subtitles");
            app.manage(App { mpv, store, cache_dir, initial_file: cli_file.clone(), current: Mutex::new(None) });

            let window = app.get_webview_window("main").expect("main window");
            player::attach_video(&window, mpv)?;
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
