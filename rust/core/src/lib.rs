//! TagShelf core: everything except the window. Runs a local HTTP API that the web interface
//! (embedded from ../../web) talks to. Used by the Tauri app and by the plain `tagshelf-server`.

pub mod ai;
pub mod covers;
pub mod dims;
pub mod dups;
pub mod fsops;
pub mod http;
pub mod platform;
pub mod server;
pub mod shelf;
pub mod store;
pub mod thumbs;
pub mod util;
pub mod watch;

use serde::{Deserialize, Serialize};
use server::{Server, Shell};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;
use store::log;
use util::*;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub struct Options {
    pub data_dir: Option<String>,
    pub port: u16,
    pub background: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Instance {
    pub port: u16,
    pub token: String,
}

impl Instance {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/?t={}", self.port, self.token)
    }
}

pub enum Started {
    /// This process now runs TagShelf.
    Running(Arc<Server>),
    /// TagShelf was already running in another process.
    Existing(Instance),
}

pub fn default_data_dir() -> String {
    let base = if IS_WIN {
        std::env::var("APPDATA").ok()
    } else if cfg!(target_os = "macos") {
        home_dir().map(|h| join(&h, "Library/Application Support"))
    } else {
        std::env::var("XDG_CONFIG_HOME").ok().filter(|s| !s.is_empty()).or_else(|| home_dir().map(|h| join(&h, ".config")))
    };
    join(&base.unwrap_or_else(|| ".".into()), "TagShelf")
}

fn instance_path(dir: &str) -> String {
    join(dir, "instance.json")
}

pub fn read_instance(dir: &str) -> Option<Instance> {
    let b = std::fs::read(instance_path(dir)).ok()?;
    let i: Instance = serde_json::from_slice(&b).ok()?;
    (i.port != 0 && !i.token.is_empty()).then_some(i)
}

fn remove_instance(dir: &str, mine: &Instance) {
    if let Some(cur) = read_instance(dir) {
        if cur.token == mine.token {
            let _ = std::fs::remove_file(instance_path(dir));
        }
    }
}

/// A tiny HTTP client for talking to another running TagShelf. Returns the status code.
pub fn call_instance(i: &Instance, method: &str, path: &str, timeout: Duration) -> Option<u16> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], i.port));
    let mut s = std::net::TcpStream::connect_timeout(&addr, timeout).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: tagshelf={}\r\nX-TagShelf: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        i.port, i.token
    );
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = [0u8; 64];
    let n = s.read(&mut buf).ok()?;
    let line = String::from_utf8_lossy(&buf[..n]);
    line.split_whitespace().nth(1)?.parse().ok()
}

pub fn ping_instance(i: &Instance) -> bool {
    call_instance(i, "GET", "/api/ping", Duration::from_millis(1500)) == Some(200)
}

/// Starts TagShelf (or finds the copy that is already running).
pub fn start(opts: Options, shell: Arc<dyn Shell>) -> Result<Started, String> {
    let data_dir = opts.data_dir.clone().filter(|s| !s.is_empty()).unwrap_or_else(default_data_dir);
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("cannot create data folder: {e}"))?;
    log::init(&data_dir);
    platform::init();

    if let Some(inst) = read_instance(&data_dir) {
        if ping_instance(&inst) {
            return Ok(Started::Existing(inst));
        }
    }

    let lib = store::Library::load(&data_dir).map_err(|e| format!("cannot load library: {e}"))?;
    ai::vecs().open(&data_dir);
    dims::open(&data_dir);

    let listener = std::net::TcpListener::bind(("127.0.0.1", opts.port))
        .or_else(|_| std::net::TcpListener::bind(("127.0.0.1", 0)))
        .map_err(|e| format!("cannot listen: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let inst = Instance { port, token: rand_hex(16) };
    let quit = Arc::new(AtomicBool::new(false));

    let slot: Arc<OnceLock<Weak<Server>>> = Arc::new(OnceLock::new());
    let slot2 = slot.clone();
    let watch = watch::Watcher::new(
        lib,
        &data_dir,
        quit.clone(),
        Box::new(move || {
            if let Some(s) = slot2.get().and_then(|w| w.upgrade()) {
                s.ensure_popup();
            }
        }),
    );
    let srv = Arc::new(Server {
        lib,
        ai: ai::Ai::new(lib),
        data_dir: data_dir.clone(),
        token: inst.token.clone(),
        port,
        bg_flag: opts.background,
        quit: quit.clone(),
        last_ping: AtomicI64::new(now_nanos()),
        bye_at: AtomicI64::new(0),
        popup_ping: AtomicI64::new(0),
        popup_last: AtomicI64::new(0),
        watch: watch.clone(),
        shell,
    });
    let _ = slot.set(Arc::downgrade(&srv));
    let _ = std::fs::write(instance_path(&data_dir), serde_json::to_vec(&inst).unwrap());
    let s2 = srv.clone();
    http::serve(listener, Arc::new(move |req| s2.handle(req)));
    log::info(&format!("TagShelf {} listening on 127.0.0.1:{port}", server::APP_VERSION));
    std::thread::spawn(move || lib.check_missing());
    watch.run();
    Ok(Started::Running(srv))
}

/// Saves everything and removes the instance marker. Call once when the app ends.
pub fn shutdown(srv: &Server) {
    srv.quit.store(true, Ordering::SeqCst);
    if let Err(e) = srv.lib.flush() {
        log::warn(&format!("final save failed: {e}"));
    }
    dims::save();
    if let Err(e) = ai::vecs().save() {
        log::warn(&format!("saving fingerprints failed: {e}"));
    }
    remove_instance(&srv.data_dir, &Instance { port: srv.port, token: srv.token.clone() });
    log::info("TagShelf stopped");
}

/// For browser windows only: quits once the window has gone (unless background mode is on).
pub fn watchdog(srv: Arc<Server>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        if srv.quit.load(Ordering::Relaxed) {
            return;
        }
        if srv.background_mode() {
            continue;
        }
        let now = now_nanos();
        let (last, bye) = (srv.last_ping.load(Ordering::Relaxed), srv.bye_at.load(Ordering::Relaxed));
        if bye != 0 && last < bye && now - bye > 8_000_000_000 {
            log::info("window closed");
            srv.request_quit();
            return;
        }
        if now - last > 300_000_000_000 {
            log::info("no window for 5 minutes");
            srv.request_quit();
            return;
        }
    });
}
