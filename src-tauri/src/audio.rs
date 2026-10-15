//! Audio tracks: the video's own, and audio files the user added (a dub or
//! commentary kept beside the video). The player lists them; this tidies
//! what it reports into what the page shows.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::subs;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AudioTrack {
    /// The player's id for it, used to select it.
    pub id: i64,
    /// Two-letter code when known, else the raw tag, else "und".
    pub lang: String,
    /// The track's title, or an audio file's name.
    pub detail: String,
    pub codec: Option<String>,
    pub channels: Option<i64>,
    pub default: bool,
    pub selected: bool,
    /// The player can decode it (ExoPlayer can't play every codec).
    pub supported: bool,
    /// The audio file it comes from, when it isn't part of the video.
    pub file: Option<String>,
    /// A file the user added, so it can be removed again.
    pub added: bool,
}

/// Turns the player's raw tags into languages, names audio files and marks
/// the ones the user added. Files without a language tag get one from their
/// name, like subtitle files (`Movie.fa.mka`). A file is shown by its whole
/// name: mpv's own title for it is only the part after the video's name.
pub fn finish(tracks: &mut [AudioTrack], video_stem: Option<&str>, added: &[String]) {
    for track in tracks {
        let name = track.file.as_deref().map(file_name);
        let lang = subs::normalize_lang(&track.lang)
            .or_else(|| name.as_deref().and_then(|n| subs::lang_from_file_name(n, video_stem)));
        track.lang = match lang {
            Some(code) => code.to_string(),
            None if track.lang.is_empty() => "und".to_string(),
            None => track.lang.clone(),
        };
        if let Some(name) = name {
            track.detail = name;
        }
        track.added = track.file.as_ref().is_some_and(|f| added.contains(f));
    }
}

/// The last part of a path or content:// link.
fn file_name(file: &str) -> String {
    let decoded = file.replace("%2F", "/").replace("%3A", ":").replace("%20", " ");
    let last = decoded.rsplit(['/', ':']).next().unwrap_or(&decoded);
    Path::new(last).file_name().map_or_else(|| last.to_string(), |n| n.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(lang: &str, title: &str, file: Option<&str>) -> AudioTrack {
        AudioTrack {
            id: 1,
            lang: lang.into(),
            detail: title.into(),
            file: file.map(Into::into),
            supported: true,
            ..AudioTrack::default()
        }
    }

    #[test]
    fn tidies_languages_and_names() {
        let mut tracks = vec![
            track("per", "Dubbed", None),
            track("", "", None),
            track("x-klingon", "", None),
            track("", "fa.mka", Some("/films/Movie.2019.fa.mka")),
            track("eng", "", Some("/films/commentary.mp3")),
        ];
        finish(&mut tracks, Some("Movie.2019"), &["/films/commentary.mp3".into()]);
        let got: Vec<(&str, &str, bool)> =
            tracks.iter().map(|t| (t.lang.as_str(), t.detail.as_str(), t.added)).collect();
        assert_eq!(
            got,
            [
                ("fa", "Dubbed", false),
                ("und", "", false),
                ("x-klingon", "", false),
                ("fa", "Movie.2019.fa.mka", false),
                ("en", "commentary.mp3", true),
            ]
        );
    }

    #[test]
    fn names_content_links() {
        assert_eq!(file_name("content://com.android.externalstorage.documents/document/primary%3AMusic%2Fdub.fa.mka"), "dub.fa.mka");
        assert_eq!(file_name("/a/b c.mp3"), "b c.mp3");
    }
}
