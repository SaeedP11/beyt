//! Managing videos from the library: thumbnails, renaming, moving to the
//! Trash and showing a file in the file manager.

use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
#[cfg(target_os = "linux")]
use gtk::gio::{self, prelude::*};

use crate::subs;

/// Returned when a rename would overwrite a file; the page shows its own text.
pub const NAME_TAKEN: &str = "name-taken";

/// Width of a thumbnail in pixels: sharp on the largest library card at 2×.
const THUMB_WIDTH: u32 = 480;

/// Subtitle files that belong to `video`: same name, then a dot
/// (`Movie.srt`, `Movie.fa.srt`). Stricter than the player's own lookup, so
/// renaming `Ep1` leaves `Ep10.srt` alone.
pub fn sidecars(video: &Path) -> Vec<PathBuf> {
    let Some(stem) = video.file_stem().and_then(|s| s.to_str()) else { return Vec::new() };
    subs::find_sidecars(video)
        .into_iter()
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            name.strip_prefix(stem).is_some_and(|rest| rest.starts_with('.'))
        })
        .collect()
}

/// A JPEG of one frame of `video`, cached by file, size, change time and the
/// moment shown. `at` is in seconds; without one (or past the end) the frame
/// comes from 15% in, past most opening titles.
pub fn thumbnail(video: &Path, at: Option<f64>, cache_root: &Path) -> Result<PathBuf> {
    let meta = fs::metadata(video).with_context(|| format!("reading {}", video.display()))?;
    let modified = meta.modified().ok().and_then(|m| m.duration_since(UNIX_EPOCH).ok()).unwrap_or(Duration::ZERO);

    let at = match at {
        Some(t) if t > 0.0 => t,
        _ => duration(video).map_or(60.0, |d| d * 0.15),
    };
    // Five-second steps, so resuming a little later doesn't make a new image.
    let step = (at / 5.0).floor() as u64;

    let mut hasher = DefaultHasher::new();
    (video, meta.len(), modified.as_secs(), step).hash(&mut hasher);
    let out = cache_root.join(format!("{:016x}.jpg", hasher.finish()));
    if out.is_file() {
        return Ok(out);
    }
    fs::create_dir_all(cache_root).with_context(|| format!("creating {}", cache_root.display()))?;

    // Seeking past the end gives no frame; then take the first one.
    for seek in [at, 0.0] {
        // Written under another name first, so a half-written file is never served.
        let partial = out.with_extension("part.jpg");
        let output = Command::new("ffmpeg")
            .args(["-v", "error", "-nostdin", "-y", "-ss", &format!("{seek:.1}"), "-i"])
            .arg(video)
            .args(["-an", "-sn", "-frames:v", "1", "-vf", &format!("scale={THUMB_WIDTH}:-2"), "-q:v", "5"])
            .arg(&partial)
            .output()
            .context("running ffmpeg (is ffmpeg installed?)")?;
        if output.status.success() && partial.is_file() {
            fs::rename(&partial, &out)?;
            return Ok(out);
        }
        let _ = fs::remove_file(&partial);
    }
    bail!("no frame could be read from {}", video.display())
}

/// Length of `video` in seconds, from its header.
fn duration(video: &Path) -> Option<f64> {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
        .arg(video)
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok().filter(|d: &f64| *d > 0.0)
}

/// Old and new paths of each file a rename moved, the video first.
pub type Moves = Vec<(PathBuf, PathBuf)>;

