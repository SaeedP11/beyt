//! Android playback, in place of `player.rs`.
//!
//! The video is played by Media3 ExoPlayer in `PlayerPlugin.kt`, drawn under
//! the transparent webview like mpv is on the desktop. `Mpv` here answers the
//! mpv calls the rest of Beyt makes (properties such as `pause` and `volume`,
//! commands such as `seek`) by forwarding them to that plugin.
//!
//! Plugin calls wait for Android's UI thread, so a call made from the UI
//! thread itself would never return. Reads therefore come from a copy of the
//! player's state that a background thread refreshes 20 times a second, and
//! only writes go to the plugin (from Tauri's async commands, which run on
//! worker threads).

use std::{
    sync::{Mutex, OnceLock},
    time::Duration,
};

use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tauri::{
    WebviewWindow, Wry,
    plugin::{Builder, PluginHandle, TauriPlugin},
};

/// Why an mpv call failed, in the shape `libmpv2::Error` is printed (`{e:?}`).
#[derive(Debug)]
pub struct Error(String);

/// The player's state as `PlayerPlugin.state` reports it.
#[derive(Clone, Deserialize)]
#[serde(default)]
struct Remote {
    time: f64,
    paused: bool,
    speed: f64,
    duration: f64,
    eof: bool,
    volume: f64,
    mute: bool,
    error: Option<String>,
}

impl Default for Remote {
    fn default() -> Self {
        Remote { time: 0.0, paused: true, speed: 1.0, duration: 0.0, eof: false, volume: 100.0, mute: false, error: None }
    }
}

/// Mirrors the parts of `libmpv2::Mpv` that Beyt calls.
pub struct Mpv {
    state: Mutex<Remote>,
    /// mpv's `start`: where the next file opens.
    start: Mutex<Option<f64>>,
    /// mpv's picture `brightness` (-100–100); shown as the screen's brightness.
    brightness: Mutex<i64>,
}

static MPV: OnceLock<Mpv> = OnceLock::new();
static PLUGIN: OnceLock<PluginHandle<Wry>> = OnceLock::new();

impl Mpv {
    fn state(&self) -> std::sync::MutexGuard<'_, Remote> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn call<T: DeserializeOwned>(&self, command: &str, payload: Value) -> Result<T, Error> {
        let plugin = PLUGIN.get().ok_or_else(|| Error("the video player hasn't started".into()))?;
        plugin.run_mobile_plugin(command, payload).map_err(|e| Error(e.to_string()))
    }

    /// Changes settings on the player and in the local copy, so a read right
    /// after a write already sees it.
    fn set(&self, changes: Value) -> Result<(), Error> {
        self.call::<Value>("set", changes.clone())?;
        let mut state = self.state();
        if let Some(p) = changes["paused"].as_bool() {
            state.paused = p;
        }
        if let Some(t) = changes["position"].as_f64() {
            state.time = t;
            state.eof = false;
        }
        if let Some(s) = changes["speed"].as_f64() {
            state.speed = s;
        }
        if let Some(v) = changes["volume"].as_f64() {
            state.volume = v;
        }
        if let Some(m) = changes["mute"].as_bool() {
            state.mute = m;
        }
        Ok(())
    }

    pub fn set_property<T: Serialize>(&self, name: &str, value: T) -> Result<(), Error> {
        let value = serde_json::to_value(value).map_err(|e| Error(e.to_string()))?;
        match name {
            "pause" => self.set(json!({ "paused": flag(&value)? })),
            "speed" => self.set(json!({ "speed": number(&value)? })),
            "volume" => self.set(json!({ "volume": number(&value)? })),
            "mute" => self.set(json!({ "mute": flag(&value)? })),
            "start" => {
                // "none" or seconds, as `open_media` gives it.
                *self.start.lock().unwrap_or_else(|e| e.into_inner()) = number(&value).ok();
                Ok(())
            }
            "brightness" => {
                let picture = number(&value)?.round() as i64;
                *self.brightness.lock().unwrap_or_else(|e| e.into_inner()) = picture;
                // brightness.rs keeps the picture level within 50–115.
                let screen = ((100 + picture) as f64 - 50.0) / 65.0;
                self.set(json!({ "brightness": screen.clamp(0.01, 1.0) }))
            }
            // ExoPlayer picks its decoder itself, and text subtitles are the
            // overlay's; picture subtitles aren't drawn on Android yet.
            "hwdec" | "sid" => Ok(()),
            _ => Err(Error(format!("{name} is not supported on Android"))),
        }
    }

    pub fn get_property<T: DeserializeOwned>(&self, name: &str) -> Result<T, Error> {
        let state = self.state().clone();
        let value = match name {
            "time-pos" => json!(state.time),
            "pause" => json!(state.paused),
            "speed" => json!(state.speed),
            "duration" => json!(state.duration),
            "eof-reached" => json!(state.eof),
            "volume" => json!(state.volume),
            "mute" => json!(state.mute),
            "brightness" => json!(*self.brightness.lock().unwrap_or_else(|e| e.into_inner())),
            _ => return Err(Error(format!("{name} is not available on Android"))),
        };
        serde_json::from_value(value).map_err(|e| Error(e.to_string()))
    }

    pub fn command(&self, name: &str, args: &[&str]) -> Result<(), Error> {
        match (name, args) {
            ("loadfile", [path, ..]) => {
                let start = self.start.lock().unwrap_or_else(|e| e.into_inner()).unwrap_or(0.0);
                let paused = self.state().paused;
                self.call::<Value>("open", json!({ "path": path, "start": start, "paused": paused }))?;
                let mut state = self.state();
                state.time = start;
                state.duration = 0.0;
                state.eof = false;
                Ok(())
            }
            ("stop", _) => {
                self.call::<Value>("stop", json!({}))?;
                let mut state = self.state();
                *state = Remote { volume: state.volume, mute: state.mute, ..Remote::default() };
                Ok(())
            }
            ("cycle", ["pause"]) => {
                let paused = !self.state().paused;
                self.set(json!({ "paused": paused }))
            }
            ("cycle", ["mute"]) => {
                let mute = !self.state().mute;
                self.set(json!({ "mute": mute }))
            }
            ("seek", [time, ..]) => {
                let time: f64 = time.parse().map_err(|_| Error(format!("bad seek time: {time}")))?;
                self.set(json!({ "position": time }))
            }
            _ => Err(Error(format!("{name} is not supported on Android"))),
        }
    }
}

