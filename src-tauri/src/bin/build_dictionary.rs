//! Builds Beyt's offline dictionary from the kaikki.org Wiktionary extract.
//!
//!     build-dictionary <kaikki-persian.jsonl> <dictionary.db>

#[path = "../dict.rs"]
#[allow(dead_code)]
mod dict;

use std::{
    fs::File,
    io::{BufRead, BufReader},
};

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, params};
use serde::Deserialize;

#[derive(Deserialize)]
struct Entry {
    word: String,
    pos: String,
    #[serde(default)]
    forms: Vec<Form>,
    #[serde(default)]
    senses: Vec<Sense>,
}

#[derive(Deserialize)]
struct Form {
    form: String,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Deserialize)]
struct Sense {
    #[serde(default)]
    glosses: Vec<String>,
    #[serde(default)]
    form_of: Vec<serde_json::Value>,
}

fn is_persian(word: &str) -> bool {
    word.chars().any(|c| ('\u{0600}'..='\u{06FF}').contains(&c))
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let [_, input, output] = args.as_slice() else {
        bail!("usage: build-dictionary <kaikki-persian.jsonl> <dictionary.db>");
    };

    let _ = std::fs::remove_file(output);
    let mut db = Connection::open(output).with_context(|| format!("creating {output}"))?;
    db.execute_batch(dict::SCHEMA)?;
    let tx = db.transaction()?;

    let reader = BufReader::new(File::open(input).with_context(|| format!("opening {input}"))?);
    let (mut entries, mut keys) = (0usize, 0usize);
    {
        let mut add_entry = tx.prepare("INSERT INTO entries (id, fa, pos, roman, glosses) VALUES (?1, ?2, ?3, ?4, ?5)")?;
        let mut add_key = tx.prepare("INSERT INTO en_index (key, entry_id, rank) VALUES (?1, ?2, ?3)")?;
        for line in reader.lines() {
            let Ok(entry) = serde_json::from_str::<Entry>(&line?) else { continue };
            if !is_persian(&entry.word) || entry.pos == "name" {
                continue;
            }
            let glosses: Vec<&str> = entry
                .senses
                .iter()
                .filter(|s| s.form_of.is_empty())
                .flat_map(|s| s.glosses.iter().map(String::as_str))
                .collect();
            if glosses.is_empty() {
                continue;
            }
            let roman = entry.forms.iter().find(|f| f.tags.iter().any(|t| t == "romanization")).map(|f| &f.form);
            let fa = entry.word.replace(['ي', 'ى'], "ی").replace('ك', "ک");

            entries += 1;
            let id = entries as i64;
            add_entry.execute(params![id, fa, entry.pos, roman, serde_json::to_string(&glosses)?])?;
            for (rank, gloss) in glosses.iter().enumerate() {
                for key in dict::index_keys(gloss) {
                    add_key.execute(params![key, id, rank as i64])?;
                    keys += 1;
                }
            }
        }
    }
    tx.commit()?;
    db.execute_batch("VACUUM; ANALYZE;")?;
    println!("dictionary: {entries} Persian entries, {keys} English keys → {output}");
    Ok(())
}
