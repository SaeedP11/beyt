//! Offline English ↔ Persian dictionary, built from Wiktionary's Persian
//! entries (kaikki.org extract, CC BY-SA). Each Persian word has English
//! glosses; the build step turns the glosses into English lookup keys.

use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::{Connection, OpenFlags, params};
use serde::Serialize;

#[allow(dead_code)] // Used by the build_dictionary binary.
pub const SCHEMA: &str = "
    CREATE TABLE entries (
        id      INTEGER PRIMARY KEY,
        fa      TEXT NOT NULL,
        pos     TEXT NOT NULL,
        roman   TEXT,
        glosses TEXT NOT NULL      -- JSON array of English senses
    );
    CREATE TABLE en_index (
        key      TEXT NOT NULL,    -- normalised English word or short phrase
        entry_id INTEGER NOT NULL,
        rank     INTEGER NOT NULL  -- lower = earlier sense, better match
    );
    CREATE INDEX en_index_key ON en_index(key);
    CREATE INDEX entries_fa ON entries(fa);
";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub fa: String,
    pub pos: String,
    pub roman: Option<String>,
    pub glosses: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lookup {
    /// The word as clicked, cleaned of punctuation.
    pub word: String,
    /// The form that matched (e.g. "run" for "running"), if any did.
    pub matched: Option<String>,
    pub entries: Vec<Entry>,
}

/// Glosses that only point at another word ("plural of X") make poor keys.
#[allow(dead_code)] // Used by the build_dictionary binary.
fn is_reference_gloss(gloss: &str) -> bool {
    let g = gloss.to_ascii_lowercase();
    [
        "plural of", "alternative form", "alternative spelling", "obsolete form", "obsolete spelling",
        "spelling of", "form of", "abbreviation of", "short for", "synonym of", "romanization of",
        "superlative degree of", "comparative degree of", "present stem of", "past stem of",
    ]
    .iter()
    .any(|p| g.contains(p))
}

/// English lookup keys from one gloss: "to go; to leave (somewhere)" → ["go", "leave"].
#[allow(dead_code)] // Used by the build_dictionary binary.
pub fn index_keys(gloss: &str) -> Vec<String> {
    if is_reference_gloss(gloss) {
        return Vec::new();
    }
    // Drop parenthetical notes.
    let mut text = String::with_capacity(gloss.len());
    let mut depth = 0usize;
    for ch in gloss.chars() {
        match ch {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => text.push(ch),
            _ => {}
        }
    }
    text.split([',', ';', '/'])
        .filter_map(|part| {
            let mut p = part.trim().trim_end_matches(['.', '!', '?']).to_lowercase();
            for prefix in ["to be ", "to ", "a ", "an ", "the "] {
                if let Some(rest) = p.strip_prefix(prefix) {
                    // Keep "to be" phrases whole only when nothing follows.
                    p = if prefix == "to be " { format!("be {rest}") } else { rest.to_string() };
                    break;
                }
            }
            let words = p.split_whitespace().count();
            (words > 0 && words <= 3 && p.chars().all(|c| c.is_alphabetic() || c == ' ' || c == '-' || c == '\''))
                .then_some(p)
        })
        .collect()
}

/// Forms to try for an English word, most likely first: "running" → running, run, …
pub fn lemma_candidates(word: &str) -> Vec<String> {
    let w = word.to_lowercase();
    let mut out = vec![w.clone()];
    let mut push = |s: String| {
        if s.len() >= 2 && !out.contains(&s) {
            out.push(s);
        }
    };
    // Contractions and possessives.
    for (suffix, base) in [("n't", ""), ("'s", ""), ("'re", ""), ("'ve", ""), ("'ll", ""), ("'d", ""), ("'m", "")] {
        if let Some(stem) = w.strip_suffix(suffix) {
            push(format!("{stem}{base}"));
        }
    }
    let irregular = [
        ("was", "be"), ("were", "be"), ("is", "be"), ("are", "be"), ("am", "be"), ("been", "be"),
        ("had", "have"), ("has", "have"), ("did", "do"), ("does", "do"), ("done", "do"),
        ("went", "go"), ("gone", "go"), ("saw", "see"), ("seen", "see"), ("came", "come"),
        ("took", "take"), ("taken", "take"), ("made", "make"), ("said", "say"), ("got", "get"),
        ("gave", "give"), ("given", "give"), ("knew", "know"), ("known", "know"), ("thought", "think"),
        ("told", "tell"), ("found", "find"), ("left", "leave"), ("felt", "feel"), ("brought", "bring"),
        ("began", "begin"), ("kept", "keep"), ("held", "hold"), ("wrote", "write"), ("written", "write"),
        ("stood", "stand"), ("heard", "hear"), ("meant", "mean"), ("met", "meet"), ("ran", "run"),
        ("paid", "pay"), ("sat", "sit"), ("spoke", "speak"), ("spoken", "speak"), ("lay", "lie"),
        ("led", "lead"), ("grew", "grow"), ("lost", "lose"), ("fell", "fall"), ("sent", "send"),
        ("built", "build"), ("understood", "understand"), ("children", "child"), ("men", "man"),
        ("women", "woman"), ("people", "person"), ("feet", "foot"), ("teeth", "tooth"), ("mice", "mouse"),
        ("better", "good"), ("best", "good"), ("worse", "bad"), ("worst", "bad"), ("ate", "eat"),
        ("eaten", "eat"), ("drank", "drink"), ("slept", "sleep"), ("bought", "buy"), ("caught", "catch"),
        ("taught", "teach"), ("fought", "fight"), ("sold", "sell"), ("flew", "fly"), ("forgot", "forget"),
    ];
    if let Some((_, base)) = irregular.iter().find(|(form, _)| *form == w) {
        push((*base).to_string());
    }
    let undouble = |s: &str| -> Option<String> {
        let b = s.as_bytes();
        (b.len() >= 3 && b[b.len() - 1] == b[b.len() - 2] && !b"aeiouls".contains(&b[b.len() - 1]))
            .then(|| s[..s.len() - 1].to_string())
    };
    for suffix in ["ing", "ed"] {
        if let Some(stem) = w.strip_suffix(suffix) {
            if let Some(s) = undouble(stem) {
                push(s); // running → run, stopped → stop
            }
            push(stem.to_string()); // walking → walk
            push(format!("{stem}e")); // making → make, loved → love
        }
    }
    if let Some(stem) = w.strip_suffix("ied") {
        push(format!("{stem}y")); // studied → study
    }
    if let Some(stem) = w.strip_suffix("ies") {
        push(format!("{stem}y")); // cities → city
    }
    if let Some(stem) = w.strip_suffix("es") {
        push(stem.to_string()); // boxes → box
    }
    if let Some(stem) = w.strip_suffix('s') {
        push(stem.to_string()); // cats → cat
    }
    for suffix in ["ly", "er", "est"] {
        if let Some(stem) = w.strip_suffix(suffix) {
            push(stem.to_string()); // quickly → quick, faster → fast
            if let Some(s) = undouble(stem) {
                push(s); // bigger → big
            }
        }
    }
    out
}