/// Renames `video` to `new_stem` plus its extension, and its subtitle files
/// to match. Nothing moves if any new name is taken.
pub fn rename(video: &Path, new_stem: &str) -> Result<Moves> {
    let new_stem = new_stem.trim();
    if new_stem.is_empty() || new_stem == "." || new_stem == ".." || new_stem.contains(['/', '\0']) {
        bail!("not a valid file name: {new_stem:?}");
    }
    let dir = video.parent().context("the video has no folder")?;
    let old_stem = video.file_stem().and_then(|s| s.to_str()).context("the file name isn't valid text")?;
    let ext = video.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();

    let mut moves = vec![(video.to_path_buf(), dir.join(format!("{new_stem}{ext}")))];
    for sub in sidecars(video) {
        let name = sub.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        let rest = &name[old_stem.len()..];
        moves.push((sub.clone(), dir.join(format!("{new_stem}{rest}"))));
    }
    if moves[0].0 == moves[0].1 {
        return Ok(Vec::new());
    }
    if moves.iter().any(|(_, to)| to.exists()) {
        bail!(NAME_TAKEN);
    }

    fs::rename(&moves[0].0, &moves[0].1).with_context(|| format!("renaming {}", video.display()))?;
    // The video has its new name now; a subtitle that can't follow is only
    // logged, as it can still be added by hand.
    moves.retain(|(from, to)| {
        from == video
            || fs::rename(from, to).inspect_err(|e| eprintln!("beyt: renaming {}: {e}", from.display())).is_ok()
    });
    Ok(moves)
}

/// Moves each file to the desktop's Trash, where it can be restored from.
#[cfg(target_os = "linux")]
pub fn trash(paths: &[PathBuf]) -> Result<()> {
    for path in paths {
        gio::File::for_path(path)
            .trash(gio::Cancellable::NONE)
            .with_context(|| format!("moving {} to the Trash", path.display()))?;
    }
    Ok(())
}

/// Opens the file manager with `path` selected, or at least its folder.
#[cfg(target_os = "linux")]
pub fn show_in_folder(path: &Path) -> Result<()> {
    let uri = gio::File::for_path(path).uri().to_string();
    let via_file_manager = || -> Result<(), dbus::Error> {
        let conn = dbus::blocking::Connection::new_session()?;
        let fm = conn.with_proxy("org.freedesktop.FileManager1", "/org/freedesktop/FileManager1", Duration::from_secs(3));
        fm.method_call("org.freedesktop.FileManager1", "ShowItems", (vec![uri.as_str()], ""))
    };
    if let Err(e) = via_file_manager() {
        eprintln!("beyt: no file manager to select the file ({e}); opening its folder");
        let dir = path.parent().context("the file has no folder")?;
        gio::AppInfo::launch_default_for_uri(&gio::File::for_path(dir).uri(), gio::AppLaunchContext::NONE)
            .context("opening the folder")?;
    }
    Ok(())
}

// Android keeps no Trash for plain files, and its file managers take no
// "select this file" request.

#[cfg(not(target_os = "linux"))]
pub fn trash(_paths: &[PathBuf]) -> Result<()> {
    bail!("Moving to the Trash is not available on this system.")
}

#[cfg(not(target_os = "linux"))]
pub fn show_in_folder(_path: &Path) -> Result<()> {
    bail!("Showing files in a folder is not available on this system.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("beyt-library-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, b"x").unwrap();
        p
    }

    #[test]
    fn sidecars_need_a_dot_after_the_name() {
        let dir = temp_dir("sidecars");
        let video = touch(&dir, "Ep1.mkv");
        touch(&dir, "Ep1.srt");
        touch(&dir, "Ep1.fa.srt");
        touch(&dir, "Ep10.srt");
        let names: Vec<_> = sidecars(&video).iter().map(|p| p.file_name().unwrap().to_owned()).collect();
        assert_eq!(names, ["Ep1.fa.srt", "Ep1.srt"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rename_moves_subtitles_and_refuses_to_overwrite() {
        let dir = temp_dir("rename");
        let video = touch(&dir, "Ep1.mkv");
        touch(&dir, "Ep1.en.srt");
        touch(&dir, "Taken.mkv");

        assert_eq!(rename(&video, "Taken").unwrap_err().to_string(), NAME_TAKEN);
        assert!(rename(&video, "a/b").is_err());
        assert!(video.exists());

        let moves = rename(&video, " Pilot ").unwrap();
        assert_eq!(moves.len(), 2);
        assert!(dir.join("Pilot.mkv").exists() && dir.join("Pilot.en.srt").exists());
        assert!(!video.exists());
        assert!(rename(&dir.join("Pilot.mkv"), "Pilot").unwrap().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
}
