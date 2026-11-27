//! The local HTTP API used by the interface. Same routes, inputs and outputs as the Go version.

use crate::ai::{vecs, Ai};
use crate::http::*;
use crate::store::{Library, Pair};
use crate::util::*;
use crate::watch::Watcher;
use crate::{ctypes, covers, dups, fsops, platform, shelf, thumbs};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

mod web {
    include!(concat!(env!("OUT_DIR"), "/web_files.rs"));
}

pub const APP_VERSION: &str = "3.0";

/// What the app around the server (a Tauri window, or a plain browser) must do on request.
pub trait Shell: Send + Sync {
    fn open_window(&self, url: &str);
    fn open_popup(&self, url: &str);
    /// The window ("show") request from a second start of the app.
    fn show(&self, url: &str) {
        self.open_window(url)
    }
}

pub struct Server {
    pub lib: &'static Library,
    pub ai: Ai,
    pub data_dir: String,
    pub token: String,
    pub port: u16,
    pub bg_flag: bool,
    pub quit: Arc<AtomicBool>,
    pub last_ping: AtomicI64,
    pub bye_at: AtomicI64,
    pub popup_ping: AtomicI64,
    pub popup_last: AtomicI64,
    pub watch: Arc<Watcher>,
    pub shell: Arc<dyn Shell>,
}

fn ok() -> Value {
    json!({ "ok": true })
}

