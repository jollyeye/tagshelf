# TagShelf - developer notes (for future sessions)

Portable Windows file browser where every file can have many tags. Owner: jollyeye. Version 2.0.

## Architecture
- **Go 1.24, stdlib only** (CGO_ENABLED=0). A local HTTP server + embedded web UI (`//go:embed web/*`).
- The UI opens in Edge/Chrome `--app` mode (`launchApp` in main.go). Cross-compiled for windows/amd64 with `-H=windowsgui`.
- Build: see BUILD.txt. Test binary on Linux: `go build -o ts .` then `./ts --no-window --data /tmp/x`.
- Flags: `--data DIR`, `--no-window`, `--background`, `--port N`.

## Backend files
- main.go: flags, watchdog (quits ~8s after the window says bye unless background mode), single instance (instance.json).
- server.go: all routes, security guard (Host check, per-launch token cookie, `X-TagShelf: 1` header on POSTs), static files.
- store.go: library.json (v2). Sparse per-file records keyed by sha1(path), only for files with tags/ratings. Also tags, views, pins, prefs, rejected suggestions. Migrates v1 (keeps backup library.v1.backup.json).
- fsops.go: list/tree/mkdir/rename/move/copy/trash/open. Tags follow in-app moves; outside moves are relinked by name|size|mtime.
- ai.go: suggestions. NOT a neural net: 152-dim image fingerprint (computed in the browser, stored in vectors.bin) -> kNN over tagged files + file/folder name words + tag co-occurrence. Needs ~6 tagged files. Suggest-only; rejections are remembered.
- watch.go: download watcher. Two sources: (a) whole-drive mode (default, pref `noDriveWatch=false`): watch_windows.go uses ReadDirectoryChangesW on every fixed/removable drive for new/renamed-in media files; a file is offered after it is size/mtime stable for 2 ticks AND has a Zone.Identifier stream with ZoneId=3/4 (Mark of the Web), was created <12h ago, is untagged, and is not under Windows/AppData/Program Files/TagShelf data. (b) folder polling of `watchDirs` (no mark needed; the default Downloads folder is only polled when whole-drive mode is off). watch_other.go is a Linux test stand-in (env TAGSHELF_WATCH_ROOT, `<file>:Zone.Identifier` sidecar file). Opens popup.html in a separate small window.
- dups.go: duplicate finder (size -> 64KiB head hash -> full SHA-1).
- thumbs.go, drives_*.go, hidden_*.go, proc_*.go: thumbnails and OS specifics (windows vs other).

## Frontend (web/, plain JS globals, no modules, no build step)
index.html loads: common, ui, state, nav, content, side, viewer, dialogs, downloads, main. popup.html loads common, ui, state, downloads, popup.
- state.js: global `S`, navigation, filtering, undo, tag helpers.
- nav.js: left tree. content.js: toolbar and file grid/list, selection, drag and drop, file ops.
- side.js: right panel (Tags tab and Filter tab). viewer.js: image/video viewer.
- dialogs.js: settings, tag manager, duplicates, batch rename, review, similar, help. downloads.js + popup.js: the download tag popup.

- tray_windows.go: system tray icon (raw Win32: hidden window + Shell_NotifyIcon, icon drawn in memory). Click = open window, right-click = Open/Quit. Never run on real Windows yet.
- Download popup (web/downloads.js): grid of all pending downloads with click/Ctrl/Shift/rubber-band selection; /api/downloads/done and /skip accept `IDs` for batch tagging/moving.
- Windows quirks learned: never start explorer.exe with hideWindow (the window stays invisible); open files with ShellExecute after claimForeground(); a click right after a rubber-band drag must not clear the selection.

## Data
Windows: %AppData%\TagShelf (library.json, thumbs\, vectors.bin). Recycle Bin via PowerShell SendToRecycleBin.

## Known limits
- Whole-drive watch (ReadDirectoryChangesW + Zone.Identifier) was only tested with the Linux stand-in; the Windows code compiles but has never run.
- Never run on real Windows by the author (tested on Linux + Windows cross-compile only). Untested there: Recycle Bin, autostart (HKCU Run), reveal in Explorer, app window, download popup.
- Downloads made while the app is not running are not offered later.
- The AI is lightweight; no neural model could be downloaded in the dev sandbox.

## Ideas / planned
- Full rebuild with extra features; the owner may supply a PDF spec (put it in docs/).
