use crate::fsops::Drive;
use crate::util::*;
use std::fs::Metadata;
use std::time::SystemTime;

pub fn init() {}

pub fn is_hidden(_md: &Metadata, name: &str) -> bool {
    name.starts_with('.')
}

pub fn list_drives() -> Vec<Drive> {
    vec![Drive { name: "File system".into(), path: "/".into(), kind: "fixed".into() }]
}

pub fn trash_paths(data_dir: &str, paths: &[String]) -> ApiResult<()> {
    crate::fsops::trash_fallback(data_dir, paths)
}

pub fn open_path(path: &str, reveal: bool) -> ApiResult<()> {
    let is_dir = std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false);
    let (cmd, target) = if cfg!(target_os = "macos") {
        ("open", path.to_string())
    } else {
        ("xdg-open", if reveal && !is_dir { dir_name(path) } else { path.to_string() })
    };
    let mut c = std::process::Command::new(cmd);
    if cfg!(target_os = "macos") && reveal {
        c.arg("-R");
    }
    c.arg(target);
    match c.spawn() {
        Ok(mut ch) => {
            std::thread::spawn(move || ch.wait());
            Ok(())
        }
        Err(e) => bad(e.to_string()),
    }
}

pub fn autostart_get() -> bool {
    false
}

pub fn autostart_set(_on: bool) -> ApiResult<()> {
    bad("starting with the computer is only available on Windows")
}

pub fn pick_folder() -> ApiResult<String> {
    Err(ApiErr::Code(501, "the folder picker only works on Windows - type the folder path instead".into()))
}

/// Development stand-in for Windows' "downloaded from the internet" mark: a text file
/// "<file>:Zone.Identifier" next to the picture.
pub fn has_web_mark(path: &str) -> bool {
    std::fs::read_to_string(format!("{path}:Zone.Identifier")).map(|s| s.contains("ZoneId=3")).unwrap_or(false)
}

pub fn remove_web_mark(path: &str) {
    let _ = std::fs::remove_file(format!("{path}:Zone.Identifier"));
}

pub fn created_at(md: &Metadata) -> SystemTime {
    md.modified().unwrap_or(SystemTime::UNIX_EPOCH)
}

/// Stand-in for the whole-drive watcher: polls TAGSHELF_WATCH_ROOT (tests only).
pub fn start_drive_watch(w: std::sync::Arc<crate::watch::Watcher>) {
    let Ok(root) = std::env::var("TAGSHELF_WATCH_ROOT") else { return };
    if root.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        let mut known = std::collections::HashSet::new();
        let mut first = true;
        loop {
            let mut stack = vec![root.clone()];
            while let Some(d) = stack.pop() {
                let Ok(rd) = std::fs::read_dir(&d) else { continue };
                for de in rd.flatten() {
                    let p = de.path().to_string_lossy().into_owned();
                    if de.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        stack.push(p);
                    } else if !p.ends_with(":Zone.Identifier") && known.insert(p.clone()) && !first {
                        w.note_file(&p);
                    }
                }
            }
            first = false;
            if w.stopped() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
}
