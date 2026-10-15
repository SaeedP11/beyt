#!/usr/bin/env bash
# Builds a release of Beyt for Android. Run it inside `nix develop .#android`.
#
#   scripts/build-android.sh          arm64 APK, to install with adb
#   scripts/build-android.sh --aab    arm64 App Bundle, for Google Play
#   scripts/build-android.sh --all    one APK per ABI, for old 32-bit phones
#                                     and the x86_64 emulator too
#
# Only arm64 is built by default: it covers practically every phone in use,
# and each extra ABI adds another copy of the native library to the package.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${ANDROID_HOME:-}" || -z "${NDK_HOME:-}" ]]; then
  echo "Run this inside the Android shell: nix develop .#android" >&2
  exit 1
fi

case "${1:-}" in
  "") args=(--apk --target aarch64) ;;
  --aab) args=(--aab --target aarch64) ;;
  --all) args=(--apk --split-per-abi) ;;
  *)
    echo "usage: $0 [--aab | --all]" >&2
    exit 2
    ;;
esac

# The Android Studio project is generated once, then kept in git.
if [[ ! -d src-tauri/gen/android ]]; then
  cargo tauri android init --ci
fi

# Size over speed for the Rust library: it ships in every download, and none
# of Beyt's Rust code is hot enough to need opt-level 3. Cargo.toml's release
# profile adds LTO, one codegen unit and stripping on top.
export CARGO_PROFILE_RELEASE_OPT_LEVEL=s

cargo tauri android build --ci "${args[@]}"

echo
echo "Packages:"
find src-tauri/gen/android/app/build/outputs \( -name '*.apk' -o -name '*.aab' \) -printf '  %p (%s bytes)\n'
