//! Builds Beyt's offline dictionary from the kaikki.org Wiktionary extract.
//! The app can also download and build it itself, from Settings or the word
//! popup; this is for building from a local copy.
//!
//!     build-dictionary <kaikki-persian.jsonl> <dictionary.db>

#[path = "../dict.rs"]
#[allow(dead_code)]
mod dict;

use std::{fs::File, io::BufReader, path::Path};

use anyhow::{Context, Result, bail};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let [_, input, output] = args.as_slice() else {
        bail!("usage: build-dictionary <kaikki-persian.jsonl> <dictionary.db>");
    };
    let reader = BufReader::new(File::open(input).with_context(|| format!("opening {input}"))?);
    let built = dict::build(reader, Path::new(output))?;
    println!("dictionary: {} Persian entries, {} English keys → {output}", built.entries, built.keys);
    Ok(())
}
