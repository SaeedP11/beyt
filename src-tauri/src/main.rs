// Beyt: a dual-subtitle video player for language learning.

mod player;
mod subs;

use std::path::PathBuf;

use libmpv2::Mpv;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

struct App {
    mpv: &'static Mpv,
    tracks: Vec<subs::Track>,
}

#[tauri::command]
fn get_tracks(app: State<App>) -> Vec<subs::Track> {
    app.tracks.clone()
}

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

#[tauri::command]
fn toggle_fullscreen(window: WebviewWindow) -> Result<(), String> {
    let full = window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(!full).map_err(|e| e.to_string())
}

#[tauri::command]
fn quit(handle: AppHandle) {
    handle.exit(0);
}

fn main() {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    let Some(video) = args.first().cloned() else {
        eprintln!("usage: beyt <video> [subtitle files…]");
        std::process::exit(2);
    };

    // Subtitles named on the command line come first, then ones found next to the video.
    let mut sub_files: Vec<PathBuf> = args[1..].to_vec();
    for found in subs::find_sidecars(&video) {
        if !sub_files.iter().any(|f| f.canonicalize().ok() == found.canonicalize().ok()) {
            sub_files.push(found);
        }
    }
    let tracks = subs::load_tracks(&sub_files);
    for t in &tracks {
        eprintln!("beyt: track {}: {} ({} lines)", t.id, t.label, t.cues.len());
    }

    let mpv = player::create_mpv().unwrap_or_else(|e| {
        eprintln!("beyt: {e:#}");
        std::process::exit(1);
    });

    tauri::Builder::default()
        .manage(App { mpv, tracks })
        .invoke_handler(tauri::generate_handler![
            get_tracks,
            toggle_pause,
            seek_absolute,
            toggle_fullscreen,
            quit
        ])
        .setup(move |app| {
            let window = app.get_webview_window("main").expect("main window");
            player::attach_video(&window, mpv)?;
            player::load(mpv, &video.to_string_lossy())?;
            player::spawn_clock(app.handle().clone(), mpv);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Beyt");
}
