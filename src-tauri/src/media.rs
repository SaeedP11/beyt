//! Opening a video: its subtitle tracks (sidecar files and embedded streams),
//! extracting embedded text subtitles, and the folder it lives in.

use std::{
    cmp::Ordering,
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::subs::{self, Cue};

pub const VIDEO_EXTENSIONS: &[&str] =
    &["mkv", "mp4", "m4v", "webm", "avi", "mov", "ts", "m2ts", "wmv", "flv", "ogv"];

/// Embedded subtitle codecs that are text, so ffmpeg can turn them into SRT.
const TEXT_CODECS: &[&str] =
    &["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "microdvd", "subviewer"];

pub fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| VIDEO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

// ---------- tracks ----------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TrackSource {
    File {
        path: String,
    },
    Embedded {
        /// ffmpeg stream index.
        stream: usize,
        /// mpv's subtitle track id, for image subtitles mpv draws itself.
        sid: i64,
        codec: String,
        forced: bool,
        default: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackStatus {
    Ready,
    /// Embedded text track still being extracted.
    Loading,
    /// Picture-based (PGS, VobSub): can only be drawn by mpv, one at a time.
    Image,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: usize,
    /// Stable across the episodes of a series, so settings carry over:
    /// language, source kind and position among tracks like it ("fa:file:0").
    pub key: String,
    /// Two-letter code when known, else the raw tag, else "und".
    pub lang: String,
    /// File name or embedded track title, to tell similar tracks apart.
    pub detail: String,
    pub rtl: bool,
    pub source: TrackSource,
    pub status: TrackStatus,
    pub error: Option<String>,
    /// Shown when the series has no saved choice.
    pub default_enabled: bool,
    pub cues: Vec<Cue>,
}

impl Track {
    fn kind(&self) -> &'static str {
        match self.source {
            TrackSource::File { .. } => "file",
            TrackSource::Embedded { .. } => "embedded",
        }
    }
}

/// A subtitle file as a track. Failures become a `Failed` track so the user
/// sees why it is missing.
pub fn file_track(path: &Path, video_stem: Option<&str>) -> Track {
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let tagged = subs::lang_from_file_name(&name, video_stem);
    let mut track = Track {
        id: 0,
        key: String::new(),
        lang: tagged.unwrap_or("und").to_string(),
        detail: name,
        rtl: tagged.is_some_and(subs::is_rtl_lang),
        source: TrackSource::File { path: path.to_string_lossy().into_owned() },
        status: TrackStatus::Ready,
        error: None,
        default_enabled: false,
        cues: Vec::new(),
    };
    match subs::load_file(path) {
        Ok(loaded) => {
            track.rtl = loaded.rtl;
            track.cues = loaded.cues;
            if tagged.is_none() {
                // Untagged file: guess from the script.
                track.lang = if loaded.rtl { "fa" } else { "en" }.to_string();
            }
        }
        Err(err) => {
            track.status = TrackStatus::Failed;
            track.error = Some(format!("{err:#}"));
        }
    }
    track
}

#[derive(Deserialize)]
struct Probe {
    #[serde(default)]
    streams: Vec<ProbeStream>,
}

#[derive(Deserialize)]
struct ProbeStream {
    index: usize,
    codec_name: Option<String>,
    #[serde(default)]
    tags: HashMap<String, String>,
    #[serde(default)]
    disposition: HashMap<String, i64>,
}

impl ProbeStream {
    fn tag(&self, name: &str) -> Option<&str> {
        self.tags
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    fn flag(&self, name: &str) -> bool {
        self.disposition.get(name).copied().unwrap_or(0) != 0
    }
}

/// Subtitle streams inside the video, without their text (see `extract_embedded`).
pub fn embedded_tracks(video: &Path) -> Result<Vec<Track>> {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-select_streams", "s"])
        .args(["-show_entries", "stream=index,codec_name:stream_tags:stream_disposition"])
        .args(["-of", "json"])
        .arg(video)
        .output()
        .context("running ffprobe (is ffmpeg installed?)")?;
    if !out.status.success() {
        bail!("ffprobe failed: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    let probe: Probe = serde_json::from_slice(&out.stdout).context("reading ffprobe output")?;

    Ok(probe
        .streams
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let codec = s.codec_name.clone().unwrap_or_else(|| "unknown".into());
            let raw_lang = s.tag("language").unwrap_or("und");
            let lang = subs::normalize_lang(raw_lang)
                .map_or_else(|| raw_lang.to_ascii_lowercase(), str::to_string);
            let is_text = TEXT_CODECS.contains(&codec.as_str());
            Track {
                id: 0,
                key: String::new(),
                rtl: subs::is_rtl_lang(&lang),
                lang,
                detail: s.tag("title").unwrap_or_default().to_string(),
                source: TrackSource::Embedded {
                    stream: s.index,
                    sid: i as i64 + 1,
                    codec,
                    forced: s.flag("forced"),
                    default: s.flag("default"),
                },
                status: if is_text { TrackStatus::Loading } else { TrackStatus::Image },
                error: None,
                default_enabled: false,
                cues: Vec::new(),
            }
        })
        .collect())
}

/// All subtitle tracks for a video: sidecar files first, then embedded ones.
/// Ids and keys are assigned, and a Persian and an English track are picked
/// to show by default.
pub fn tracks_for(video: &Path) -> Vec<Track> {
    let stem = video.file_stem().and_then(|s| s.to_str());
    let mut tracks: Vec<Track> =
        subs::find_sidecars(video).iter().map(|p| file_track(p, stem)).collect();
    match embedded_tracks(video) {
        Ok(embedded) => tracks.extend(embedded),
        Err(err) => eprintln!("beyt: no embedded subtitles for {}: {err:#}", video.display()),
    }
    number_tracks(&mut tracks, 0);
    pick_defaults(&mut tracks);
    tracks
}

/// Gives tracks from `first` on their ids and keys, counting keys across all tracks.
pub fn number_tracks(tracks: &mut [Track], first: usize) {
    let mut seen: HashMap<String, usize> = HashMap::new();
    for (i, track) in tracks.iter_mut().enumerate() {
        let base = format!("{}:{}", track.lang, track.kind());
        let n = seen.entry(base.clone()).or_default();
        if i >= first {
            track.id = i;
            track.key = format!("{base}:{n}");
        }
        *n += 1;
    }
}

/// One Persian and one English text track, preferring full (not forced) and
/// default-flagged ones. With neither language present, the first text track.
fn pick_defaults(tracks: &mut [Track]) {
    let score = |t: &Track| -> Option<i32> {
        if !matches!(t.status, TrackStatus::Ready | TrackStatus::Loading) {
            return None;
        }
        Some(match &t.source {
            TrackSource::File { .. } => 3,
            TrackSource::Embedded { forced: true, .. } => 0,
            TrackSource::Embedded { default: true, .. } => 2,
            TrackSource::Embedded { .. } => 1,
        })
    };
    let mut picked = false;
    for lang in ["fa", "en"] {
        let best = tracks
            .iter()
            .enumerate()
            .filter(|(_, t)| t.lang == lang)
            .filter_map(|(i, t)| score(t).map(|s| (s, i)))
            .max_by_key(|&(s, i)| (s, std::cmp::Reverse(i)));
        if let Some((_, i)) = best {
            tracks[i].default_enabled = true;
            picked = true;
        }
    }
    if !picked
        && let Some(t) = tracks.iter_mut().find(|t| score(t).is_some()) {
            t.default_enabled = true;
        }
}

// ---------- embedded extraction ----------

/// Cache folder for one video's extracted subtitles, keyed by path, size and mtime.
fn cache_dir(cache_root: &Path, video: &Path) -> PathBuf {
    let meta = fs::metadata(video).ok();
    let size = meta.as_ref().map_or(0, |m| m.len());
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    // FNV-1a: stable across runs and Rust versions, unlike std's hasher.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in video.to_string_lossy().bytes().chain(size.to_le_bytes()).chain(mtime.to_le_bytes())
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    cache_root.join(format!("{hash:016x}"))
}

/// Turns embedded text tracks into SRT files (one ffmpeg pass for all of
/// them, reused from the cache next time) and loads their cues.
pub fn extract_embedded(video: &Path, streams: &[usize], cache_root: &Path) -> Result<HashMap<usize, Result<subs::Loaded>>> {
    let dir = cache_dir(cache_root, video);
    fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    let out_path = |s: usize| dir.join(format!("stream-{s}.srt"));

    let missing: Vec<usize> = streams.iter().copied().filter(|&s| !out_path(s).exists()).collect();
    if !missing.is_empty() {
        let mut cmd = Command::new("ffmpeg");
        cmd.args(["-v", "error", "-nostdin", "-y", "-i"]).arg(video);
        for &s in &missing {
            // Written to .part and renamed after, so an interrupted run is not cached.
            cmd.args(["-map", &format!("0:{s}"), "-c:s", "srt", "-f", "srt"])
                .arg(dir.join(format!("stream-{s}.part")));
        }
        let out = cmd.output().context("running ffmpeg")?;
        if !out.status.success() {
            bail!("ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        for &s in &missing {
            let _ = fs::rename(dir.join(format!("stream-{s}.part")), out_path(s));
        }
    }

    Ok(streams.iter().map(|&s| (s, subs::load_file(&out_path(s)))).collect())
}

// ---------- folders ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FolderEntry>,
}

/// Subfolders and videos in `dir`, folders first, both in natural order.
pub fn list_folder(dir: &Path) -> Result<Folder> {
    let mut entries: Vec<FolderEntry> = fs::read_dir(dir)
        .with_context(|| format!("reading {}", dir.display()))?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                return None;
            }
            let is_dir = path.is_dir();
            (is_dir || is_video_file(&path)).then(|| FolderEntry {
                path: path.to_string_lossy().into_owned(),
                name,
                is_dir,
            })
        })
        .collect();
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| natural_cmp(&a.name, &b.name)));
    Ok(Folder {
        path: dir.to_string_lossy().into_owned(),
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
        entries,
    })
}

