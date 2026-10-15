//! Which of several subtitle files fits a video best, judged against the
//! soundtrack without speech recognition.
//!
//! Only a few short stretches of audio are decoded, spread through the film.
//! In each, the slow background level (music, a long noisy scene) is taken
//! away, leaving the rise and fall of speech, and the subtitle's lines are
//! slid over it to find where they fit. A file that fits gives one shift in
//! every stretch; one timed for another frame rate fits only once its times
//! are stretched; one from another film or episode fits nowhere.

use std::{
    fs,
    path::{Path, PathBuf},
};
#[cfg(not(target_os = "android"))]
use std::{
    io::{BufReader, Read},
    process::{Command, Stdio},
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::{
    info,
    media,
    subs::{self, Cue},
};

/// Seconds per loudness sample.
const STEP: f64 = 0.05;
/// The rate ffmpeg resamples to; Android keeps the track's own.
#[cfg(not(target_os = "android"))]
const SAMPLE_RATE: usize = 8000;
#[cfg(not(target_os = "android"))]
const SAMPLES_PER_STEP: usize = (SAMPLE_RATE as f64 * STEP) as usize;
/// Stretches of audio decoded, and how long each is.
const WINDOWS: usize = 12;
const WINDOW_LEN: f64 = 120.0;
/// Steps either side of the running average taken away as background (2 s).
const BACKGROUND: usize = 40;
/// Shifts tried, each way.
const MAX_SHIFT: f64 = 60.0;
/// How far the best shift must stand out from the rest (robust z-score)
/// before the audio is trusted to have found the file's timing.
const CONFIDENT_Z: f64 = 7.0;
/// Shifts smaller than this count as in sync.
const IN_SYNC: f64 = 0.3;
/// A stretch agrees when its own best shift is this close to the overall one.
const AGREE: f64 = 0.3;

/// Common frame-rate mix-ups: (rate the subtitle was timed for, rate of the video).
const FPS_PAIRS: &[(f64, f64)] = &[
    (25.0, 23.976),
    (23.976, 25.0),
    (24.0, 23.976),
    (23.976, 24.0),
    (25.0, 24.0),
    (24.0, 25.0),
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub path: String,
    pub name: String,
    pub lang: String,
    pub cues: usize,
    /// 0–100: how sure the audio check is that this file fits, after penalties.
    pub score: u8,
    /// Offset that lines the file up with the audio, in seconds.
    pub offset: f64,
    /// Audio samples whose own best shift matches `offset`, out of `samples`
    /// (those with dialogue in them).
    pub agree: u8,
    pub samples: u8,
    pub verdict: Verdict,
    pub reasons: Vec<Reason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    InSync,
    /// Fits once the offset is applied.
    Shifted,
    /// Timed for another frame rate, so it drifts; an offset can't fix it.
    Drifts,
    /// The audio check found no timing that fits.
    NoMatch,
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Reason {
    /// File name names the same release group as the video.
    SameRelease { group: String },
    /// File name names a different episode.
    OtherEpisode { subtitle: String, video: String },
    /// Made for a different frame rate.
    FrameRate { subtitle: f64, video: f64 },
    /// Last line comes after the video ends.
    EndsAfter { seconds: f64 },
    /// Lines stop well before the video does.
    Partial { percent: u8 },
    Error { message: String },
}

/// Ranks `files` for `video`, best first. `progress` gets 0–1 while the
/// audio is sampled (cached afterwards, so the next check is instant).
pub fn rank(video: &Path, files: &[PathBuf], cache_root: &Path, progress: impl FnMut(f64)) -> Result<Vec<Candidate>> {
    let (duration, title_tag) = probe(video)?;
    let windows = sample_audio(video, duration, cache_root, progress)?;
    let stem = video.file_stem().unwrap_or_default().to_string_lossy();
    let release = info::release_of(&stem, title_tag.as_deref());

    let mut out: Vec<Candidate> = files.iter().map(|f| judge(f, &stem, &release, &windows, duration)).collect();
    out.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| (a.verdict as u8).cmp(&(b.verdict as u8))));
    Ok(out)
}

