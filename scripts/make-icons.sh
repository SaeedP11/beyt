#!/usr/bin/env bash
# Renders Beyt's icons from src-tauri/icons/design/*.svg: the desktop icon
# (src-tauri/icons/icon.png) and Android's launcher icons, including the
# adaptive layers and the themed (monochrome) icon. Run inside `nix develop`.
#
# The SVGs set the wordmark in Vazirmatn, the app's Persian font, so this
# points fontconfig at the copy in node_modules (run `pnpm install` first).
set -euo pipefail

cd "$(dirname "$0")/.."
design=src-tauri/icons/design
font_dir="$PWD/node_modules/vazirmatn/fonts/ttf"
if [[ ! -d "$font_dir" ]]; then
  echo "Vazirmatn is missing; run pnpm install first." >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cat > "$work/fonts.conf" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig><dir>$font_dir</dir><cachedir>$work/fontcache</cachedir></fontconfig>
EOF
export FONTCONFIG_FILE="$work/fonts.conf"

for name in logo foreground background monochrome; do
  rsvg-convert -w 1024 -h 1024 "$design/$name.svg" -o "$work/$name.png"
done

# The foreground SVG already keeps the mark inside the adaptive safe zone.
cat > "$work/manifest.json" <<EOF
{
  "default": "logo.png",
  "bg_color": "#0b0c0f",
  "android_bg": "background.png",
  "android_fg": "foreground.png",
  "android_fg_scale": 100,
  "android_monochrome": "monochrome.png"
}
EOF
cargo tauri icon "$work/manifest.json" -o "$work/out" >/dev/null

# Only the files Beyt uses: tauri.conf.json and flake.nix name icon.png.
cp "$work/out/icon.png" src-tauri/icons/icon.png
res=src-tauri/gen/android/app/src/main/res
if [[ -d "$res" ]]; then
  cp -r "$work/out/android/." "$res/"
fi

echo "Wrote src-tauri/icons/icon.png${res:+ and the Android launcher icons}."
