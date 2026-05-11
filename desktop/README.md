# Nova Desktop

Lightweight cross-platform desktop shell for Nova built with [Tauri 2](https://tauri.app/).

The desktop app does **not** change the existing web architecture. It opens
`https://novagptapp.com` inside a small native window so users can use Nova as a
sticky-note-like assistant on Windows, macOS, and Linux while everything served
from GKE keeps working unchanged.

## What it adds

- ~5–15 MB native installer per platform
- Small "sticky note" sized window (380x560, resizable) pointing at `novagptapp.com`
- System tray icon (Show / Hide / Toggle always on top / Quit)
- Global hotkey `Ctrl/Cmd+Shift+Space` to toggle visibility
- Optional autostart on login (Tauri `autostart` plugin)
- Closing the window only hides it; the app stays in the tray

## Repository layout

```
desktop/
  package.json              Tauri CLI + helper scripts
  dist/index.html           Fallback page (redirects to novagptapp.com)
  scripts/
    source.svg              Branded source artwork for the app icon
    generate-icons.mjs      Builds the source PNG and runs `tauri icon`
  src-tauri/
    Cargo.toml              Rust dependencies
    tauri.conf.json         Window, bundle, plugin configuration
    capabilities/           Tauri 2 permission capabilities
    src/main.rs             Binary entry point
    src/lib.rs              App setup: tray, hotkey, plugins, window events
    icons/                  Generated icon assets (gitignored)
```

## Local development

Prerequisites:

- Node.js 20+
- Rust stable (`rustup`)
- Platform build deps (Linux: `libgtk-3-dev libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`)

```bash
cd desktop
npm install
npm run icons     # one-time icon generation
npm run dev       # launches Tauri in dev mode
```

`npm run dev` opens a window pointed at `https://novagptapp.com` so login,
chat, and conversations all flow through the production backend.

## Production build (single platform)

```bash
cd desktop
npm install
npm run icons
npm run build
```

Bundles land under `src-tauri/target/release/bundle/`.

## Cross-platform installers

Releases for Windows, macOS (arm64 + x86_64), and Linux are produced by the
GitHub Actions workflow [`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml).

- Manually trigger with **Actions → Desktop release → Run workflow**, or
- Push a tag matching `desktop-v*` to publish a GitHub Release with installers
  attached.

## Authentication notes

- **Email/password** works exactly as on the web because the desktop window
  hits `novagptapp.com` directly and uses the same `nova_session` cookie set
  by [backend/main.py](../backend/main.py).
- **Google / GitHub OAuth**: embedded webviews are restricted by Google. For
  v1 use the email/password sign-in inside the desktop app and reserve OAuth
  for the browser at `novagptapp.com`. A future v2 task will add deep-link
  OAuth (custom URL scheme `novagptapp://auth/callback`).

## Roadmap (post v1)

- Code signing (Windows EV cert, Apple Developer ID + notarization)
- Tauri auto-updater so users get patches without re-downloading
- Deep-link OAuth handler for Google/GitHub sign-in inside the desktop window
- Native screenshot/snip command (replace `getDisplayMedia` flow inside the
  embedded webview)

## What stays unchanged

- All API endpoints in [backend/main.py](../backend/main.py)
- The React web frontend in [frontend/](../frontend)
- GKE deployment, Cloud SQL, Vertex AI, ingress, secrets — everything in
  [infra/](../infra)