fn judge(file: &Path, video_stem: &str, video: &info::Release, windows: &[Window], duration: f64) -> Candidate {
    let name = file.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let mut candidate = Candidate {
        path: file.to_string_lossy().into_owned(),
        lang: subs::lang_from_file_name(&name, Some(video_stem)).unwrap_or("und").to_string(),
        name,
        cues: 0,
        score: 0,
        offset: 0.0,
        agree: 0,
        samples: 0,
        verdict: Verdict::Unreadable,
        reasons: Vec::new(),
    };
    let loaded = match subs::load_file(file) {
        Ok(l) if !l.cues.is_empty() => l,
        Ok(_) => {
            candidate.reasons.push(Reason::Error { message: "no subtitle lines found".into() });
            return candidate;
        }
        Err(e) => {
            candidate.reasons.push(Reason::Error { message: format!("{e:#}") });
            return candidate;
        }
    };
    if candidate.lang == "und" {
        candidate.lang = if loaded.rtl { "fa" } else { "en" }.into();
    }
    candidate.cues = loaded.cues.len();

    let fit = best_fit(windows, &loaded.cues, 1.0);
    let drift = FPS_PAIRS
        .iter()
        .map(|&(sub, vid)| (sub, vid, best_fit(windows, &loaded.cues, sub / vid)))
        .max_by(|a, b| a.2.z.total_cmp(&b.2.z))
        .filter(|(_, _, f)| f.z >= CONFIDENT_Z && f.z > fit.z * 1.5);

    let mut factor = confidence(fit.z);
    candidate.offset = round_to(fit.shift, 0.05);
    candidate.agree = fit.agree;
    candidate.samples = fit.samples;
    candidate.verdict = if let Some((sub, vid, scaled)) = drift {
        candidate.reasons.push(Reason::FrameRate { subtitle: sub, video: vid });
        candidate.agree = scaled.agree;
        candidate.samples = scaled.samples;
        factor = confidence(scaled.z) * 0.4;
        Verdict::Drifts
    } else if fit.z < CONFIDENT_Z {
        Verdict::NoMatch
    } else if fit.shift.abs() < IN_SYNC {
        candidate.offset = 0.0;
        Verdict::InSync
    } else {
        Verdict::Shifted
    };

    // Length, with the offset applied.
    let last = loaded.cues.iter().map(|c| c.end).fold(0.0, f64::max) + candidate.offset;
    if duration > 0.0 {
        if last > duration + 10.0 {
            candidate.reasons.push(Reason::EndsAfter { seconds: (last - duration).round() });
            factor *= 0.6;
        } else if last < duration * 0.75 {
            candidate.reasons.push(Reason::Partial { percent: (last / duration * 100.0).round() as u8 });
            factor *= 0.8;
        }
    }

    // Release name.
    let sub = info::parse_release(&Path::new(&candidate.name).file_stem().unwrap_or_default().to_string_lossy());
    if let (Some(se_sub), Some(se_vid)) = (episode_code(&sub), episode_code(video))
        && se_sub != se_vid
    {
        candidate.reasons.push(Reason::OtherEpisode { subtitle: se_sub, video: se_vid });
        factor *= 0.3;
    }
    if let Some(group) = &video.group
        && words(&candidate.name).any(|w| w.eq_ignore_ascii_case(group))
    {
        candidate.reasons.push(Reason::SameRelease { group: group.clone() });
        factor = (factor * 1.1).min(1.0);
    }

    candidate.score = (factor * 100.0).round() as u8;
    candidate
}

/// Robust z-score → 0–1. Measured on a real film sampled this way: the
/// right subtitles score about 11, another film's about 4.
fn confidence(z: f64) -> f64 {
    ((z - 5.0) / 7.0).clamp(0.0, 1.0)
}

fn round_to(x: f64, step: f64) -> f64 {
    (x / step).round() * step
}

fn episode_code(r: &info::Release) -> Option<String> {
    Some(format!("S{:02}E{:02}", r.season?, r.episode?))
}

fn words(name: &str) -> impl Iterator<Item = &str> {
    name.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty())
}

// ---------- sampling the soundtrack ----------

/// Duration in seconds (0 if unknown) and the container's title tag.
fn probe(video: &Path) -> Result<(f64, Option<String>)> {
    // Phones have no ffprobe; the player plugin answers in its shape.
    #[cfg(target_os = "android")]
    let json = crate::player::probe(video)?;
    #[cfg(not(target_os = "android"))]
    let json: serde_json::Value = {
        let out = Command::new("ffprobe")
            .args(["-v", "error", "-show_entries", "format=duration:format_tags=title", "-of", "json"])
            .arg(video)
            .output()
            .context("running ffprobe (is ffmpeg installed?)")?;
        serde_json::from_slice(&out.stdout).unwrap_or_default()
    };
    let format = &json["format"];
    let duration = format["duration"].as_str().and_then(|d| d.parse().ok()).unwrap_or(0.0);
    let title = format["tags"].as_object().and_then(|tags| {
        tags.iter().find(|(k, _)| k.eq_ignore_ascii_case("title")).and_then(|(_, v)| v.as_str()).map(str::to_string)
    });
    Ok((duration, title))
}

