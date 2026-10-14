//! Vocabulary media and export: a screenshot and an audio clip for each saved
//! item, sent to Anki through AnkiConnect or written to a CSV file.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result, anyhow, bail};
use crate::player::Mpv;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::store::VocabItem;

const NOTE_TYPE: &str = "Beyt";

/// How vocabulary media is captured (from the Learning settings).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOptions {
    /// Seconds of audio kept before and after the line, so clips don't cut words.
    pub padding: f64,
    pub screenshot: bool,
}

/// Where and how cards go to Anki (from the Anki settings).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiConfig {
    /// AnkiConnect's address, normally http://127.0.0.1:8765.
    pub url: String,
    pub deck: String,
}

/// Captures the current frame and the line's audio. Either may fail without
/// losing the item; the failure is logged and that field stays empty.
pub fn capture(
    mpv: &Mpv,
    media_dir: &Path,
    id: i64,
    video: &Path,
    (start, end): (f64, f64),
    opts: &CaptureOptions,
) -> (Option<String>, Option<String>) {
    if let Err(err) = fs::create_dir_all(media_dir) {
        eprintln!("beyt: creating {}: {err}", media_dir.display());
        return (None, None);
    }
    let shot = format!("beyt-{id}.jpg");
    let screenshot = opts
        .screenshot
        .then(|| {
            mpv.command("screenshot-to-file", &[&media_dir.join(&shot).to_string_lossy(), "video"])
                .map(|_| shot)
                .inspect_err(|e| eprintln!("beyt: screenshot failed: {e:?}"))
                .ok()
        })
        .flatten();
    let clip = format!("beyt-{id}.mp3");
    // mpv numbers audio tracks from 1; ffmpeg's a:N from 0.
    let aid = mpv.get_property::<i64>("aid").unwrap_or(1).max(1) - 1;
    let audio = cut_audio(video, &media_dir.join(&clip), start - opts.padding, end + opts.padding, aid)
        .map(|_| clip)
        .inspect_err(|e| eprintln!("beyt: audio clip failed: {e:#}"))
        .ok();
    (screenshot, audio)
}

fn cut_audio(video: &Path, out: &Path, from: f64, to: f64, track: i64) -> Result<()> {
    let output = Command::new("ffmpeg")
        .args(["-v", "error", "-nostdin", "-y"])
        .args(["-ss", &format!("{:.3}", from.max(0.0)), "-to", &format!("{to:.3}"), "-i"])
        .arg(video)
        .args(["-map", &format!("0:a:{track}?"), "-vn", "-c:a", "libmp3lame", "-q:a", "5"])
        .arg(out)
        .output()
        .context("running ffmpeg")?;
    if !output.status.success() || !out.exists() {
        bail!("ffmpeg: {}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(())
}

pub fn delete_media(media_dir: &Path, item: &VocabItem) {
    for name in [&item.screenshot, &item.audio].into_iter().flatten() {
        let _ = fs::remove_file(media_dir.join(name));
    }
}

// ---------- card content ----------

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('\n', "<br>")
}

/// The sentence as HTML, with the saved word in bold.
fn sentence_html(item: &VocabItem) -> String {
    let html = escape(&item.sentence);
    match item.word.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
        Some(word) => {
            let w = escape(word);
            html.find(&w).map_or(html.clone(), |i| format!("{}<b>{w}</b>{}", &html[..i], &html[i + w.len()..]))
        }
        None => html,
    }
}

fn source(item: &VocabItem) -> String {
    let name = Path::new(&item.video).file_stem().unwrap_or_default().to_string_lossy();
    let secs = item.start.max(0.0) as u64;
    format!("{name} · {}:{:02}:{:02}", secs / 3600, secs / 60 % 60, secs % 60)
}

// ---------- AnkiConnect ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiResult {
    pub added: Vec<i64>,
    /// Already in Anki (duplicates) or rejected.
    pub skipped: usize,
}

fn anki(cfg: &AnkiConfig, action: &str, params: Value) -> Result<Value> {
    let body = json!({ "action": action, "version": 6, "params": params });
    let mut response = ureq::post(&cfg.url)
        .send_json(&body)
        .map_err(|e| anyhow!("Anki is not reachable. Open Anki with the AnkiConnect add-on installed. ({e})"))?;
    let reply: Value = response.body_mut().read_json().context("reading AnkiConnect reply")?;
    match reply.get("error") {
        Some(Value::Null) | None => Ok(reply.get("result").cloned().unwrap_or(Value::Null)),
        Some(err) => bail!("AnkiConnect {action}: {err}"),
    }
}

/// Checks that AnkiConnect answers; returns its API version.
pub fn test_anki(cfg: &AnkiConfig) -> Result<i64> {
    anki(cfg, "version", json!({}))?.as_i64().ok_or_else(|| anyhow!("unexpected reply from AnkiConnect"))
}

