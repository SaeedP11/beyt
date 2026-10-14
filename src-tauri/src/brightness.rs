//! Screen brightness: the display's backlight where Linux can reach one
//! (laptops), else mpv's picture brightness (external monitors have none).

use std::fs;
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::time::Duration;

use anyhow::{Context, Result};
use crate::player::Mpv;
use serde::Serialize;

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Backlight,
    Video,
}

/// A brightness level in percent and what it controls.
#[derive(Serialize)]
pub struct Brightness {
    pub level: f64,
    pub source: Source,
}

/// Lowest backlight level: some panels switch off at 0.
const BACKLIGHT_MIN: f64 = 5.0;
/// Picture levels map one to one onto mpv's `brightness` (100 is the video
/// as it is). Below 50 shadows turn black, above 115 blacks turn grey.
const VIDEO_MIN: f64 = 50.0;
const VIDEO_MAX: f64 = 115.0;

struct Backlight {
    name: String,
    dir: PathBuf,
    max: u32,
}

/// The preferred backlight, as the kernel docs advise: firmware, then
/// platform, then raw (raw values may not match what the eye sees).
fn backlight() -> Option<Backlight> {
    let rank = |kind: &str| match kind {
        "firmware" => 0,
        "platform" => 1,
        _ => 2,
    };
    let mut found: Vec<(u8, Backlight)> = fs::read_dir("/sys/class/backlight")
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let dir = entry.path();
            let max = read_u32(&dir.join("max_brightness")).filter(|&m| m > 0)?;
            let kind = fs::read_to_string(dir.join("type")).unwrap_or_default();
            let name = entry.file_name().to_string_lossy().into_owned();
            Some((rank(kind.trim()), Backlight { name, dir, max }))
        })
        .collect();
    found.sort_by_key(|(r, b)| (*r, b.name.clone()));
    found.into_iter().next().map(|(_, b)| b)
}

fn read_u32(path: &std::path::Path) -> Option<u32> {
    fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// Asks logind to set the backlight, which needs no root for the active
/// session; falls back to writing sysfs (works if a udev rule allows it).
#[cfg(target_os = "linux")]
fn set_backlight(b: &Backlight, value: u32) -> Result<()> {
    let via_logind = || -> Result<(), dbus::Error> {
        let conn = dbus::blocking::Connection::new_system()?;
        let session = conn.with_proxy(
            "org.freedesktop.login1",
            "/org/freedesktop/login1/session/auto",
            Duration::from_secs(2),
        );
        session.method_call("org.freedesktop.login1.Session", "SetBrightness", ("backlight", b.name.as_str(), value))
    };
    match via_logind() {
        Ok(()) => Ok(()),
        Err(logind) => fs::write(b.dir.join("brightness"), value.to_string())
            .with_context(|| format!("could not set the brightness ({})", logind.message().unwrap_or("logind"))),
    }
}

/// Android has no logind; sysfs is all there is (usually closed to apps).
#[cfg(not(target_os = "linux"))]
fn set_backlight(b: &Backlight, value: u32) -> Result<()> {
    fs::write(b.dir.join("brightness"), value.to_string()).context("could not set the brightness")
}

pub fn get(mpv: &Mpv) -> Result<Brightness> {
    if let Some(b) = backlight() {
        let now = read_u32(&b.dir.join("brightness")).context("could not read the brightness")?;
        let level = (f64::from(now) * 100.0 / f64::from(b.max)).round();
        return Ok(Brightness { level, source: Source::Backlight });
    }
    let picture: i64 = mpv.get_property("brightness").map_err(|e| anyhow::anyhow!("{e:?}"))?;
    Ok(Brightness { level: video_level(picture), source: Source::Video })
}

/// Sets the brightness to `level` percent, clamped to what the source allows.
pub fn set(mpv: &Mpv, level: f64) -> Result<Brightness> {
    if let Some(b) = backlight() {
        let level = level.clamp(BACKLIGHT_MIN, 100.0).round();
        let value = ((level * f64::from(b.max) / 100.0).round() as u32).max(1);
        set_backlight(&b, value)?;
        return Ok(Brightness { level, source: Source::Backlight });
    }
    let picture = video_picture(level);
    mpv.set_property("brightness", picture).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    Ok(Brightness { level: video_level(picture), source: Source::Video })
}

/// mpv's `brightness` (-100–100) for a picture level.
fn video_picture(level: f64) -> i64 {
    (level.clamp(VIDEO_MIN, VIDEO_MAX) - 100.0).round() as i64
}

fn video_level(picture: i64) -> f64 {
    (100.0 + picture as f64).clamp(VIDEO_MIN, VIDEO_MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picture_levels_round_trip() {
        for level in (50..=115).step_by(5) {
            let level = f64::from(level);
            assert_eq!(video_level(video_picture(level)), level);
        }
        assert_eq!(video_picture(100.0), 0);
        assert_eq!(video_picture(0.0), -50);
        assert_eq!(video_picture(500.0), 15);
    }
}
