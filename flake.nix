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
      in
      {
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
          ];
          buildInputs = libs;

          # libmpv's render API and WebKitGTK load GL/EGL and GIO modules at runtime.
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath libs;
          GIO_MODULE_DIR = "${pkgs.glib-networking}/lib/gio/modules/";
          XDG_DATA_DIRS = "${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}";
        };
      });
}
