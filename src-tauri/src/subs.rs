//! Subtitle text: finding sidecar files, decoding legacy encodings, parsing
//! SRT / WebVTT into cues, and fixing common Persian text problems.

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

const SUB_EXTENSIONS: &[&str] = &["srt", "vtt"];

pub fn is_subtitle_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| SUB_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

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
            name.starts_with(stem) && is_subtitle_file(p)
        })
        .collect();
    found.sort();
    found
}

/// Cues from a subtitle file, with Persian fixes applied when the text is RTL.
pub struct Loaded {
    pub cues: Vec<Cue>,
    pub rtl: bool,
}

pub fn load_file(path: &Path) -> Result<Loaded> {
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let mut cues = parse(&decode(&bytes));
    anyhow::ensure!(!cues.is_empty(), "no subtitle lines found");

    let rtl = is_mostly_rtl(cues.iter().map(|c| c.text.as_str()));
    if rtl {
        for cue in &mut cues {
            cue.text = fix_persian(&cue.text);
        }
    }
    Ok(Loaded { cues, rtl })
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

/// Language code from a subtitle name like `Movie.fa.srt` or `Movie.English.srt`.
///
/// Only the part after the video's own name is searched, so a title word such
/// as "It" in `It.2017.srt` is not taken for Italian. Without a video name,
/// only the last tag is checked.
pub fn lang_from_file_name(name: &str, video_stem: Option<&str>) -> Option<&'static str> {
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    let tags = match video_stem.and_then(|v| stem.strip_prefix(v)) {
        Some(rest) => rest,
        None => stem.rsplit(['.', '_', '-', ' ']).next().unwrap_or_default(),
    };
    tags.rsplit(['.', '_', '-', ' ']).find_map(normalize_lang)
}

/// Two-letter code for a language tag ("per", "fas", "Persian" → "fa").
/// Covers the languages subtitle releases commonly carry.
pub fn normalize_lang(tag: &str) -> Option<&'static str> {
    Some(match tag.to_ascii_lowercase().as_str() {
        "fa" | "fas" | "per" | "persian" | "farsi" => "fa",
        "en" | "eng" | "english" => "en",
        "ar" | "ara" | "arabic" => "ar",
        "tr" | "tur" | "turkish" => "tr",
        "fr" | "fra" | "fre" | "french" => "fr",
        "de" | "deu" | "ger" | "german" => "de",
        "es" | "spa" | "spanish" => "es",
        "it" | "ita" | "italian" => "it",
        "ru" | "rus" | "russian" => "ru",
        "ja" | "jpn" | "japanese" => "ja",
        "ko" | "kor" | "korean" => "ko",
        "zh" | "zho" | "chi" | "chinese" => "zh",
        "he" | "heb" | "hebrew" => "he",
        "ur" | "urd" | "urdu" => "ur",
        _ => return None,
    })
}

pub fn is_rtl_lang(code: &str) -> bool {
    matches!(code, "fa" | "ar" | "he" | "ur")
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
        assert_eq!(lang_from_file_name("Movie.fa.srt", Some("Movie")), Some("fa"));
        assert_eq!(lang_from_file_name("Movie.English.forced.srt", Some("Movie")), Some("en"));
        assert_eq!(lang_from_file_name("Movie_per.srt", Some("Movie")), Some("fa"));
        assert_eq!(lang_from_file_name("Movie.srt", Some("Movie")), None);
        // Title words before the video name's end are not language tags.
        assert_eq!(lang_from_file_name("It.2017.srt", Some("It.2017")), None);
        assert_eq!(lang_from_file_name("It.2017.srt", None), None);
        assert_eq!(lang_from_file_name("whatever.eng.srt", None), Some("en"));
    }
}