#[derive(Serialize, Deserialize)]
struct Sample {
    start: f64,
    /// Speech-band loudness every `STEP` seconds, in dB.
    loudness: Vec<f32>,
}

/// Where to sample: the whole of a short video, else `WINDOWS` stretches
/// spread evenly between the opening and the end credits.
fn window_starts(duration: f64) -> Vec<(f64, f64)> {
    if duration <= WINDOWS as f64 * WINDOW_LEN * 1.5 {
        return vec![(0.0, duration.max(WINDOW_LEN))];
    }
    let (first, last) = (duration * 0.04, duration * 0.93 - WINDOW_LEN);
    (0..WINDOWS).map(|i| (first + (last - first) * i as f64 / (WINDOWS - 1) as f64, WINDOW_LEN)).collect()
}

fn sample_audio(video: &Path, duration: f64, cache_root: &Path, mut progress: impl FnMut(f64)) -> Result<Vec<Window>> {
    let cache = media::cache_dir(cache_root, video).join("speech-samples-v3.json");
    let samples: Vec<Sample> = match fs::read(&cache).ok().and_then(|b| serde_json::from_slice(&b).ok()) {
        Some(cached) => cached,
        None => {
            let starts = window_starts(duration);
            let mut samples = Vec::with_capacity(starts.len());
            for (i, &(start, len)) in starts.iter().enumerate() {
                samples.push(Sample { start, loudness: decode(video, start, len, &cache)? });
                progress((i + 1) as f64 / starts.len() as f64);
            }
            if let Some(dir) = cache.parent()
                && fs::create_dir_all(dir).is_ok()
            {
                let _ = fs::write(&cache, serde_json::to_vec(&samples)?);
            }
            samples
        }
    };
    progress(1.0);
    Ok(samples.iter().map(|s| Window::new(s.start, &s.loudness)).collect())
}

/// Loudness in dB of one step's worth of samples.
fn step_loudness(samples: impl Iterator<Item = f64>, count: usize) -> f32 {
    let power = samples.map(|s| s * s).sum::<f64>() / count as f64;
    (10.0 * (power + 1.0).log10()) as f32
}

/// Speech-band (200–3500 Hz) loudness of `len` seconds from `start`. ffmpeg
/// seeks straight there, so only this stretch is read and decoded.
#[cfg(not(target_os = "android"))]
fn decode(video: &Path, start: f64, len: f64, _scratch: &Path) -> Result<Vec<f32>> {
    let mut child = Command::new("ffmpeg")
        .args(["-v", "error", "-nostdin", "-ss", &format!("{start:.3}"), "-t", &format!("{len:.3}"), "-i"])
        .arg(video)
        .args(["-vn", "-sn", "-dn", "-af", "highpass=f=200,lowpass=f=3500"])
        .args(["-ac", "1", "-ar", &SAMPLE_RATE.to_string(), "-f", "s16le", "pipe:1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("running ffmpeg (is ffmpeg installed?)")?;
    let mut reader = BufReader::new(child.stdout.take().expect("piped"));
    let mut buf = vec![0u8; SAMPLES_PER_STEP * 2];
    let mut out = Vec::new();
    loop {
        match reader.read_exact(&mut buf) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(e).context("reading audio from ffmpeg"),
        }
        let samples = buf.as_chunks::<2>().0.iter().map(|b| f64::from(i16::from_le_bytes(*b)));
        out.push(step_loudness(samples, SAMPLES_PER_STEP));
    }
    let status = child.wait()?;
    if !status.success() || out.is_empty() {
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut err);
        }
        bail!("couldn't read the soundtrack: {}", if err.trim().is_empty() { "no audio track" } else { err.trim() });
    }
    Ok(out)
}