/// mpv takes booleans as `yes`/`no` text too.
fn flag(value: &Value) -> Result<bool, Error> {
    match value {
        Value::Bool(b) => Ok(*b),
        Value::String(s) if s == "yes" => Ok(true),
        Value::String(s) if s == "no" => Ok(false),
        _ => Err(Error(format!("not a yes/no value: {value}"))),
    }
}

/// mpv takes numbers as text too (settings send them that way).
fn number(value: &Value) -> Result<f64, Error> {
    match value {
        Value::Number(n) => n.as_f64().ok_or_else(|| Error(format!("not a number: {n}"))),
        Value::String(s) => s.parse().map_err(|_| Error(format!("not a number: {s}"))),
        _ => Err(Error(format!("not a number: {value}"))),
    }
}

pub fn create_mpv() -> Result<&'static Mpv> {
    Ok(MPV.get_or_init(|| Mpv {
        state: Mutex::new(Remote::default()),
        start: Mutex::new(None),
        brightness: Mutex::new(0),
    }))
}

pub fn load(mpv: &Mpv, path: &str) -> Result<()> {
    mpv.command("loadfile", &[path, "replace"]).map_err(|e| anyhow!("loading {path}: {}", e.0))
}

/// The video surface is set up by `PlayerPlugin.load`; see `plugin`.
pub fn attach_video(_window: &WebviewWindow, _mpv: &'static Mpv) -> Result<()> {
    Ok(())
}

/// Registers `PlayerPlugin.kt` and starts keeping the local state current.
pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new("player")
        .setup(|_app, api| {
            let handle = api.register_android_plugin("app.beyt.player", "PlayerPlugin")?;
            let _ = PLUGIN.set(handle);
            std::thread::spawn(poll_state);
            Ok(())
        })
        .build()
}

/// Runs one of the plugin's other commands (`storageAccess`, `requestStorageAccess`, `moveToBack`).
pub fn run<T: DeserializeOwned>(command: &str) -> Result<T> {
    create_mpv()?.call(command, json!({})).map_err(|e| anyhow!("{}", e.0))
}

fn poll_state() {
    let Ok(mpv) = create_mpv() else { return };
    let mut last_error: Option<String> = None;
    loop {
        match mpv.call::<Remote>("state", json!({})) {
            Ok(remote) => {
                if remote.error.is_some() && remote.error != last_error {
                    eprintln!("beyt: playback failed: {}", remote.error.as_deref().unwrap_or_default());
                }
                last_error = remote.error.clone();
                *mpv.state() = remote;
            }
            Err(e) => eprintln!("beyt: reading the player's state: {}", e.0),
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

// ---------- playback state for the overlay ----------

/// The `playback` event payload; see `player.rs`.
#[derive(Clone, Serialize)]
pub struct Playback {
    pub time: f64,
    pub paused: bool,
    pub speed: f64,
    pub duration: f64,
    pub eof: bool,
}

pub fn playback(mpv: &Mpv) -> Playback {
    let s = mpv.state();
    Playback { time: s.time, paused: s.paused, speed: s.speed, duration: s.duration, eof: s.eof }
}
