//! What a video file is: its streams, frame rate, release name and
//! OpenSubtitles hash, everything needed to find subtitles that fit it.

use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};
#[cfg(not(target_os = "android"))]
use std::process::Command;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::subs;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub name: String,
    pub folder: String,
    /// Bytes; subtitle sites ask for it next to the hash.
    pub size: u64,
    /// ffprobe's format names, e.g. "matroska,webm".
    pub container: Option<String>,
    pub duration: Option<f64>,
    /// Bits per second, all streams together.
    pub bitrate: Option<u64>,
    /// The container's own title tag, often the original release name.
    pub title_tag: Option<String>,
    pub release: Release,
    /// OpenSubtitles "moviehash": finds subtitles timed for this exact file.
    pub hash: Option<String>,
    pub video: Vec<VideoStream>,
    pub audio: Vec<AudioStream>,
    pub subtitles: Vec<SubtitleStream>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStream {
    pub codec: String,
    pub profile: Option<String>,
    pub width: u32,
    pub height: u32,
    /// Frames per second; subtitles timed for another rate drift.
    pub fps: Option<f64>,
    pub bit_depth: Option<u32>,
    pub hdr: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStream {
    pub lang: String,
    pub codec: String,
    pub channels: Option<u32>,
    pub sample_rate: Option<u32>,
    pub title: Option<String>,
    pub default: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleStream {
    pub lang: String,
    pub codec: String,
    pub title: Option<String>,
    pub forced: bool,
}

pub fn file_info(video: &Path) -> Result<FileInfo> {
    let size = video.metadata().with_context(|| format!("reading {}", video.display()))?.len();
    let probe = probe(video)?;
    let stem = video.file_stem().unwrap_or_default().to_string_lossy();

    let mut info = FileInfo {
        name: video.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        folder: video.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        size,
        container: probe.format.format_name.clone(),
        duration: probe.format.duration.as_deref().and_then(|d| d.parse().ok()),
        bitrate: probe.format.bit_rate.as_deref().and_then(|b| b.parse().ok()),
        title_tag: tag(&probe.format.tags, "title").filter(|t| !t.trim().is_empty()).map(str::to_string),
        release: release_of(&stem, tag(&probe.format.tags, "title")),
        hash: opensubtitles_hash(video, size).ok(),
        video: Vec::new(),
        audio: Vec::new(),
        subtitles: Vec::new(),
    };

    for s in &probe.streams {
        let codec = s.codec_name.clone().unwrap_or_else(|| "unknown".into());
        let lang = || {
            let raw = tag(&s.tags, "language").unwrap_or("und");
            subs::normalize_lang(raw).map_or_else(|| raw.to_ascii_lowercase(), str::to_string)
        };
        let title = tag(&s.tags, "title").filter(|t| !t.trim().is_empty()).map(str::to_string);
        let flag = |name: &str| s.disposition.get(name).copied().unwrap_or(0) != 0;
        match s.codec_type.as_deref() {
            // Cover art is stored as a one-frame video stream.
            Some("video") if !flag("attached_pic") => info.video.push(VideoStream {
                codec,
                profile: s.profile.clone(),
                width: s.width.unwrap_or(0),
                height: s.height.unwrap_or(0),
                fps: parse_rate(s.avg_frame_rate.as_deref()).or_else(|| parse_rate(s.r_frame_rate.as_deref())),
                bit_depth: s.bits_per_raw_sample.as_deref().and_then(|b| b.parse().ok()).or_else(|| {
                    s.pix_fmt.as_deref().map(|f| if f.contains("10") { 10 } else if f.contains("12") { 12 } else { 8 })
                }),
                hdr: matches!(s.color_transfer.as_deref(), Some("smpte2084" | "arib-std-b67")),
            }),
            Some("audio") => info.audio.push(AudioStream {
                lang: lang(),
                codec,
                channels: s.channels,
                sample_rate: s.sample_rate.as_deref().and_then(|r| r.parse().ok()),
                title,
                default: flag("default"),
            }),
            Some("subtitle") => info.subtitles.push(SubtitleStream { lang: lang(), codec, title, forced: flag("forced") }),
            _ => {}
        }
    }
    Ok(info)
}

// ---------- ffprobe ----------

#[derive(Deserialize)]
struct Probe {
    #[serde(default)]
    format: ProbeFormat,
    #[serde(default)]
    streams: Vec<ProbeStream>,
}

#[derive(Deserialize, Default)]
struct ProbeFormat {
    format_name: Option<String>,
    duration: Option<String>,
    bit_rate: Option<String>,
    #[serde(default)]
    tags: HashMap<String, String>,
}

#[derive(Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    profile: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    pix_fmt: Option<String>,
    bits_per_raw_sample: Option<String>,
    color_transfer: Option<String>,
    channels: Option<u32>,
    sample_rate: Option<String>,
    #[serde(default)]
    tags: HashMap<String, String>,
    #[serde(default)]
    disposition: HashMap<String, i64>,
}

/// Phones have no ffprobe: Media3, which plays the video, describes it in
/// ffprobe's shape instead (`PlayerPlugin.probe`).
#[cfg(target_os = "android")]
fn probe(video: &Path) -> Result<Probe> {
    serde_json::from_value(crate::player::probe(video)?).context("reading the video's details")
}

#[cfg(not(target_os = "android"))]
fn probe(video: &Path) -> Result<Probe> {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-show_format", "-show_streams", "-of", "json"])
        .arg(video)
        .output()
        .context("running ffprobe (is ffmpeg installed?)")?;
    if !out.status.success() {
        bail!("ffprobe failed: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    serde_json::from_slice(&out.stdout).context("reading ffprobe output")
}

fn tag<'a>(tags: &'a HashMap<String, String>, name: &str) -> Option<&'a str> {
    tags.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

/// "24000/1001" → 23.976; "0/0" (unknown) → None.
fn parse_rate(rate: Option<&str>) -> Option<f64> {
    let (num, den) = rate?.split_once('/')?;
    let (num, den): (f64, f64) = (num.parse().ok()?, den.parse().ok()?);
    (num > 0.0 && den > 0.0).then(|| num / den)
}

// ---------- OpenSubtitles hash ----------

const HASH_CHUNK: u64 = 64 * 1024;

/// The file size plus the 64-bit little-endian words of its first and last
/// 64 KiB, wrapping. OpenSubtitles and most players use it to match
/// subtitles to an exact release.
pub fn opensubtitles_hash(path: &Path, size: u64) -> Result<String> {
    if size < HASH_CHUNK {
        bail!("file too small to hash");
    }
    let mut file = File::open(path)?;
    let mut hash = size;
    let mut buf = vec![0u8; HASH_CHUNK as usize];
    for offset in [0, size - HASH_CHUNK] {
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(&mut buf)?;
        for word in buf.as_chunks::<8>().0 {
            hash = hash.wrapping_add(u64::from_le_bytes(*word));
        }
    }
    Ok(format!("{hash:016x}"))
}

// ---------- release name ----------

/// What a scene-style file name says about the release:
/// "The.Office.S02E05.720p.WEB-DL.x264-GROUP".
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub title: Option<String>,
    pub year: Option<u16>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub resolution: Option<String>,
    pub source: Option<String>,
    pub group: Option<String>,
}

const SOURCES: &[(&str, &str)] = &[
    ("web-dl", "WEB-DL"),
    ("webdl", "WEB-DL"),
    ("webrip", "WEBRip"),
    ("web", "WEB"),
    ("bluray", "BluRay"),
    ("blu-ray", "BluRay"),
    ("bdrip", "BDRip"),
    ("brrip", "BRRip"),
    ("bdremux", "Remux"),
    ("remux", "Remux"),
    ("hdtv", "HDTV"),
    ("hdrip", "HDRip"),
    ("dvdrip", "DVDRip"),
    ("dvd", "DVD"),
];

/// The file name's release details, with gaps filled from the container's
/// title tag: re-encoders rename files ("…720p.Ganool") but often keep the
/// original release name there ("s d 2017 720p bluray x264-bipolar").
pub fn release_of(stem: &str, title_tag: Option<&str>) -> Release {
    let mut release = parse_release(stem);
    if let Some(tag) = title_tag {
        let from_tag = parse_release(tag);
        release.year = release.year.or(from_tag.year);
        release.season = release.season.or(from_tag.season);
        release.episode = release.episode.or(from_tag.episode);
        release.resolution = release.resolution.or(from_tag.resolution);
        release.source = release.source.or(from_tag.source);
        release.group = from_tag.group.or(release.group);
    }
    release
}

pub fn parse_release(stem: &str) -> Release {
    let mut rest = stem.trim();
    let mut release = Release::default();

    // "…x264-GROUP" or "…x264-GROUP[rarbg]": the group follows the last dash.
    if let Some(stripped) = rest.strip_suffix(']').and_then(|r| r.rsplit_once('[')).map(|(head, _)| head.trim_end()) {
        rest = stripped;
    }
    if let Some((head, group)) = rest.rsplit_once('-')
        && !group.is_empty()
        && group.len() <= 20
        && group.chars().all(|c| c.is_ascii_alphanumeric())
        && !group.chars().all(|c| c.is_ascii_digit())
        && !SOURCES.iter().any(|(k, _)| k.ends_with(&format!("-{}", group.to_ascii_lowercase())))
        && head.contains(['.', ' ', '_'])
    {
        release.group = Some(group.to_string());
        rest = head;
    }

    let tokens: Vec<&str> =
        rest.split(['.', ' ', '_', '(', ')', '[', ']']).filter(|t| !t.is_empty()).collect();
    // The title runs up to the first tag (episode, resolution, source)...
    let mut title_end = tokens.len();
    for (i, token) in tokens.iter().enumerate() {
        let lower = token.to_ascii_lowercase();
        let mut marker = true;
        if let Some((s, e)) = season_episode(&lower) {
            release.season = release.season.or(Some(s));
            release.episode = release.episode.or(e);
        } else if let Some(res) = resolution(&lower) {
            release.resolution = release.resolution.or(Some(res));
        } else if let Some((_, name)) = SOURCES.iter().find(|(k, _)| *k == lower) {
            release.source = release.source.or(Some((*name).to_string()));
        } else {
            marker = false;
        }
        if marker {
            title_end = title_end.min(i);
        }
    }
    // ...or the last year before it, so years in titles stay ("Blade Runner 2049 2017").
    if let Some(i) = (1..title_end).rev().find(|&i| {
        tokens[i].len() == 4 && tokens[i].parse::<u16>().is_ok_and(|y| (1900..=2100).contains(&y))
    }) {
        release.year = tokens[i].parse().ok();
        title_end = i;
    }
    let title = tokens[..title_end].join(" ");
    release.title = (!title.is_empty()).then_some(title);
    release
}

/// "s02e05", "s02e05e06", "s02" or "2x05" → (season, episode).
fn season_episode(token: &str) -> Option<(u32, Option<u32>)> {
    let digits = |s: &str| (!s.is_empty() && s.len() <= 4 && s.chars().all(|c| c.is_ascii_digit())).then(|| s.parse().ok()).flatten();
    if let Some(rest) = token.strip_prefix('s') {
        let (season, episode) = match rest.split_once('e') {
            Some((s, e)) => (s, Some(e.split('e').next().unwrap_or(e))),
            None => (rest, None),
        };
        let season = digits(season)?;
        return match episode {
            Some(e) => Some((season, Some(digits(e)?))),
            None => Some((season, None)),
        };
    }
    let (s, e) = token.split_once('x')?;
    (s.len() <= 2 && e.len() == 2).then_some(())?;
    Some((digits(s)?, Some(digits(e)?)))
}

fn resolution(token: &str) -> Option<String> {
    match token {
        "4k" | "uhd" => return Some("2160p".into()),
        _ => {}
    }
    let num = token.strip_suffix('p').or_else(|| token.strip_suffix('i'))?;
    (matches!(num.len(), 3 | 4) && num.chars().all(|c| c.is_ascii_digit())).then(|| token.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(stem: &str) -> Release {
        parse_release(stem)
    }

    #[test]
    fn episode_release() {
        assert_eq!(
            release("The.Office.US.S02E05.720p.WEB-DL.x264-GROUP"),
            Release {
                title: Some("The Office US".into()),
                season: Some(2),
                episode: Some(5),
                resolution: Some("720p".into()),
                source: Some("WEB-DL".into()),
                group: Some("GROUP".into()),
                ..Release::default()
            }
        );
    }

    #[test]
    fn movie_release() {
        assert_eq!(
            release("Blade Runner 2049 (2017) 2160p BluRay x265-TERMiNAL[rarbg]"),
            Release {
                title: Some("Blade Runner 2049".into()),
                year: Some(2017),
                resolution: Some("2160p".into()),
                source: Some("BluRay".into()),
                group: Some("TERMiNAL".into()),
                ..Release::default()
            }
        );
        let r = release("Inception.2010.1080p.BluRay.x264");
        assert_eq!((r.title.as_deref(), r.year, r.group), (Some("Inception"), Some(2010), None));
    }

    #[test]
    fn plain_names() {
        assert_eq!(release("Holiday video").title.as_deref(), Some("Holiday video"));
        let r = release("1917");
        assert_eq!((r.title.as_deref(), r.year), (Some("1917"), None));
        let r = release("1917.2019.1080p.WEB");
        assert_eq!((r.title.as_deref(), r.year), (Some("1917"), Some(2019)));
        let r = release("show 3x07");
        assert_eq!((r.title.as_deref(), r.season, r.episode), (Some("show"), Some(3), Some(7)));
    }

    #[test]
    fn title_tag_fills_gaps() {
        let r = release_of("Savage.Dog.2017.720p.Ganool", Some("s d 2017 720p bluray x264-bipolar"));
        assert_eq!(r.title.as_deref(), Some("Savage Dog"));
        assert_eq!((r.source.as_deref(), r.group.as_deref()), (Some("BluRay"), Some("bipolar")));
        assert_eq!(release_of("Show.S01E02", Some("Show")).season, Some(1));
    }

    #[test]
    fn frame_rates() {
        assert!((parse_rate(Some("24000/1001")).unwrap() - 23.976).abs() < 0.001);
        assert_eq!(parse_rate(Some("25/1")), Some(25.0));
        assert_eq!(parse_rate(Some("0/0")), None);
    }

    #[test]
    fn hash_of_zeros_is_the_size() {
        let path = std::env::temp_dir().join(format!("beyt-hash-test-{}", std::process::id()));
        std::fs::write(&path, vec![0u8; 200_000]).unwrap();
        let hash = opensubtitles_hash(&path, 200_000);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(hash.unwrap(), format!("{:016x}", 200_000u64));
    }
}

