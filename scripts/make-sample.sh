#!/usr/bin/env bash
# Generates samples/sync-test.mkv with a burned-in clock, plus English and
# Persian subtitles whose text names their own start time. If the overlay is
# in sync, each subtitle appears exactly when the clock reaches that time.
#
# The Persian file is deliberately "legacy": Windows-1256 encoded, Arabic
# letter forms (ي ك), and punctuation typed at the wrong end of the line.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p samples
out=samples/sync-test
duration=60

ffmpeg -loglevel error -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=${duration}" \
  -f lavfi -i "sine=frequency=880:beep_factor=4:duration=${duration}" \
  -vf "drawtext=text='%{pts\:hms}':fontsize=96:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=16:x=(w-tw)/2:y=h*0.32" \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac \
  "${out}.mkv"

ts() { printf '%02d:%02d:%02d,%03d' $(($1 / 3600)) $(($1 % 3600 / 60)) $(($1 % 60)) 0; }

en="" fa=""
n=1
for ((t = 2; t < duration; t += 3)); do
  start=$(ts "$t") end=$(ts $((t + 2)))
  mm=$(printf '%02d:%02d' $((t / 60)) $((t % 60)))
  en+="${n}"$'\n'"${start} --> ${end}"$'\n'"Line ${n} starts at ${mm}"$'\n\n'
  if ((n % 2)); then
    fa+="${n}"$'\n'"${start} --> ${end}"$'\n'"خط ${n} در ${mm} شروع مي‌شود."$'\n\n'
  else
    fa+="${n}"$'\n'"${start} --> ${end}"$'\n'"؟آيا اين خط ${n} در ${mm} است"$'\n\n'
  fi
  n=$((n + 1))
done

printf '%s' "$en" >"${out}.en.srt"
printf '%s' "$fa" | iconv -f UTF-8 -t WINDOWS-1256 >"${out}.fa.srt"

echo "Wrote ${out}.mkv, ${out}.en.srt, ${out}.fa.srt (Windows-1256)"

# A short "series" for the library, resume and next-episode autoplay:
# episodes 1, 2, 3 and 10 (to check natural order), each with embedded
# English, Persian, forced English and Japanese subtitle tracks.
show="samples/Sample Show"
mkdir -p "$show"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for ep in 1 2 3 10; do
  name=$(printf 'Sample Show S01E%02d' "$ep")
  ffmpeg -loglevel error -y \
    -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=20" \
    -f lavfi -i "sine=frequency=$((300 + ep * 40)):duration=20" \
    -vf "drawtext=text='Episode ${ep}  %{pts\:hms}':fontsize=72:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=14:x=(w-tw)/2:y=h*0.32" \
    -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac "$tmp/video.mkv"
  printf '1\n00:00:01,000 --> 00:00:06,000\nEpisode %s, first line\n\n2\n00:00:08,000 --> 00:00:14,000\nEpisode %s, second line\n' "$ep" "$ep" >"$tmp/en.srt"
  printf '1\n00:00:01,000 --> 00:00:06,000\nقسمت %s، خط اول\n\n2\n00:00:08,000 --> 00:00:14,000\nقسمت %s، خط دوم\n' "$ep" "$ep" >"$tmp/fa.srt"
  printf '1\n00:00:16,000 --> 00:00:19,000\n[SIGN: Episode %s]\n' "$ep" >"$tmp/forced.srt"
  printf '1\n00:00:01,000 --> 00:00:06,000\n第%s話 一行目\n' "$ep" >"$tmp/ja.srt"
  ffmpeg -loglevel error -y -i "$tmp/video.mkv" \
    -i "$tmp/en.srt" -i "$tmp/fa.srt" -i "$tmp/forced.srt" -i "$tmp/ja.srt" \
    -map 0 -map 1 -map 2 -map 3 -map 4 -c copy -c:s srt \
    -metadata:s:s:0 language=eng -metadata:s:s:0 title="English (Full)" \
    -metadata:s:s:1 language=per -metadata:s:s:1 title="Farsi" \
    -metadata:s:s:2 language=eng -metadata:s:s:2 title="Signs" -disposition:s:2 forced \
    -metadata:s:s:3 language=jpn \
    "$show/$name.mkv"
done
echo "Wrote $show/ (4 episodes with embedded subtitles)"
