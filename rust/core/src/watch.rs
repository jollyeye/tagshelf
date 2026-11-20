//! Download watcher: notices finished picture/video downloads and offers them for tagging.
//! Two sources: the whole-drive watcher (Windows change notifications + the "downloaded from the
//! internet" mark) and plain polling of the folders listed in the settings.

use crate::platform;
use crate::store::Library;
use crate::util::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

#[derive(Serialize, Clone, Debug)]
pub struct Download {
    pub id: String,
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: i64,
    pub at: i64,
}

#[derive(Default, Clone, Copy)]
struct Cand {
    size: i64,
    mtime: i64,
    stable: i32,
}

struct EvCand {
    size: i64,
    mtime: i64,
    stable: i32,
    mark_tries: i32,
    first: Instant,
}

#[derive(Default)]
struct Inner {
    seen: HashSet<String>,
    baselined: HashSet<String>,
    cands: HashMap<String, Cand>,
    ev: HashMap<String, EvCand>,
    pending: Vec<Download>,
}

pub struct Watcher {
    lib: &'static Library,
    data_dir: String,
    inner: Mutex<Inner>,
    quit: Arc<AtomicBool>,
    on_new: Box<dyn Fn() + Send + Sync>,
}

fn media(ext: &str) -> Option<&'static str> {
    let k = kind_of(ext);
    if (k == "image" || k == "video") && ext != ".svg" {
        Some(k)
    } else {
        None
    }
}

impl Watcher {
    pub fn new(lib: &'static Library, data_dir: &str, quit: Arc<AtomicBool>, on_new: Box<dyn Fn() + Send + Sync>) -> Arc<Watcher> {
        Arc::new(Watcher { lib, data_dir: data_dir.to_string(), inner: Mutex::new(Inner::default()), quit, on_new })
    }

