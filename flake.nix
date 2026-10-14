{
  description = "Beyt — a dual-subtitle video player for language learning";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        # Pinned to a major version: pnpm's store format changes between majors.
        pnpm = pkgs.pnpm_11;

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
          version = "0.8.0";
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
            nodejs
            typescript
            pnpm
          ];
          buildInputs = libs;

          # libmpv's render API and WebKitGTK load GL/EGL and GIO modules at runtime.
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath libs;
          GIO_MODULE_DIR = "${pkgs.glib-networking}/lib/gio/modules/";
          XDG_DATA_DIRS = "${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}";
        };
      });
}
