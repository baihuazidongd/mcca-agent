# Desktop shell (Tauri v2)

A native window around the portal. The Rust side does one thing: open a WebView2
window pointed at the portal's localhost page, and start the portal if nothing
is listening on it yet. All behaviour lives in `packages/portal` (Node), and dsh,
pi and the portal stay three separate processes, so a crash in one does not take
the app down.

## Status

Verified on Windows with rustup stable-msvc 1.98.0:

- `cargo check` compiles the crate and its Tauri dependencies.
- `tauri build --no-bundle` produces `src-tauri/target/release/pdb-desktop.exe`.
- The executable opens a window titled `pdb` that loads the portal.
- When a portal is already listening on 127.0.0.1:3470, the shell only opens the
  window; it does not start a second portal.

Not verified: macOS and Linux builds, and the bundled installers
(`tauri build` also emits .msi/.nsis on Windows with `--bundle`).

## Requirements

- The portal's own requirements: Node `^22.19.0 || >=24.0.0` and pnpm.
- A Rust toolchain. On Windows that means rustup with the MSVC toolchain plus the
  Visual Studio Build Tools C++ workload; WebView2 is present on Windows 10/11
  already. On Linux and macOS, follow the Tauri v2 prerequisites for your
  platform.

## Build and run

```bash
pnpm install

# 1. start the portal (the shell would start it for you, but the logs are easier
#    to read when you run it yourself)
node packages/portal/server.cjs

# 2. build and run the shell
pnpm --filter pdb-desktop tauri build --no-bundle
./src-tauri/target/release/pdb-desktop.exe     # Windows
```

`pnpm --filter pdb-desktop tauri dev` runs it against a dev server instead.

## Notes

- The window URL is `app.windows[0].url` in `src-tauri/tauri.conf.json`. It points
  at the portal, so the shell shows whatever the portal serves.
- `build.frontendDist` must name an existing directory even though the window
  loads a URL: `desktop/dist/index.html` is that placeholder and is committed on
  purpose. It is the one `dist/` in this repository that is not build output.
- Icons come from `icon-source.png`; regenerate them with
  `pnpm --filter pdb-desktop tauri icon icon-source.png`. `scripts/gen-icon.mjs`
  produces the source PNG.
- Capabilities are declared in `src-tauri/capabilities/default.json`. Tray icons,
  file dialogs, single-instance locks and similar need their permissions added
  there.