impl Server {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/?t={}", self.port, self.token)
    }
    pub fn popup_url(&self) -> String {
        format!("http://127.0.0.1:{}/popup.html?t={}", self.port, self.token)
    }

    pub fn request_quit(&self) {
        self.quit.store(true, Ordering::SeqCst);
    }

    pub fn background_mode(&self) -> bool {
        self.bg_flag || self.lib.prefs().background
    }

    /// Opens the small tag-picker window unless one is already showing.
    pub fn ensure_popup(&self) {
        let now = now_nanos();
        if now - self.popup_ping.load(Ordering::Relaxed) < 6_000_000_000 || now - self.popup_last.load(Ordering::Relaxed) < 10_000_000_000 {
            return;
        }
        self.popup_last.store(now, Ordering::Relaxed);
        self.shell.open_popup(&self.popup_url());
    }

    pub fn handle(&self, mut req: Request) -> Resp {
        let dbg = std::env::var_os("TAGSHELF_DEBUG").is_some();
        if dbg {
            eprintln!("REQ {} {}", req.method, req.url);
        }
        let url = Url::parse(&req.url);
        match self.guard(&req, &url) {
            Some(r) => r,
            None => self.route(&mut req, &url),
        }
    }

    /// Protects the local API from other web pages: the Host header must be ours (anti
    /// DNS-rebinding), the session cookie must match the per-launch token, and state-changing
    /// requests need a custom header.
    fn guard(&self, req: &Request, url: &Url) -> Option<Resp> {
        let host = get_header(req, "Host").unwrap_or_default();
        if host != format!("127.0.0.1:{}", self.port) && host != format!("localhost:{}", self.port) {
            return Some(text(403, "forbidden"));
        }
        let t = url.q("t");
        if !t.is_empty() && (url.path == "/" || url.path == "/popup.html") && ct_eq(&t, &self.token) {
            return Some(
                redirect(303, &url.path).with_header(hdr("Set-Cookie", &format!("tagshelf={}; Path=/; HttpOnly; SameSite=Strict", self.token))),
            );
        }
        match cookie(req, "tagshelf") {
            Some(c) if ct_eq(&c, &self.token) => {}
            _ => return Some(text(403, "Please open TagShelf from its own window (start TagShelf.exe).")),
        }
        let method = req.method.clone();
        if method != "GET" && url.path != "/api/bye" && get_header(req, "X-TagShelf").as_deref() != Some("1") {
            return Some(text(403, "forbidden"));
        }
        None
    }

    fn route(&self, req: &mut Request, url: &Url) -> Resp {
        let method = req.method.clone();
        let path = url.path.as_str();
        if method == "GET" {
            match path {
                "/file" => return self.file(req, url),
                "/thumb" => return self.thumb(req, url),
                p if !p.starts_with("/api/") => return self.static_file(p),
                _ => {}
            }
        }
        if method == "POST" && path == "/api/poster" {
            return self.poster(req, url);
        }
        if method == "POST" && path == "/api/cover/frame" {
            return self.frame_cover(req, url);
        }
        let body = std::mem::take(&mut req.body);
        let args = if body.iter().all(|b| b.is_ascii_whitespace()) {
            Args(json!({}))
        } else {
            match serde_json::from_slice::<Value>(&body) {
                Ok(v) => Args(v),
                Err(e) => return error(400, &e.to_string()),
            }
        };
        let res = match (method.as_str(), path) {
            ("GET", "/api/ping") => {
                self.last_ping.store(now_nanos(), Ordering::Relaxed);
                Ok(json!({"app": "tagshelf"}))
            }
            ("GET", "/api/popup/ping") => {
                self.popup_ping.store(now_nanos(), Ordering::Relaxed);
                Ok(ok())
            }
            ("POST", "/api/bye") => {
                self.bye_at.store(now_nanos(), Ordering::Relaxed);
                Ok(ok())
            }
            ("POST", "/api/quit") => {
                let q = self.quit.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(200));
                    q.store(true, Ordering::SeqCst);
                });
                Ok(ok())
            }
            ("POST", "/api/show") => {
                self.shell.show(&self.url());
                Ok(ok())
            }
            ("GET", "/api/state") => Ok(self.state()),
            ("GET", "/api/locations") => Ok(json!({"quick": fsops::quick_places(), "drives": platform::list_drives()})),
            ("GET", "/api/tree") => self.tree(url),
            ("GET", "/api/list") => self.list(url),
            ("POST", "/api/mkdir") => fsops::make_dir(&args.str("Parent"), &args.str("Name")).map(|p| json!({"path": p})),
            ("POST", "/api/rename") => {
                let from = args.str("Path");
                fsops::rename_entry(&from, &args.str("Name")).map(|np| {
                    self.lib.relocate(&[Pair { from, to: np.clone() }]);
                    json!({"path": np})
                })
            }
            ("POST", "/api/move") => clean_abs(&args.str("Dest")).map(|d| {
                let res = fsops::move_entries(self.lib, &args.strs("Paths"), &d);
                self.lib.add_recent_dir(&d);
                serde_json::to_value(res).unwrap()
            }),
            ("POST", "/api/copy") => clean_abs(&args.str("Dest")).map(|d| serde_json::to_value(fsops::copy_entries(self.lib, &args.strs("Paths"), &d)).unwrap()),
            ("POST", "/api/trash") => platform::trash_paths(&self.data_dir, &args.strs("Paths")).map(|_| {
                let lib = self.lib;
                std::thread::spawn(move || lib.check_missing());
                ok()
            }),
            ("POST", "/api/open") => {
                let p = args.str("Path");
                if !exists(&p) {
                    Err(ApiErr::NotFound("this folder or file no longer exists".into()))
                } else {
                    platform::open_path(&p, args.bool("Reveal")).map(|_| ok())
                }
            }
            ("POST", "/api/pick") => platform::pick_folder().map(|p| json!({"path": p})),
            ("POST", "/api/pin") => {
                self.lib.set_pin(&args.str("Path"), args.bool("On"));
                Ok(ok())
            }
            // tags
            ("POST", "/api/tags/apply") => {
                let (out, err) = self.lib.tag_paths(&args.strs("Paths"), &args.strs("Add"), &args.strs("Remove"));
                match err {
                    Some(e) if out.is_empty() => Err(e),
                    _ => Ok(json!({"tags": out, "all": self.lib.tag_list()})),
                }
            }
            ("POST", "/api/tags/set") => {
                let items = args.get("Items").and_then(|v| v.as_object()).cloned().unwrap_or_default();
                Ok(json!({"tags": self.lib.set_exact_tags(&items), "all": self.lib.tag_list()}))
            }
            ("POST", "/api/tags/under") => {
                let (tags, files) = self.lib.tags_under(&args.strs("Paths"));
                let tags: Vec<Value> = tags.into_iter().map(|(name, count)| json!({"name": name, "count": count})).collect();
                Ok(json!({"tags": tags, "files": files}))
            }
            ("POST", "/api/rate") => {
                self.lib.set_rating(&args.strs("Paths"), args.int("Rating"));
                Ok(ok())
            }
            ("POST", "/api/tag/create") => self.lib.create_tag(&args.str("Name")).map(|n| json!({"name": n, "all": self.lib.tag_list()})),
            ("POST", "/api/tag/rename") => self.lib.rename_tag(&args.str("From"), &args.str("To")).map(|_| json!({"all": self.lib.tag_list()})),
            ("POST", "/api/tag/delete") => {
                self.lib.delete_tag(&args.str("Name"));
                Ok(json!({"all": self.lib.tag_list()}))
            }
            ("POST", "/api/tag/color") => {
                self.lib.set_tag_color(&args.str("Name"), &args.str("Color"));
                Ok(json!({"all": self.lib.tag_list()}))
            }
            ("POST", "/api/views") => {
                if args.str("Name").trim().is_empty() {
                    bad("give the filter a name")
                } else {
                    self.lib.save_view(&args.str("Name"), args.get("State").cloned().unwrap_or(Value::Null));
                    Ok(json!({"views": self.lib.r().views}))
                }
            }
            ("POST", "/api/views/delete") => {
                self.lib.delete_view(&args.str("ID"));
                Ok(json!({"views": self.lib.r().views}))
            }
            ("POST", "/api/settings") => {
                self.lib.set_settings(args.0.clone());
                Ok(ok())
            }
            ("POST", "/api/prefs") => Ok(self.prefs(&args)),
            ("GET", "/api/missing") => Ok(json!({"files": self.lib.missing_list()})),
            ("POST", "/api/missing/purge") => Ok(json!({"purged": self.lib.purge_missing(&args.strs("IDs"))})),
            // suggestions
            ("POST", "/api/ai/need") => Ok(self.ai_need(&args)),
            ("POST", "/api/ai/vec") => Ok(self.ai_vec(&args)),
            ("POST", "/api/ai/suggest") => {
                let mut p = args.strs("Paths");
                p.truncate(200);
                Ok(serde_json::to_value(self.ai.suggest(&p, false)).unwrap())
            }
            ("POST", "/api/ai/reject") => {
                self.lib.reject(&args.strs("Paths"), &args.str("Tag"));
                Ok(ok())
            }
            ("POST", "/api/ai/queue") => {
                let mut lim = args.int("Limit");
                if lim <= 0 || lim > 100 {
                    lim = 20;
                }
                let (p, n) = self.ai.backlog(lim as usize);
                Ok(json!({"paths": p, "total": n, "vectors": vecs().count()}))
            }
            ("POST", "/api/ai/test") => Ok(serde_json::to_value(self.ai.test(300)).unwrap()),
            ("POST", "/api/ai/similar") => {
                let mut n = args.int("N");
                if n <= 0 || n > 100 {
                    n = 40;
                }
                let (items, need) = self.ai.find_similar(&args.str("Path"), n as usize);
                Ok(json!({"items": items, "need": need}))
            }
            // Shelf
            ("GET", "/api/shelf/home") => Ok(shelf::home(self.lib)),
            // content types: scenes, stories, series
            ("POST", "/api/ctype/set") => ctypes::set(self.lib, &args.strs("Paths"), &args.str("Type")).map(|m| json!({"types": m})),
            ("POST", "/api/ctype/noplay") => ctypes::set_noplay(self.lib, &args.strs("Paths"), args.bool("On")).map(|_| ok()),
            ("POST", "/api/ctype/detect") => ctypes::detect(self.lib, &args.str("Path")),
            ("POST", "/api/ctype/page") => ctypes::page(self.lib, &args.str("Type")),
            ("POST", "/api/game/options") => ctypes::game_options(self.lib, &args.str("Path")),
            ("POST", "/api/game/launch") => ctypes::game_launch(self.lib, &args.str("Path"), &args.str("Rel"), args.bool("Remember")),
            ("POST", "/api/ctype/twins") => ctypes::twins(self.lib, &args.str("Path")),
            ("POST", "/api/ctype/children") => ctypes::children(self.lib, &args.str("Path")),
            ("POST", "/api/play") => ctypes::playlist(self.lib, &args.str("Path")),
            ("POST", "/api/durations") => {
                ctypes::durations(&args);
                Ok(ok())
            }
            ("POST", "/api/shelf/tag") => shelf::tag_page(self.lib, &args.str("Name")),
            ("GET", "/api/categories") => Ok(json!({"categories": self.lib.r().categories})),
            ("POST", "/api/category/create") => shelf::create_category(self.lib, &args.str("Name"), &args.str("Color"), &args.str("Preset"))
                .map(|c| json!({"category": c, "categories": self.lib.r().categories})),
            ("POST", "/api/category/update") => shelf::update_category(self.lib, &args).map(|_| json!({"categories": self.lib.r().categories})),
            ("POST", "/api/category/delete") => {
                shelf::delete_category(self.lib, &args.str("ID"));
                Ok(json!({"categories": self.lib.r().categories, "all": self.lib.tag_list()}))
            }
            ("POST", "/api/category/order") => {
                shelf::order_categories(self.lib, &args.strs("IDs"));
                Ok(json!({"categories": self.lib.r().categories}))
            }
            ("POST", "/api/tag/category") => {
                let mut names = args.strs("Names");
                let one = args.str("Name");
                if !one.is_empty() {
                    names.push(one);
                }
                shelf::set_tag_category(self.lib, &names, &args.str("Category")).map(|_| json!({"all": self.lib.tag_list()}))
            }
            ("POST", "/api/shelf/tab/add") => shelf::tab_add(self.lib, &args.str("Name"), &args.str("Category"), &args.str("Label"), &args.str("Type")).map(|id| json!({"id": id})),
            ("POST", "/api/shelf/tab/update") => shelf::tab_update(self.lib, &args).map(|_| ok()),
            ("POST", "/api/shelf/tab/delete") => shelf::tab_delete(self.lib, &args.str("Name"), &args.str("ID")).map(|_| ok()),
            ("POST", "/api/shelf/tab/move") => shelf::tab_move(self.lib, &args.str("Name"), &args.str("ID"), args.int("Dir")).map(|_| ok()),
            ("POST", "/api/tag/picture") => shelf::set_tag_picture(self.lib, &args.str("Name"), &args.str("Kind"), &args.str("Image")).map(|_| ok()),
            ("POST", "/api/tag/cover") => shelf::set_tag_cover(self.lib, &args.str("Name"), &args.str("Image")).map(|_| ok()),
            ("POST", "/api/dups") => dups::find(self.lib, &args.str("Path"), args.bool("Sub"), args.bool("Hidden")),
            ("POST", "/api/covers") => Ok(covers::covers(self.lib, &args.strs("Folders"))),
            ("POST", "/api/folder/cover") => {
                let folder = args.str("Folder");
                let r = covers::set(self.lib, &folder, &args.str("Image"));
                if r.is_ok() {
                    self.drop_unused_frames();
                }
                r.map(|_| ok())
            }
            // downloads
            ("GET", "/api/downloads") => Ok(json!({"items": self.watch.pending()})),
            ("POST", "/api/downloads/done") => self.download_done(&args),
            ("POST", "/api/downloads/skip") => {
                self.watch.drop_item(&args.str("ID"), args.bool("All"));
                for id in args.strs("IDs") {
                    self.watch.drop_item(&id, false);
                }
                Ok(ok())
            }
            _ => return text(404, "404 page not found"),
        };
        match res {
            Ok(v) => json(&v),
            Err(e) => error(e.code(), e.msg()),
        }
    }

    fn state(&self) -> Value {
        let missing = self.lib.missing_count();
        let mut st = {
            let d = self.lib.r();
            json!({
                "pins": d.pins, "views": d.views, "settings": d.settings, "prefs": d.prefs,
                "recent": d.recent, "missing": missing, "categories": d.categories,
                "os": if IS_WIN { "windows" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" },
                "sep": SEP.to_string(), "version": APP_VERSION, "downloads": default_downloads(),
            })
        };
        st["tags"] = serde_json::to_value(self.lib.tag_list()).unwrap();
        st["vectors"] = json!(vecs().count());
        st["autostart"] = json!(platform::autostart_get());
        st["pending"] = json!(self.watch.pending().len());
        if let Some(h) = home_dir() {
            st["home"] = json!(h);
        }
        st
    }

    fn tree(&self, url: &Url) -> ApiResult<Value> {
        let p = clean_abs(&url.q("path"))?;
        let kids = fsops::tree_children(&p, url.q("hidden") == "1")?;
        Ok(json!({ "children": kids }))
    }

    fn list(&self, url: &Url) -> ApiResult<Value> {
        if let Some(tag) = url.q("path").strip_prefix("tag:") {
            return self.list_tag(tag);
        }
        let p = clean_abs(&url.q("path"))?;
        let md = std::fs::metadata(&p)?;
        if !md.is_dir() {
            return bad("that is not a folder");
        }
        // with subfolders a whole drive can hold millions of files: stop at a size the window can handle
        let recursive = url.q("sub") == "1";
        let (limit, secs) = if recursive { (40_000, 15) } else { (300_000, 60) };
        let deadline = Instant::now() + Duration::from_secs(secs);
        let (mut entries, trunc) = fsops::list_dir(&p, recursive, url.q("hidden") == "1", limit, deadline)?;
        let relinked = self.lib.annotate(&mut entries);
        // prepare thumbnails of this folder in the background
        let warm: Vec<_> = entries
            .iter()
            .filter(|e| e.k == "image" && thumbs::thumb_exts(&e.x))
            .take(400)
            .map(|e| crate::store::FileRec { id: file_id(&e.p), path: e.p.clone(), ext: e.x.clone(), kind: e.k.clone(), size: e.s, mtime: e.m, ..Default::default() })
            .collect();
        thumbs::warm(&self.data_dir, warm);
        let parent = dir_name(&p);
        let parent = if parent == p { String::new() } else { parent };
        Ok(json!({"path": p, "parent": parent, "entries": entries, "truncated": trunc, "relinked": relinked}))
    }

    /// "tag:<name>": every file and folder that carries a tag, on any drive, from the library (no scan).
    fn list_tag(&self, raw: &str) -> ApiResult<Value> {
        let (name, recs) = {
            let d = self.lib.r();
            let want = lower(raw.trim());
            let Some(name) = d.tags.keys().find(|k| lower(k) == want).cloned() else { return Err(ApiErr::NotFound(format!("there is no tag “{}”", raw.trim()))) };
            let recs: Vec<(String, bool)> = d.files.values().filter(|f| f.tags.iter().any(|t| *t == name)).map(|f| (f.path.clone(), f.missing)).collect();
            (name, recs)
        };
        let mut entries = vec![];
        let mut offline = 0;
        for (p, missing) in recs {
            match (missing, std::fs::metadata(&p)) {
                (false, Ok(md)) => {
                    let mut e = fsops::entry_from(&dir_name(&p), &base_name(&p), &md);
                    e.rel = p.clone(); // shown with its whole place
                    entries.push(e);
                }
                _ => offline += 1,
            }
        }
        self.lib.annotate(&mut entries);
        entries.sort_by(|a, b| natural_cmp(&lower(&a.p), &lower(&b.p)));
        Ok(json!({"path": format!("tag:{name}"), "parent": "", "entries": entries, "truncated": false, "tag": name, "offline": offline}))
    }

    fn prefs(&self, a: &Args) -> Value {
        let mut p = self.lib.prefs();
        if let Some(v) = a.opt_bool("WatchDownloads") {
            p.watch_downloads = v;
        }
        if let Some(v) = a.opt_bool("Unblock") {
            p.unblock = v;
        }
        if let Some(v) = a.opt_bool("WatchDrive") {
            p.no_drive_watch = !v;
        }
        if a.has("WatchDirs") {
            p.watch_dirs = a.strs("WatchDirs").iter().filter_map(|d| clean_abs(d).ok()).collect();
        }
        if let Some(v) = a.opt_bool("Background") {
            p.background = v;
        }
        self.lib.set_prefs(p.clone());
        let mut msg = String::new();
        if let Some(v) = a.opt_bool("Autostart") {
            if let Err(e) = platform::autostart_set(v) {
                msg = e.msg().to_string();
            }
        }
        json!({"prefs": p, "autostart": platform::autostart_get(), "warning": msg})
    }

    fn ai_need(&self, a: &Args) -> Value {
        let mut need = vec![];
        for p in a.strs("Paths") {
            let Ok(md) = std::fs::metadata(&p) else { continue };
            if md.is_dir() {
                continue;
            }
            let k = kind_of(&lower_ext(&p));
            if k != "image" && k != "video" {
                continue;
            }
            if vecs().get(&file_id(&p), mtime_unix(&md), md.len() as i64).is_none() {
                need.push(p);
            }
        }
        json!({ "need": need })
    }

    fn ai_vec(&self, a: &Args) -> Value {
        let mut n = 0;
        if let Some(items) = a.get("Items").and_then(|v| v.as_array()) {
            for it in items {
                let p = get_ci(it, "Path").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let v: Vec<f64> = get_ci(it, "Vec").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
                let Ok(md) = std::fs::metadata(&p) else { continue };
                if md.is_dir() {
                    continue;
                }
                if vecs().put(&p, mtime_unix(&md), md.len() as i64, &v).is_ok() {
                    n += 1;
                }
            }
        }
        json!({ "stored": n })
    }

    fn download_done(&self, a: &Args) -> ApiResult<Value> {
        let mut ids = a.strs("IDs");
        let one = a.str("ID");
        if !one.is_empty() {
            ids.push(one);
        }
        if ids.is_empty() {
            return bad("nothing selected");
        }
        let mut paths = vec![];
        let mut ok_ids = vec![];
        for id in ids {
            let Some(it) = self.watch.find(&id) else { continue };
            if !exists(&it.path) {
                self.watch.drop_item(&id, false);
                continue;
            }
            paths.push(it.path);
            ok_ids.push(id);
        }
        if paths.is_empty() {
            return bad("those downloads are no longer in the list");
        }
        let mut fin = paths.clone();
        let move_to = a.str("MoveTo");
        if !move_to.trim().is_empty() {
            let d = clean_abs(&move_to)?;
            if !std::fs::metadata(&d).map(|m| m.is_dir()).unwrap_or(false) {
                return bad("the folder to move to doesn't exist");
            }
            let res = fsops::move_entries(self.lib, &paths, &d);
            if !res.errors.is_empty() && res.done.is_empty() {
                return bad(res.errors[0].clone());
            }
            fin = paths.iter().map(|p| res.done.iter().find(|m| m.from == *p).map(|m| m.to.clone()).unwrap_or_else(|| p.clone())).collect();
            self.lib.add_recent_dir(&d);
        }
        let tags = a.strs("Tags");
        if !tags.is_empty() {
            let (_, err) = self.lib.tag_paths(&fin, &tags, &[]);
            if let Some(e) = err {
                return Err(e);
            }
        }
        if self.lib.prefs().unblock {
            for p in &fin {
                platform::remove_web_mark(p); // only the internet mark; the picture itself is untouched
            }
        }
        for id in ok_ids {
            self.watch.drop_item(&id, false);
        }
        Ok(json!({"path": fin[0], "paths": fin, "count": fin.len(), "all": self.lib.tag_list()}))
    }

    // ---------- static files, media ----------

    fn static_file(&self, path: &str) -> Resp {
        let name = path.trim_start_matches('/');
        let name = if name.is_empty() { "index.html" } else { name };
        let Some((_, b)) = web::WEB.iter().find(|(n, _)| *n == name) else { return text(404, "404 page not found") };
        let ct = match content_type(&lower_ext(name)) {
            "" => "application/octet-stream",
            c => c,
        };
        bytes(200, ct, b.to_vec())
            .with_header(hdr("Cache-Control", "no-store"))
            .with_header(hdr("X-Content-Type-Options", "nosniff"))
            .with_header(hdr(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'",
            ))
    }

    fn query_file(url: &Url) -> Option<(String, std::fs::Metadata)> {
        let p = clean_abs(&url.q("p")).ok()?;
        let md = std::fs::metadata(&p).ok()?;
        if md.is_dir() {
            return None;
        }
        Some((p, md))
    }

    fn file(&self, req: &Request, url: &Url) -> Resp {
        let Some((p, _)) = Self::query_file(url) else { return text(404, "404 page not found") };
        file(
            req,
            &p,
            content_type(&lower_ext(&p)),
            vec![hdr("X-Content-Type-Options", "nosniff"), hdr("Content-Security-Policy", "sandbox"), hdr("Cache-Control", "private, no-cache")],
        )
    }

    fn thumb(&self, req: &Request, url: &Url) -> Resp {
        let Some((p, md)) = Self::query_file(url) else { return text(404, "404 page not found") };
        let f = crate::store::rec_from_meta(&p, &md);
        let cache = vec![hdr("Cache-Control", "private, max-age=31536000, immutable")];
        if f.kind == "video" {
            // video stills are made by the browser and stored through /api/poster
            let poster = thumbs::thumb_path(&self.data_dir, &f);
            if !std::path::Path::new(&poster).exists() {
                return empty(204);
            }
            return file(req, &poster, "image/jpeg", cache);
        }
        let fallback = || {
            let q = url.q("p").replace('%', "%25").replace('&', "%26").replace('+', "%2B").replace('#', "%23");
            redirect(302, &format!("/file?p={q}"))
        };
        if f.kind != "image" || !thumbs::thumb_exts(&f.ext) {
            return fallback();
        }
        let big = url.q("L") == "1";
        let dst = if big { thumbs::thumb_path_big(&self.data_dir, &f) } else { thumbs::thumb_path(&self.data_dir, &f) };
        if !std::path::Path::new(&dst).exists() {
            let made = if big { thumbs::make_thumb_sized(&p, &dst, &f.ext, thumbs::THUMB_BIG) } else { thumbs::make_thumb(&p, &dst, &f.ext) };
            if let Err(e) = made {
                crate::store::log::warn(&format!("thumbnail failed for {p}: {e}"));
                return fallback();
            }
        }
        file(req, &dst, "image/jpeg", cache)
    }

    /// Stores a still frame of a video (made by the browser) so video previews are instant next time.
    /// A video frame (JPEG, made by the page) as the preview of a folder, scene, story or series.
    /// Kept in <data>/frames, so nothing is added to your own folders.
    fn frame_cover(&self, req: &mut Request, url: &Url) -> Resp {
        let target = match clean_abs(&url.q("p")) {
            Ok(p) => p,
            Err(_) => return text(400, "bad path"),
        };
        let body = std::mem::take(&mut req.body);
        if body.len() < 4 || body[0] != 0xFF || body[1] != 0xD8 {
            return text(400, "expected a JPEG");
        }
        let dir = join(&self.data_dir, "frames");
        let _ = std::fs::create_dir_all(&dir);
        let dst = join(&dir, &format!("{}_{}.jpg", file_id(&target), rand_hex(4)));
        if let Err(e) = std::fs::write(&dst, &body) {
            return text(500, &e.to_string());
        }
        match covers::set(self.lib, &target, &dst) {
            Ok(()) => {
                self.drop_unused_frames();
                json(&json!({"image": dst}))
            }
            Err(e) => {
                let _ = std::fs::remove_file(&dst);
                error(e.code(), e.msg())
            }
        }
    }

    /// Deletes saved frames no preview uses any more.
    fn drop_unused_frames(&self) {
        let dir = join(&self.data_dir, "frames");
        let Ok(rd) = std::fs::read_dir(&dir) else { return };
        let used: std::collections::HashSet<String> = self.lib.r().covers.values().map(|c| lower(&c.image)).collect();
        for de in rd.flatten() {
            let p = join(&dir, &de.file_name().to_string_lossy());
            if !used.contains(&lower(&p)) {
                let _ = std::fs::remove_file(&p);
            }
        }
    }

    fn poster(&self, req: &mut Request, url: &Url) -> Resp {
        let Some((p, md)) = Self::query_file(url) else { return text(404, "404 page not found") };
        let f = crate::store::rec_from_meta(&p, &md);
        if f.kind != "video" {
            return text(400, "not a video");
        }
        let body = std::mem::take(&mut req.body);
        if body.len() < 4 || body[0] != 0xFF || body[1] != 0xD8 {
            return text(400, "expected a JPEG");
        }
        let dst = thumbs::thumb_path(&self.data_dir, &f);
        if let Some(d) = std::path::Path::new(&dst).parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let tmp = format!("{dst}.tmp");
        if let Err(e) = std::fs::write(&tmp, &body).and_then(|_| std::fs::rename(&tmp, &dst)) {
            let _ = std::fs::remove_file(&tmp);
            return text(500, &e.to_string());
        }
        // the still has the video's shape: remember it for the Shelf layouts
        if let Ok((w, h)) = image::ImageReader::with_format(std::io::Cursor::new(&body), image::ImageFormat::Jpeg).into_dimensions() {
            crate::dims::put(&p, f.mtime, f.size, w, h);
            crate::dims::save_soon();
        }
        empty(204)
    }
}