/// The video after `video` in its folder, in natural order (the next episode).
pub fn next_video(video: &Path) -> Option<PathBuf> {
    let folder = list_folder(video.parent()?).ok()?;
    let name = video.file_name()?.to_string_lossy();
    folder
        .entries
        .into_iter()
        .filter(|e| !e.is_dir)
        .find(|e| natural_cmp(&e.name, &name) == Ordering::Greater)
        .map(|e| PathBuf::from(e.path))
}

/// Compares names with digit runs as numbers: "Episode 2" < "Episode 10".
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut s = String::new();
                    while let Some(c) = it.next_if(char::is_ascii_digit) {
                        s.push(c);
                    }
                    s
                };
                let (na, nb) = (take(&mut a), take(&mut b));
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                let ord = x.to_lowercase().cmp(y.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                a.next();
                b.next();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(lang: &str, source: TrackSource, status: TrackStatus) -> Track {
        Track {
            id: 0,
            key: String::new(),
            lang: lang.into(),
            detail: String::new(),
            rtl: false,
            source,
            status,
            error: None,
            default_enabled: false,
            cues: Vec::new(),
        }
    }

    fn embedded(forced: bool, default: bool) -> TrackSource {
        TrackSource::Embedded { stream: 2, sid: 1, codec: "subrip".into(), forced, default }
    }

    #[test]
    fn natural_order() {
        let mut names = vec!["Ep 10.mkv", "ep 2.mkv", "Ep 1.mkv", "Ep 02b.mkv"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, ["Ep 1.mkv", "ep 2.mkv", "Ep 02b.mkv", "Ep 10.mkv"]);
    }

    #[test]
    fn keys_count_per_language_and_kind() {
        let mut tracks = vec![
            track("en", embedded(false, false), TrackStatus::Loading),
            track("en", embedded(true, false), TrackStatus::Loading),
            track("fa", TrackSource::File { path: "a".into() }, TrackStatus::Ready),
        ];
        number_tracks(&mut tracks, 0);
        let keys: Vec<_> = tracks.iter().map(|t| t.key.as_str()).collect();
        assert_eq!(keys, ["en:embedded:0", "en:embedded:1", "fa:file:0"]);
        assert_eq!(tracks[2].id, 2);
    }

    #[test]
    fn defaults_prefer_full_tracks_in_each_language() {
        let mut tracks = vec![
            track("en", embedded(true, true), TrackStatus::Loading),
            track("en", embedded(false, false), TrackStatus::Loading),
            track("fa", embedded(false, false), TrackStatus::Image),
            track("fa", TrackSource::File { path: "a".into() }, TrackStatus::Ready),
            track("ja", embedded(false, true), TrackStatus::Loading),
        ];
        pick_defaults(&mut tracks);
        let on: Vec<bool> = tracks.iter().map(|t| t.default_enabled).collect();
        assert_eq!(on, [false, true, false, true, false]);
    }

    #[test]
    fn defaults_fall_back_to_first_text_track() {
        let mut tracks = vec![
            track("ja", embedded(false, false), TrackStatus::Image),
            track("ja", embedded(false, false), TrackStatus::Loading),
        ];
        pick_defaults(&mut tracks);
        assert!(!tracks[0].default_enabled && tracks[1].default_enabled);
    }
}