/// Android has no ffmpeg: the player plugin decodes the stretch with the
/// phone's own decoders into mono 16-bit samples at the track's rate, and the
/// same speech band is kept here with the filters ffmpeg would use.
#[cfg(target_os = "android")]
fn decode(video: &Path, start: f64, len: f64, scratch: &Path) -> Result<Vec<f32>> {
    let pcm = scratch.with_file_name("speech.pcm");
    if let Some(dir) = pcm.parent() {
        fs::create_dir_all(dir)?;
    }
    let rate = crate::player::decode_audio(video, start, len, &pcm);
    let bytes = fs::read(&pcm);
    let _ = fs::remove_file(&pcm);
    let (rate, bytes) = (rate?, bytes.context("reading the decoded audio")?);

    let per_step = (rate as f64 * STEP).round() as usize;
    let mut high = Biquad::high_pass(200.0, rate as f64);
    let mut low = Biquad::low_pass(3500.0, rate as f64);
    let filtered: Vec<f64> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|b| low.run(high.run(f64::from(i16::from_le_bytes(*b)))))
        .collect();
    let out: Vec<f32> = filtered.chunks_exact(per_step.max(1)).map(|c| step_loudness(c.iter().copied(), c.len())).collect();
    if out.is_empty() {
        bail!("couldn't read the soundtrack: no audio in this stretch");
    }
    Ok(out)
}

/// A two-pole Butterworth filter, as ffmpeg's `highpass` and `lowpass` are by default.
#[cfg(any(target_os = "android", test))]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    x: [f64; 2],
    y: [f64; 2],
}

#[cfg(any(target_os = "android", test))]
impl Biquad {
    fn new(cutoff: f64, rate: f64, high: bool) -> Self {
        let w = std::f64::consts::TAU * cutoff / rate;
        let alpha = w.sin() / std::f64::consts::SQRT_2;
        let cos = w.cos();
        let (b0, b1) = if high { ((1.0 + cos) / 2.0, -(1.0 + cos)) } else { ((1.0 - cos) / 2.0, 1.0 - cos) };
        let a0 = 1.0 + alpha;
        Biquad {
            b: [b0 / a0, b1 / a0, b0 / a0],
            a: [-2.0 * cos / a0, (1.0 - alpha) / a0],
            x: [0.0; 2],
            y: [0.0; 2],
        }
    }

    fn high_pass(cutoff: f64, rate: f64) -> Self {
        Self::new(cutoff, rate, true)
    }

    fn low_pass(cutoff: f64, rate: f64) -> Self {
        Self::new(cutoff, rate, false)
    }

    fn run(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.b[1] * self.x[0] + self.b[2] * self.x[1] - self.a[0] * self.y[0] - self.a[1] * self.y[1];
        self.x = [x, self.x[0]];
        self.y = [y, self.y[0]];
        y
    }
}

// ---------- lining up ----------

/// One stretch of audio, ready to compare lines against.
struct Window {
    /// Seconds into the video.
    start: f64,
    /// Running sum of the background-free, standardised loudness:
    /// `prefix[i]` is the sum of the first `i` steps.
    prefix: Vec<f64>,
}

#[derive(Debug, Clone, Copy)]
struct Fit {
    /// Seconds to add to every cue.
    shift: f64,
    /// How far the best shift stands out from all the others.
    z: f64,
    agree: u8,
    samples: u8,
}

impl Window {
    fn new(start: f64, loudness: &[f32]) -> Self {
        // Take away the running average, leaving the rise and fall of speech.
        let n = loudness.len();
        let mut sums = vec![0.0f64; n + 1];
        for (i, &v) in loudness.iter().enumerate() {
            sums[i + 1] = sums[i] + f64::from(v);
        }
        let speech: Vec<f64> = (0..n)
            .map(|i| {
                let (a, b) = (i.saturating_sub(BACKGROUND), (i + BACKGROUND + 1).min(n));
                f64::from(loudness[i]) - (sums[b] - sums[a]) / (b - a) as f64
            })
            .collect();
        let len = n.max(1) as f64;
        let mean = speech.iter().sum::<f64>() / len;
        let sd = (speech.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / len).sqrt().max(1e-9);
        let mut prefix = Vec::with_capacity(n + 1);
        prefix.push(0.0);
        for v in speech {
            prefix.push(prefix.last().unwrap() + (v - mean) / sd);
        }
        Self { start, prefix }
    }

    fn steps(&self) -> i64 {
        self.prefix.len() as i64 - 1
    }

