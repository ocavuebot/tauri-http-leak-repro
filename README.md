# tauri-plugin-http leak repro

A minimal Tauri 2 app that compares the webview's native `fetch` with `fetch` from `@tauri-apps/plugin-http`. It checks what happens to a response whose body is never read, and to a `204` response.

Versions: `tauri` 2.12.4, `tauri-plugin-http` 2.8.3 (the latest release, with the `unsafe-headers` feature), macOS WKWebView.

## How it works

- `server.mjs`: a Node HTTP server. `GET /body?size=N` answers 200 with N bytes. `GET /empty` answers 204. It counts accepted, open, and reused TCP connections. The counts are served on a second port, so reading them adds no connection.
- `dist/main.js`: the page. It runs one scenario: N sequential requests with `fetch` (native) or the plugin's `fetch`, and then it reads the body, ignores it, or calls `res.body.cancel()`. It takes snapshots before the loop, at the end, and after 8 s idle plus forced GC (and after `location.reload()` in the reload scenario).
- `src-tauri/src/main.rs`: app commands that the page calls to take a snapshot:
  - `resources`: counts the entries in the webview's `ResourceTable`, by type (`ReqwestResponse` is the plugin's response).
  - `snapshot`: the app's RSS and open file descriptors, the client side of each established socket to the server (`lsof`), grouped by process (`app` or `com.apple.WebKit.Networking`), and the server's counters.
- `run.mjs`: starts a fresh server and a fresh app process for each scenario, and writes `results/<scenario>.json`.
- `summarize.mjs`: prints a Markdown table from `results/`.

## Run

```bash
cd src-tauri && CARGO_TARGET_DIR=/tmp/tauri-http-leak-target cargo build --release && cd ..
node run.mjs                 # every scenario, about 6 minutes
node run.mjs plugin-204 ka60 # only scenarios whose name contains a filter
node summarize.mjs
```

The window must stay unthrottled while it runs. `tauri.conf.json` sets `backgroundThrottling: "disabled"`, because WebKit otherwise pauses timers in a background window.

`fd256-*` scenarios run the app with `ulimit -n 256`. This is the soft limit that launchd gives an app opened from Finder or the Dock (`launchctl limit maxfiles`).
