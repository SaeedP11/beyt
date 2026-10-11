//! Subtitle loading: finding sidecar files, decoding legacy encodings,
//! parsing SRT / WebVTT into cues, and fixing common Persian text problems.

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Cue {
    /// Seconds from the start of the video.
    pub start: f64,
    pub end: f64,
    /// Lines separated by `\n`, with markup removed.
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Track {
    pub id: usize,
    pub label: String,
    pub lang: String,
    pub rtl: bool,
    pub cues: Vec<Cue>,
}

const SUB_EXTENSIONS: &[&str] = &["srt", "vtt"];

/// Subtitle files next to `video` whose names start with the video's name,
/// e.g. `Movie.fa.srt` and `Movie.en.srt` for `Movie.mkv`.
pub fn find_sidecars(video: &Path) -> Vec<PathBuf> {
    let (Some(dir), Some(stem)) = (video.parent(), video.file_stem().and_then(|s| s.to_str()))
    else {
        return Vec::new();
    };
    let dir = if dir.as_os_str().is_empty() { Path::new(".") } else { dir };
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or_default();
            name.starts_with(stem) && SUB_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
        })
        .collect();
    found.sort();
    found
}

/// Loads every file as a track. Files that fail to load are reported and skipped.
pub fn load_tracks(files: &[PathBuf]) -> Vec<Track> {
    files
        .iter()
        .filter_map(|path| match load_track(path) {
            Ok(track) => Some(track),
            Err(err) => {
                eprintln!("beyt: skipping {}: {err:#}", path.display());
                None
            }
        })
        .enumerate()
        .map(|(id, track)| Track { id, ..track })
        .collect()
}

fn load_track(path: &Path) -> Result<Track> {
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let text = decode(&bytes);
    let mut cues = parse(&text);
    anyhow::ensure!(!cues.is_empty(), "no subtitle lines found");

    let rtl = is_mostly_rtl(cues.iter().map(|c| c.text.as_str()));
    if rtl {
        for cue in &mut cues {
            cue.text = fix_persian(&cue.text);
        }
    }

    let file_name = path.file_name().unwrap_or_default().to_string_lossy();
    let lang = lang_from_file_name(&file_name)
        .unwrap_or(if rtl { "fa" } else { "en" })
        .to_string();
    let label = format!("{} ({file_name})", language_name(&lang));
    Ok(Track { id: 0, label, lang, rtl, cues })
}

/// Decodes subtitle bytes to text: UTF-8/UTF-16 with a BOM, plain UTF-8,
/// or a detected legacy encoding such as Windows-1256 for Persian.
pub fn decode(bytes: &[u8]) -> String {
    if let Some((encoding, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, _) = encoding.decode_without_bom_handling(&bytes[bom_len..]);
        return text.into_owned();
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_owned();
    }
    let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    detector.feed(bytes, true);
    // Valid UTF-8 was handled above, so the guess only has to pick a legacy encoding.
    let encoding = detector.guess(None, chardetng::Utf8Detection::Deny);
    let (text, _) = encoding.decode_without_bom_handling(bytes);
    text.into_owned()
}

/// Parses SRT or WebVTT text. Cues come back sorted by start time.
pub fn parse(text: &str) -> Vec<Cue> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut cues = Vec::new();
    for block in text.split("\n\n") {
        let mut lines = block.lines().map(str::trim).skip_while(|l| !l.contains("-->"));
        let Some(timing) = lines.next() else { continue };
        let Some((start, end)) = parse_timing(timing) else { continue };
        let body: Vec<String> = lines.map(strip_markup).filter(|l| !l.is_empty()).collect();
        if body.is_empty() || end <= start {
            continue;
        }
        cues.push(Cue { start, end, text: body.join("\n") });
    }
    cues.sort_by(|a, b| a.start.total_cmp(&b.start));
    cues
}

/// `00:01:02,500 --> 00:01:04,000` (WebVTT may add settings after the end time).
fn parse_timing(line: &str) -> Option<(f64, f64)> {
    let (start, rest) = line.split_once("-->")?;
    let end = rest.split_whitespace().next()?;
    Some((parse_time(start.trim())?, parse_time(end)?))
}

/// `HH:MM:SS,mmm`, `HH:MM:SS.mmm` or `MM:SS.mmm`.
fn parse_time(s: &str) -> Option<f64> {
    let s = s.replace(',', ".");
    let parts: Vec<&str> = s.split(':').collect();
    let (h, m, sec) = match parts.as_slice() {
        [h, m, sec] => (h.parse::<f64>().ok()?, m.parse::<f64>().ok()?, sec.parse::<f64>().ok()?),
        [m, sec] => (0.0, m.parse::<f64>().ok()?, sec.parse::<f64>().ok()?),
        _ => return None,
    };
    Some(h * 3600.0 + m * 60.0 + sec)
}