    /// Correlation between "a line is showing" and speech, with every cue
    /// moved by `shift` steps. `spans` are merged cue spans in steps from
    /// the window's start.
    fn correlation(&self, spans: &[(i64, i64)], shift: i64) -> f64 {
        let n = self.steps();
        let (mut sum, mut covered) = (0.0, 0i64);
        for &(a, b) in spans {
            let (a, b) = ((a + shift).clamp(0, n), (b + shift).clamp(0, n));
            sum += self.prefix[b as usize] - self.prefix[a as usize];
            covered += b - a;
        }
        if covered == 0 || covered == n {
            return 0.0;
        }
        let p = covered as f64 / n as f64;
        sum / (n as f64 * (p * (1.0 - p)).sqrt())
    }
}

/// The shift that lines the cues (times scaled by `scale`) up with every
/// window at once, and how many windows agree on it on their own.
fn best_fit(windows: &[Window], cues: &[Cue], scale: f64) -> Fit {
    let max = (MAX_SHIFT / STEP) as i64;
    let width = (2 * max + 1) as usize;
    let mut total = vec![0.0; width];
    let mut own_best: Vec<i64> = Vec::new();
    for w in windows {
        let spans = spans(cues, scale, w.start, w.steps() as f64 * STEP);
        if spans.is_empty() {
            continue;
        }
        let curve: Vec<f64> = (-max..=max).map(|s| w.correlation(&spans, s)).collect();
        for (t, c) in total.iter_mut().zip(&curve) {
            *t += c;
        }
        own_best.push(argmax(&curve) as i64 - max);
    }
    let best = argmax(&total);
    let shift = best as i64 - max;
    let near = (AGREE / STEP).round() as i64;
    Fit {
        shift: shift as f64 * STEP,
        z: robust_z(&total, total[best]),
        agree: own_best.iter().filter(|&&s| (s - shift).abs() <= near).count() as u8,
        samples: own_best.len() as u8,
    }
}

fn argmax(v: &[f64]) -> usize {
    v.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).map_or(0, |(i, _)| i)
}

/// Cue times (scaled) in steps from `start`, for cues that can reach the
/// window at some shift; sorted, with overlaps merged.
fn spans(cues: &[Cue], scale: f64, start: f64, len: f64) -> Vec<(i64, i64)> {
    let (from, to) = (start - MAX_SHIFT, start + len + MAX_SHIFT);
    let mut spans: Vec<(i64, i64)> = cues
        .iter()
        .map(|c| (c.start * scale, c.end * scale))
        .filter(|&(a, b)| b > from && a < to)
        .map(|(a, b)| (((a - start) / STEP).round() as i64, ((b - start) / STEP).round() as i64))
        .filter(|(a, b)| b > a)
        .collect();
    spans.sort_unstable();
    let mut merged: Vec<(i64, i64)> = Vec::with_capacity(spans.len());
    for (a, b) in spans {
        match merged.last_mut() {
            Some(last) if a <= last.1 => last.1 = last.1.max(b),
            _ => merged.push((a, b)),
        }
    }
    merged
}

