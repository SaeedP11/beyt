//! Android stand-in for `player.rs`.
//!
//! The desktop player draws mpv into a GTK widget, which Android doesn't
//! have. Until Android gets its own video surface, this offers the same calls
//! so the rest of Beyt (library, subtitles, dictionary, vocabulary) builds
//! and runs, and opening a video says playback isn't available yet.

use anyhow::{Result, bail};
use serde::Serialize;
use tauri::WebviewWindow;

/// Why an mpv call did nothing.
#[derive(Debug)]
pub struct Unsupported;

/// Mirrors the parts of `libmpv2::Mpv` that Beyt calls.
pub struct Mpv;

impl Mpv {
    pub fn set_property<T>(&self, _name: &str, _value: T) -> Result<(), Unsupported> {
        Err(Unsupported)
    }

    pub fn get_property<T>(&self, _name: &str) -> Result<T, Unsupported> {
        Err(Unsupported)
    }

    pub fn command(&self, _name: &str, _args: &[&str]) -> Result<(), Unsupported> {
        Err(Unsupported)
    }
}

pub fn create_mpv() -> Result<&'static Mpv> {
    static MPV: Mpv = Mpv;
    Ok(&MPV)
}

pub fn load(_mpv: &Mpv, _path: &str) -> Result<()> {
    bail!("Video playback is not available on Android yet.")
}

pub fn attach_video(_window: &WebviewWindow, _mpv: &'static Mpv) -> Result<()> {
    Ok(())
}

/// The `playback` event payload; see `player.rs`.
#[derive(Clone, Serialize)]
pub struct Playback {
    pub time: f64,
    pub paused: bool,
    pub speed: f64,
    pub duration: f64,
    pub eof: bool,
}

pub fn playback(_mpv: &Mpv) -> Playback {
    Playback { time: 0.0, paused: true, speed: 1.0, duration: 0.0, eof: false }
}