/// Removes HTML-style tags (`<i>`, `<font …>`) and ASS override blocks (`{\an8}`).
fn strip_markup(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut depth_angle = false;
    let mut depth_brace = false;
    for ch in line.chars() {
        match ch {
            '<' if !depth_brace => depth_angle = true,
            '>' if depth_angle => depth_angle = false,
            '{' if !depth_angle => depth_brace = true,
            '}' if depth_brace => depth_brace = false,
            _ if !depth_angle && !depth_brace => out.push(ch),
            _ => {}
        }
    }
    out.trim().to_string()
}

fn is_arabic_script(ch: char) -> bool {
    matches!(ch, '\u{0600}'..='\u{06FF}' | '\u{0750}'..='\u{077F}' | '\u{FB50}'..='\u{FDFF}' | '\u{FE70}'..='\u{FEFF}')
}

fn is_mostly_rtl<'a>(texts: impl Iterator<Item = &'a str>) -> bool {
    let (mut rtl, mut ltr) = (0usize, 0usize);
    for ch in texts.flat_map(str::chars) {
        if is_arabic_script(ch) {
            rtl += 1;
        } else if ch.is_alphabetic() {
            ltr += 1;
        }
    }
    rtl > ltr
}

/// Punctuation that RTL-unaware editors often leave at the wrong end of a line.
const FLIPPABLE: &[char] = &['.', '!', '?', '؟', '،', '؛', ':', '…'];

/// Normalises Persian text: Arabic letter forms to Persian ones, and
/// punctuation that was typed at the start of a line moved back to its end.
pub fn fix_persian(text: &str) -> String {
    text.lines()
        .map(|line| {
            let line: String = line
                .chars()
                .map(|ch| match ch {
                    'ي' | 'ى' => 'ی',
                    'ك' => 'ک',
                    _ => ch,
                })
                .collect();
            let lead: String = line.chars().take_while(|c| FLIPPABLE.contains(c)).collect();
            let rest = &line[lead.len()..];
            if !lead.is_empty() && rest.chars().next().is_some_and(is_arabic_script) {
                format!("{rest}{lead}")
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Language code from a name like `Movie.fa.srt` or `Movie.English.srt`.
fn lang_from_file_name(name: &str) -> Option<&'static str> {
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    stem.rsplit(['.', '_', '-', ' ']).find_map(|tag| {
        Some(match tag.to_ascii_lowercase().as_str() {
            "fa" | "fas" | "per" | "persian" | "farsi" => "fa",
            "en" | "eng" | "english" => "en",
            _ => return None,
        })
    })
}

fn language_name(code: &str) -> &str {
    match code {
        "fa" => "Persian",
        "en" => "English",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_srt() {
        let srt = "1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i>\r\nthere\r\n\r\n2\r\n00:01:00,000 --> 00:01:01,000\r\n{\\an8}Top\r\n";
        let cues = parse(srt);
        assert_eq!(
            cues,
            vec![
                Cue { start: 1.0, end: 2.5, text: "Hello\nthere".into() },
                Cue { start: 60.0, end: 61.0, text: "Top".into() },
            ]
        );
    }

    #[test]
    fn parses_webvtt() {
        let vtt = "WEBVTT\n\n00:05.000 --> 00:06.250 align:start\nShort form\n";
        assert_eq!(parse(vtt), vec![Cue { start: 5.0, end: 6.25, text: "Short form".into() }]);
    }

    #[test]
    fn decodes_windows_1256() {
        // Windows-1256 has no Persian ی, so real files use the Arabic ي instead.
        let text = "سلام، حال شما چطور است؟ اميدوارم خوب باشيد";
        let (bytes, _, unmappable) = encoding_rs::WINDOWS_1256.encode(text);
        assert!(!unmappable);
        assert_eq!(decode(&bytes), text);
        assert_eq!(fix_persian(&decode(&bytes)), "سلام، حال شما چطور است؟ امیدوارم خوب باشید");
    }

    #[test]
    fn decodes_utf8_bom() {
        assert_eq!(decode(b"\xEF\xBB\xBFhi"), "hi");
    }

    #[test]
    fn fixes_persian_letters_and_punctuation() {
        assert_eq!(fix_persian("?كجا مي‌روي"), "کجا می‌روی?");
        assert_eq!(fix_persian("سلام."), "سلام.");
        assert_eq!(fix_persian("...hello"), "...hello");
    }

    #[test]
    fn detects_language_from_file_name() {
        assert_eq!(lang_from_file_name("Movie.fa.srt"), Some("fa"));
        assert_eq!(lang_from_file_name("Movie.2019.English.srt"), Some("en"));
        assert_eq!(lang_from_file_name("Movie_per.srt"), Some("fa"));
        assert_eq!(lang_from_file_name("Movie.srt"), None);
    }
}
