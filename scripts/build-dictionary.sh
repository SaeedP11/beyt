#!/usr/bin/env bash
# Downloads Wiktionary's Persian entries (kaikki.org extract, CC BY-SA) and
# builds Beyt's offline dictionary into the app's data folder.
# The app can do this itself (Settings → Learning, or the word popup); this
# script is for developers and keeps the download in data/ for rebuilds.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p data
src=data/kaikki-persian.jsonl
if [[ ! -s $src ]]; then
  curl -fL --progress-bar -o "$src.part" https://kaikki.org/dictionary/Persian/kaikki.org-dictionary-Persian.jsonl
  mv "$src.part" "$src"
fi

dest="${XDG_DATA_HOME:-$HOME/.local/share}/app.beyt.player/dictionary.db"
mkdir -p "$(dirname "$dest")"
(cd src-tauri && cargo run --quiet --bin build_dictionary -- "../$src" "$dest")
