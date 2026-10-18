{
  description = "Beyt — a dual-subtitle video player for language learning";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    # Rust with the Android targets' standard libraries, which nixpkgs' rustc
    # doesn't ship. Only the Android shell uses it.
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, flake-utils, rust-overlay, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        # Pinned to a major version: pnpm's store format changes between majors.
        pnpm = pkgs.pnpm_11;

        # The Android SDK is unfree; its licence is accepted for the Android
        # shell only, so the desktop build stays free software throughout.
        androidPkgs = import nixpkgs {
          inherit system;
          overlays = [ (import rust-overlay) ];
          config = {
            allowUnfree = true;
            android_sdk.accept_license = true;
          };
        };
        # Must match what the Gradle project in src-tauri/gen/android asks for:
        # the SDK in the Nix store is read-only, so Gradle can't fetch more.
        androidBuildTools = "35.0.0";
        androidComposition = androidPkgs.androidenv.composeAndroidPackages {
          platformVersions = [ "36" ];
          buildToolsVersions = [ androidBuildTools ];
          includeNDK = true;
          ndkVersions = [ "27.2.12479018" ];
          includeEmulator = false;
          includeSystemImages = false;
        };
        androidSdk = androidComposition.androidsdk;
        androidRust = androidPkgs.rust-bin.stable.latest.default.override {
          # aarch64 for phones; x86_64 for the emulator; the 32-bit pair for
          # old devices, built only when asked for.
          targets = [
            "aarch64-linux-android"
            "x86_64-linux-android"
            "armv7-linux-androideabi"
            "i686-linux-android"
          ];
        };

        # Native libraries Tauri (GTK3 + WebKitGTK) and libmpv link against.
        libs = with pkgs; [
          gtk3
          webkitgtk_4_1
          libsoup_3
          glib
          glib-networking
          cairo
          pango
          gdk-pixbuf
          atk
          librsvg
          openssl
          mpv-unwrapped
          libGL
          libepoxy
        ];

        beyt = pkgs.rustPlatform.buildRustPackage (finalAttrs: {
          pname = "beyt";
          version = "0.21.0";
          # Flakes only see files tracked by git, so samples/, data/ and
          # build output stay out of the build.
          src = ./.;

          cargoRoot = "src-tauri";
          buildAndTestSubdir = "src-tauri";
          cargoLock.lockFile = ./src-tauri/Cargo.lock;

          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            inherit pnpm;
            fetcherVersion = 4;
            hash = "sha256-93puEZ+yIf2K0CZFfVtrusl2GWmzUV6lNzJ61p+UnJk=";
          };

          nativeBuildInputs = with pkgs; [
            nodejs
            pnpm
            pnpmConfigHook
            pkg-config
            wrapGAppsHook3
            makeWrapper
          ];
          buildInputs = libs;

          # tauri-build embeds ../dist, so the frontend is built first.
          preBuild = ''
            pnpm build
          '';

          # Only the player itself; the dictionary builder is a dev tool.
          cargoBuildFlags = [ "--bin" "beyt" ];
          # Tests need mpv and a display; they run in the dev shell instead.
          doCheck = false;

          postInstall = ''
            # Launchers don't always have the profile's bin/ on PATH, so the
            # entry points at the binary by absolute path.
            install -Dm644 packaging/beyt.desktop $out/share/applications/beyt.desktop
            substituteInPlace $out/share/applications/beyt.desktop \
              --replace-fail "Exec=beyt " "Exec=$out/bin/beyt "
            install -Dm644 src-tauri/icons/icon.png $out/share/icons/hicolor/512x512/apps/beyt.png
          '';

          # ffmpeg/ffprobe extract embedded subtitles and cut audio clips;
          # libEGL is loaded at runtime for mpv's OpenGL rendering.
          preFixup = ''
            gappsWrapperArgs+=(
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.ffmpeg ]}
              --prefix LD_LIBRARY_PATH : ${pkgs.lib.makeLibraryPath [ pkgs.libGL ]}
            )
          '';

          meta = {
            description = "Video player for language learning with two subtitles at once";
            license = pkgs.lib.licenses.gpl3Plus;
            mainProgram = "beyt";
            platforms = pkgs.lib.platforms.linux;
          };
        });
      in
      {
        packages.default = beyt;
        packages.beyt = beyt;

        apps.default = {
          type = "app";
          program = "${beyt}/bin/beyt";
        };

        devShells.default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            pkg-config
            wrapGAppsHook3
            rustc
            cargo
            clippy
            rustfmt
            rust-analyzer
            cargo-tauri
            ffmpeg
            # scripts/build-dictionary.sh. The system curl breaks here: LD_LIBRARY_PATH
            # pulls in this nixpkgs' glibc libraries, which it wasn't built against.
            curl
            nodejs
            typescript
            pnpm
            # scripts/make-icons.sh: renders the icon SVGs, Persian text included.
            librsvg
          ];
          buildInputs = libs;

          # libmpv's render API and WebKitGTK load GL/EGL and GIO modules at runtime.
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath libs;
          GIO_MODULE_DIR = "${pkgs.glib-networking}/lib/gio/modules/";
          XDG_DATA_DIRS = "${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}";
        };

        # `nix develop .#android`, then scripts/build-android.sh.
        devShells.android = androidPkgs.mkShell {
          nativeBuildInputs = [
            androidRust
            androidSdk
            pkgs.cargo-tauri
            pkgs.nodejs
            pnpm
            pkgs.jdk17
          ];

          ANDROID_HOME = "${androidSdk}/libexec/android-sdk";
          ANDROID_SDK_ROOT = "${androidSdk}/libexec/android-sdk";
          NDK_HOME = "${androidSdk}/libexec/android-sdk/ndk-bundle";
          JAVA_HOME = pkgs.jdk17.home;
          # Gradle's own aapt2 download is linked for other distributions and
          # won't start on NixOS; use the SDK's.
          GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${androidSdk}/libexec/android-sdk/build-tools/${androidBuildTools}/aapt2";
        };
      });
}