fn ensure_note_type(cfg: &AnkiConfig) -> Result<()> {
    let names = anki(cfg, "modelNames", json!({}))?;
    if names.as_array().is_some_and(|a| a.iter().any(|n| n == NOTE_TYPE)) {
        return Ok(());
    }
    anki(
        cfg,
        "createModel",
        json!({
            "modelName": NOTE_TYPE,
            "inOrderFields": ["Word", "Meaning", "Sentence", "Translation", "Audio", "Image", "Source"],
            "css": ".card { font-family: Vazirmatn, sans-serif; font-size: 22px; text-align: center; }\n\
                    .sentence { font-size: 26px; margin: 12px 0; }\n\
                    .meaning { font-size: 30px; color: #2563eb; }\n\
                    .translation { direction: rtl; color: #555; margin-top: 8px; }\n\
                    .source { font-size: 12px; color: #999; margin-top: 16px; }\n\
                    img { max-width: 100%; border-radius: 8px; }",
            "cardTemplates": [{
                "Name": "Recognise",
                "Front": "{{Image}}<div class=sentence>{{Sentence}}</div>{{Audio}}",
                "Back": "{{FrontSide}}<hr id=answer><div class=meaning>{{Word}} {{#Meaning}}= {{Meaning}}{{/Meaning}}</div>\
                         <div class=translation>{{Translation}}</div><div class=source>{{Source}}</div>"
            }]
        }),
    )?;
    Ok(())
}

/// Adds items to Anki's "Beyt" deck. Returns the ids that were added.
pub fn export_to_anki(items: &[VocabItem], media_dir: &Path, cfg: &AnkiConfig) -> Result<AnkiResult> {
    anki(cfg, "createDeck", json!({ "deck": cfg.deck }))?;
    ensure_note_type(cfg)?;

    let media = |name: &Option<String>, field: &str| -> Vec<Value> {
        name.iter()
            .map(|n| json!({ "path": media_dir.join(n), "filename": n, "fields": [field] }))
            .collect()
    };
    let notes: Vec<Value> = items
        .iter()
        .map(|item| {
            json!({
                "deckName": cfg.deck,
                "modelName": NOTE_TYPE,
                "fields": {
                    "Word": escape(item.word.as_deref().unwrap_or_default()),
                    "Meaning": escape(item.meaning.as_deref().unwrap_or_default()),
                    "Sentence": sentence_html(item),
                    "Translation": escape(item.translation.as_deref().unwrap_or_default()),
                    "Source": escape(&source(item)),
                },
                "options": { "allowDuplicate": false },
                "tags": ["beyt"],
                "audio": media(&item.audio, "Audio"),
                "picture": media(&item.screenshot, "Image"),
            })
        })
        .collect();

    // canAddNotes first, so one duplicate doesn't fail the whole batch.
    let can_add = anki(cfg, "canAddNotes", json!({ "notes": notes }))?;
    let (addable, skipped): (Vec<_>, Vec<_>) = notes
        .into_iter()
        .zip(items)
        .zip(can_add.as_array().cloned().unwrap_or_default())
        .partition(|(_, ok)| ok.as_bool() == Some(true));
    let (notes, ids): (Vec<Value>, Vec<i64>) = addable.into_iter().map(|((n, item), _)| (n, item.id)).unzip();
    if !notes.is_empty() {
        anki(cfg, "addNotes", json!({ "notes": notes }))?;
    }
    Ok(AnkiResult { added: ids, skipped: skipped.len() })
}

// ---------- CSV ----------

fn csv_field(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\"\""))
}

/// Writes a CSV Anki can import, and copies the media next to it in
/// `<name>-media/` (to be copied into Anki's collection.media folder).
pub fn export_csv(items: &[VocabItem], media_dir: &Path, out: &Path) -> Result<PathBuf> {
    let stem = out.file_stem().unwrap_or_default().to_string_lossy();
    let out_media = out.with_file_name(format!("{stem}-media"));
    fs::create_dir_all(&out_media).with_context(|| format!("creating {}", out_media.display()))?;

    let mut csv = String::from("#separator:Comma\n#html:true\n#columns:Word,Meaning,Sentence,Translation,Audio,Image,Source\n");
    for item in items {
        for name in [&item.screenshot, &item.audio].into_iter().flatten() {
            let _ = fs::copy(media_dir.join(name), out_media.join(name));
        }
        let audio = item.audio.as_ref().map(|a| format!("[sound:{a}]")).unwrap_or_default();
        let image = item.screenshot.as_ref().map(|s| format!("<img src=\"{s}\">")).unwrap_or_default();
        let row = [
            escape(item.word.as_deref().unwrap_or_default()),
            escape(item.meaning.as_deref().unwrap_or_default()),
            sentence_html(item),
            escape(item.translation.as_deref().unwrap_or_default()),
            audio,
            image,
            escape(&source(item)),
        ];
        csv.push_str(&row.iter().map(|f| csv_field(f)).collect::<Vec<_>>().join(","));
        csv.push('\n');
    }
    fs::write(out, csv).with_context(|| format!("writing {}", out.display()))?;
    Ok(out_media)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(word: Option<&str>, sentence: &str) -> VocabItem {
        VocabItem {
            id: 1,
            word: word.map(Into::into),
            meaning: Some("دویدن".into()),
            sentence: sentence.into(),
            translation: None,
            lang: "en".into(),
            video: "/shows/Show S01E02.mkv".into(),
            start: 3725.4,
            end: 3727.0,
            screenshot: None,
            audio: None,
            created_at: 0,
            exported: false,
        }
    }

    #[test]
    fn bolds_the_word_and_escapes() {
        assert_eq!(sentence_html(&item(Some("run"), "I <run> & run")), "I &lt;<b>run</b>&gt; &amp; run");
        assert_eq!(sentence_html(&item(None, "a\nb")), "a<br>b");
    }

    #[test]
    fn source_names_video_and_time() {
        assert_eq!(source(&item(None, "x")), "Show S01E02 · 1:02:05");
    }

    #[test]
    fn csv_quotes_fields() {
        assert_eq!(csv_field("say \"hi\", ok"), "\"say \"\"hi\"\", ok\"");
    }
}
