//! `tagshelf-server`: TagShelf without its own window. Opens the interface in Edge/Chrome app mode
//! (like TagShelf 2), or with --no-window just prints the address (used by the automated tests).

use std::sync::atomic::Ordering;
use std::sync::Arc;
use tagshelf_core::server::Shell;
use tagshelf_core::util::*;
use tagshelf_core::{call_instance, Options, Started};

struct BrowserShell {
    data_dir: String,
    no_window: bool,
}

fn find_browser() -> Option<String> {
    if IS_WIN {
        let rels = [r"Microsoft\Edge\Application\msedge.exe", r"Google\Chrome\Application\chrome.exe", r"BraveSoftware\Brave-Browser\Application\brave.exe"];
        for rel in rels {
            for env in ["ProgramFiles(x86)", "ProgramFiles", "LocalAppData"] {
                if let Ok(base) = std::env::var(env) {
                    let p = join(&base, rel);
                    if std::path::Path::new(&p).exists() {
                        return Some(p);
                    }
                }
            }
        }
        return None;
    }
    let path = std::env::var("PATH").unwrap_or_default();
    for n in ["microsoft-edge", "google-chrome", "chromium", "chromium-browser"] {
        for d in path.split(':') {
            let p = join(d, n);
            if std::path::Path::new(&p).exists() {
                return Some(p);
            }
        }
    }
    None
}

fn launch_app(profile: &str, url: &str, size: &str) -> bool {
    let Some(exe) = find_browser() else { return false };
    std::process::Command::new(exe)
        .args([format!("--app={url}"), format!("--user-data-dir={profile}"), "--no-first-run".into(), "--no-default-browser-check".into(), format!("--window-size={size}")])
        .spawn()
        .is_ok()
}

impl Shell for BrowserShell {
    fn open_window(&self, url: &str) {
        if self.no_window {
            println!("{url}");
            return;
        }
        if !launch_app(&join(&self.data_dir, "browser"), url, "1500,920") {
            let _ = tagshelf_core::platform::open_path(url, false);
        }
    }
    fn open_popup(&self, url: &str) {
        if self.no_window {
            eprintln!("POPUP {url}");
            return;
        }
        if !launch_app(&join(&self.data_dir, "browser-popup"), url, "640,860") {
            self.open_window(url);
        }
    }
}

fn main() {
    let mut data = None;
    let (mut no_window, mut background, mut quit, mut port) = (false, false, false, 47821u16);
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].trim_start_matches('-');
        let (k, inline) = match a.split_once('=') {
            Some((k, v)) => (k.to_string(), Some(v.to_string())),
            None => (a.to_string(), None),
        };
        let mut val = || inline.clone().or_else(|| {
            i += 1;
            args.get(i).cloned()
        });
        match k.as_str() {
            "data" => data = val(),
            "port" => port = val().and_then(|v| v.parse().ok()).unwrap_or(port),
            "no-window" => no_window = true,
            "background" => background = true,
            "quit" => quit = true,
            "version" => {
                println!("tagshelf-server {}", tagshelf_core::version());
                return;
            }
            _ => {}
        }
        i += 1;
    }
    let data_dir = data.clone().unwrap_or_else(tagshelf_core::default_data_dir);
    let shell = Arc::new(BrowserShell { data_dir: data_dir.clone(), no_window });
    if quit {
        if let Some(inst) = tagshelf_core::read_instance(&data_dir) {
            call_instance(&inst, "POST", "/api/quit", std::time::Duration::from_secs(3));
        }
        return;
    }
    let started = match tagshelf_core::start(Options { data_dir: Some(data_dir), port, background }, shell.clone()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let srv = match started {
        Started::Existing(inst) => {
            if !background {
                shell.open_window(&inst.url());
            }
            return;
        }
        Started::Running(s) => s,
    };
    if no_window {
        println!("{}", srv.url());
    } else if !background {
        shell.open_window(&srv.url());
        tagshelf_core::watchdog(srv.clone());
    }
    if background {
        tagshelf_core::watchdog(srv.clone());
    }
    use std::io::Write;
    let _ = std::io::stdout().flush();
    while !srv.quit.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    tagshelf_core::shutdown(&srv);
}