    fn g(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn stopped(&self) -> bool {
        self.quit.load(Ordering::Relaxed)
    }

    pub fn pending(&self) -> Vec<Download> {
        self.g().pending.iter().filter(|d| exists(&d.path)).cloned().collect()
    }

    pub fn find(&self, id: &str) -> Option<Download> {
        self.g().pending.iter().find(|d| d.id == id).cloned()
    }

    pub fn drop_item(&self, id: &str, all: bool) {
        let mut g = self.g();
        if all {
            g.pending.clear();
        } else if let Some(i) = g.pending.iter().position(|d| d.id == id) {
            g.pending.remove(i);
        }
    }

    pub fn run(self: &Arc<Self>) {
        platform::start_drive_watch(self.clone());
        let me = self.clone();
        std::thread::spawn(move || {
            while !me.stopped() {
                std::thread::sleep(Duration::from_millis(1500));
                me.scan();
            }
        });
    }

    fn dirs(&self) -> Vec<String> {
        let p = self.lib.prefs();
        if !p.watch_downloads {
            return vec![];
        }
        if !p.watch_dirs.is_empty() {
            return p.watch_dirs;
        }
        if !p.no_drive_watch {
            return vec![]; // the whole drive is watched instead of one default folder
        }
        let d = default_downloads();
        if d.is_empty() {
            vec![]
        } else {
            vec![d]
        }
    }

    fn scan(&self) {
        let dirs = self.dirs();
        let mut fresh = vec![];
        {
            let mut g = self.g();
            for d in dirs {
                let Ok(rd) = std::fs::read_dir(&d) else { continue };
                let base = !g.baselined.contains(&d);
                for de in rd.flatten() {
                    if de.file_type().map(|t| t.is_dir()).unwrap_or(true) {
                        continue;
                    }
                    let name = de.file_name().to_string_lossy().into_owned();
                    let Some(k) = media(&lower_ext(&name)) else { continue };
                    let p = join(&d, &name);
                    if base {
                        g.seen.insert(p);
                        continue;
                    }
                    if g.seen.contains(&p) {
                        continue;
                    }
                    let Ok(md) = de.metadata() else { continue };
                    let (size, mt) = (md.len() as i64, nanos_of(md.modified()));
                    let mut c = g.cands.get(&p).copied().unwrap_or_default();
                    if c.size == size && c.mtime == mt && c.size > 0 {
                        c.stable += 1;
                    } else {
                        c = Cand { size, mtime: mt, stable: 0 };
                    }
                    if c.stable >= 2 {
                        g.cands.remove(&p);
                        g.seen.insert(p.clone());
                        fresh.push(Download { id: rand_hex(6), path: p, name, kind: k.into(), size, at: now_unix() });
                    } else {
                        g.cands.insert(p, c);
                    }
                }
                g.baselined.insert(d);
            }
            fresh.extend(self.settle_events(&mut g));
            if !fresh.is_empty() {
                fresh.sort_by(|a, b| a.name.cmp(&b.name));
                g.pending.extend(fresh.iter().cloned());
            }
        }
        if !fresh.is_empty() {
            crate::store::log::info(&format!("{} new download(s) detected", fresh.len()));
            (self.on_new)();
        }
    }

    fn drive_on(&self) -> bool {
        let p = self.lib.prefs();
        p.watch_downloads && !p.no_drive_watch
    }

    /// Called by the whole-drive watcher for every file that appeared or was renamed into place.
    pub fn note_file(&self, p: &str) {
        if media(&lower_ext(p)).is_none() || excluded_path(p, &self.data_dir) || !self.drive_on() {
            return;
        }
        let mut g = self.g();
        if g.seen.contains(p) || g.ev.contains_key(p) || g.ev.len() > 5000 {
            return;
        }
        g.ev.insert(p.to_string(), EvCand { size: 0, mtime: 0, stable: 0, mark_tries: 0, first: Instant::now() });
    }

    fn settle_events(&self, g: &mut Inner) -> Vec<Download> {
        let mut out = vec![];
        let keys: Vec<String> = g.ev.keys().cloned().collect();
        for p in keys {
            let md = std::fs::metadata(&p);
            let c = g.ev.get_mut(&p).unwrap();
            let md = match md {
                Ok(m) if !m.is_dir() => m,
                _ => {
                    if c.first.elapsed() > Duration::from_secs(30) {
                        g.ev.remove(&p); // renamed away or removed
                    }
                    continue;
                }
            };
            let (size, mt) = (md.len() as i64, nanos_of(md.modified()));
            if c.size == size && c.mtime == mt && c.size > 0 {
                c.stable += 1;
            } else {
                c.size = size;
                c.mtime = mt;
                c.stable = 0;
            }
            if c.stable < 2 {
                if c.first.elapsed() > Duration::from_secs(1800) {
                    g.ev.remove(&p);
                }
                continue;
            }
            let age = SystemTime::now().duration_since(platform::created_at(&md)).unwrap_or_default();
            if age > Duration::from_secs(12 * 3600) || self.lib.lookup(&p).is_some() {
                g.ev.remove(&p); // an old file that was only moved around, or one that already has tags
                continue;
            }
            if !platform::has_web_mark(&p) {
                // the browser may add the mark a moment after the file is in place
                c.mark_tries += 1;
                if c.mark_tries > 12 {
                    g.ev.remove(&p);
                }
                continue;
            }
            g.ev.remove(&p);
            g.seen.insert(p.clone());
            let k = media(&lower_ext(&p)).unwrap_or("image");
            out.push(Download { id: rand_hex(6), name: base_name(&p), path: p, kind: k.into(), size, at: now_unix() });
        }
        out
    }
}

/// Keeps system folders, app caches and TagShelf's own data out of the whole-drive watch.
pub fn excluded_path(p: &str, data_dir: &str) -> bool {
    let q = to_lower(&p.replace('\\', "/"));
    if !data_dir.is_empty() && q.starts_with(&format!("{}/", to_lower(&data_dir.replace('\\', "/")))) {
        return true;
    }
    ["/windows/", "/$recycle.bin/", "/system volume information/", "/appdata/", "/program files", "/programdata/"].iter().any(|b| q.contains(b))
}