/// How many robust standard deviations `peak` is above the curve's median.
fn robust_z(curve: &[f64], peak: f64) -> f64 {
    let median = |v: &mut Vec<f64>| {
        v.sort_by(f64::total_cmp);
        v[v.len() / 2]
    };
    let mut v = curve.to_vec();
    let m = median(&mut v);
    let mut dev: Vec<f64> = curve.iter().map(|x| (x - m).abs()).collect();
    let mad = median(&mut dev) * 1.4826;
    if mad <= 1e-12 { 0.0 } else { (peak - m) / mad }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILM: f64 = 1800.0;

    fn cue(start: f64, end: f64) -> Cue {
        Cue { start, end, text: String::new() }
    }

    /// Irregular lines through the film, like real dialogue.
    fn dialogue(seed: u32) -> Vec<Cue> {
        let mut t = 3.0;
        let mut seed = seed;
        let mut cues = Vec::new();
        while t < FILM - 10.0 {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
            let len = 1.0 + f64::from(seed >> 28) / 4.0;
            cues.push(cue(t, t + len));
            t += len + 0.5 + f64::from((seed >> 20) & 0xff) / 40.0;
        }
        cues
    }

    /// A fake soundtrack: louder while a line is spoken, over music that
    /// swells slowly between quiet and much louder than the speech.
    fn soundtrack(lines: &[Cue]) -> Vec<f32> {
        let mut seed: u32 = 12345;
        (0..(FILM / STEP) as usize)
            .map(|i| {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
                let noise = (seed >> 16) as f32 / 65536.0 * 10.0;
                let t = i as f64 * STEP;
                let music = 45.0 + 20.0 * (t / 97.0).sin() as f32;
                let speaking = lines.iter().any(|c| t >= c.start && t < c.end);
                music + noise + if speaking { 8.0 } else { 0.0 }
            })
            .collect()
    }

    /// The film sampled the way `sample_audio` samples a real one.
    fn sampled(lines: &[Cue]) -> Vec<Window> {
        let sound = soundtrack(lines);
        window_starts(FILM)
            .into_iter()
            .map(|(start, len)| {
                let a = (start / STEP) as usize;
                let b = (a + (len / STEP) as usize).min(sound.len());
                Window::new(start, &sound[a..b])
            })
            .collect()
    }

    fn moved(cues: &[Cue], f: impl Fn(f64) -> f64) -> Vec<Cue> {
        cues.iter().map(|c| cue(f(c.start), f(c.end))).collect()
    }

    #[test]
    fn windows_skip_opening_and_credits() {
        let starts = window_starts(5400.0);
        assert_eq!(starts.len(), WINDOWS);
        assert!(starts[0].0 > 200.0 && starts[WINDOWS - 1].0 + WINDOW_LEN < 5400.0 * 0.95);
        assert_eq!(window_starts(600.0), [(0.0, 600.0)]);
    }

    #[test]
    fn synced_file_needs_no_shift() {
        let lines = dialogue(7);
        let fit = best_fit(&sampled(&lines), &lines, 1.0);
        assert!(fit.shift.abs() < IN_SYNC && fit.z > CONFIDENT_Z, "{fit:?}");
        assert!(fit.agree >= fit.samples - 1, "{fit:?}");
    }

    #[test]
    fn late_file_gets_a_negative_offset() {
        let lines = dialogue(7);
        let fit = best_fit(&sampled(&lines), &moved(&lines, |t| t + 2.3), 1.0);
        assert!((fit.shift + 2.3).abs() <= STEP && fit.z > CONFIDENT_Z, "{fit:?}");
    }

    #[test]
    fn frame_rate_drift_is_found() {
        let lines = dialogue(7);
        let windows = sampled(&lines);
        // Timed for a 25 fps (PAL) version of a 23.976 fps video.
        let pal = moved(&lines, |t| t * 23.976 / 25.0);
        let plain = best_fit(&windows, &pal, 1.0);
        let scaled = best_fit(&windows, &pal, 25.0 / 23.976);
        assert!(scaled.z > CONFIDENT_Z && scaled.z > plain.z * 1.5, "{plain:?} {scaled:?}");
    }

    #[test]
    fn another_films_lines_are_no_match() {
        let windows = sampled(&dialogue(7));
        let fit = best_fit(&windows, &dialogue(99), 1.0);
        assert!(fit.z < CONFIDENT_Z, "{fit:?}");
    }

    #[test]
    fn overlapping_cues_merge() {
        let cues = [cue(2.0, 3.0), cue(0.0, 1.0), cue(0.5, 1.5)];
        assert_eq!(spans(&cues, 1.0, 0.0, 10.0), [(0, 30), (40, 60)]);
    }

    #[test]
    fn speech_band_filters_keep_only_speech() {
        // Root-mean-square of a tone after both filters, at a phone's 48 kHz.
        let level = |hz: f64| {
            let rate = 48_000.0;
            let (mut high, mut low) = (Biquad::high_pass(200.0, rate), Biquad::low_pass(3500.0, rate));
            let out: Vec<f64> = (0..48_000)
                .map(|i| low.run(high.run((std::f64::consts::TAU * hz * i as f64 / rate).sin())))
                .skip(4800)
                .collect();
            (out.iter().map(|y| y * y).sum::<f64>() / out.len() as f64).sqrt()
        };
        let full = std::f64::consts::FRAC_1_SQRT_2;
        assert!((level(1000.0) / full - 1.0).abs() < 0.05);
        assert!(level(50.0) / full < 0.1);
        assert!(level(12_000.0) / full < 0.1);
        // At the cutoffs a Butterworth filter keeps 1/√2 of the level.
        assert!((level(200.0) / full - full).abs() < 0.05);
    }
}