/// Strips the punctuation a subtitle word comes with: "“Hello,”" → "Hello".
pub fn clean_word(raw: &str) -> String {
    raw.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'' && c != '’' && c != '\u{200c}')
        .replace('’', "'")
        .trim_matches('\'')
        .to_string()
}

pub struct Dictionary {
    db: std::sync::Mutex<Connection>,
}

impl Dictionary {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .with_context(|| format!("opening {}", path.display()))?;
        Ok(Self { db: std::sync::Mutex::new(db) })
    }

    fn entries(&self, sql: &str, param: &str, limit: usize) -> Result<Vec<Entry>> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut stmt = db.prepare_cached(sql)?;
        let rows = stmt.query_map(params![param, limit as i64], |r| {
            let glosses: String = r.get(3)?;
            Ok(Entry {
                fa: r.get(0)?,
                pos: r.get(1)?,
                roman: r.get(2)?,
                glosses: serde_json::from_str(&glosses).unwrap_or_default(),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// English word → Persian entries, trying base forms until one matches.
    pub fn lookup_english(&self, raw: &str) -> Result<Lookup> {
        let word = clean_word(raw);
        for candidate in lemma_candidates(&word) {
            let entries = self.entries(
                "SELECT e.fa, e.pos, e.roman, e.glosses FROM en_index i JOIN entries e ON e.id = i.entry_id
                 WHERE i.key = ?1 GROUP BY e.id ORDER BY MIN(i.rank), e.id LIMIT ?2",
                &candidate,
                8,
            )?;
            if !entries.is_empty() {
                return Ok(Lookup { word, matched: Some(candidate), entries });
            }
        }
        Ok(Lookup { word, matched: None, entries: Vec::new() })
    }

    pub fn entry_count(&self) -> Result<i64> {
        let db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        Ok(db.query_row("SELECT COUNT(*) FROM entries", [], |r| r.get(0))?)
    }

    /// Persian word → its entries with English glosses.
    pub fn lookup_persian(&self, raw: &str) -> Result<Lookup> {
        let word = clean_word(raw).replace(['ي', 'ى'], "ی").replace('ك', "ک");
        let entries = self.entries(
            "SELECT fa, pos, roman, glosses FROM entries WHERE fa = ?1 ORDER BY id LIMIT ?2",
            &word,
            6,
        )?;
        let matched = (!entries.is_empty()).then(|| word.clone());
        Ok(Lookup { word, matched, entries })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_from_glosses() {
        assert_eq!(index_keys("to go"), ["go"]);
        assert_eq!(index_keys("hello, hi (a greeting when meeting someone)"), ["hello", "hi"]);
        assert_eq!(index_keys("salutation; greeting"), ["salutation", "greeting"]);
        assert_eq!(index_keys("a book"), ["book"]);
        assert!(index_keys("plural of کاتب (kātib)").is_empty());
        assert!(index_keys("the salam uttered at the end of prayer").is_empty());
    }

    #[test]
    fn lemma_forms() {
        let has = |w: &str, base: &str| lemma_candidates(w).contains(&base.to_string());
        assert!(has("running", "run"));
        assert!(has("making", "make"));
        assert!(has("studied", "study"));
        assert!(has("cities", "city"));
        assert!(has("went", "go"));
        assert!(has("don't", "do"));
        assert!(has("bigger", "big"));
        assert_eq!(lemma_candidates("Book")[0], "book");
    }

    #[test]
    fn cleans_punctuation() {
        assert_eq!(clean_word("“Hello,”"), "Hello");
        assert_eq!(clean_word("don’t."), "don't");
        assert_eq!(clean_word("می‌روی؟"), "می‌روی");
    }
}
