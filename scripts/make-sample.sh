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
