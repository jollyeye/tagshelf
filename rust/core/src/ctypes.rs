//! Content types: Scene, Story and Series, set by the user on a folder or a single file. Every picture
//! or video that is not marked as something else is a Panel. A folder's place in the tree says what it
//! belongs to: a scene inside a story folder is part of that story, and so on.
//!
//! Playing a scene or story: its own pictures and videos in name order; subfolders marked Scene or Story
//! play in place as chapters; other subfolders (extras, trailers...) and files marked "leave out" are skipped.

use crate::shelf::{pic_of, Pic};
use crate::store::{FileRec, LibData, Library};
use crate::util::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

pub const TYPES: [&str; 4] = ["scene", "story", "series", "game"];

fn valid(t: &str) -> bool {
    t.is_empty() || TYPES.contains(&t)
}

// ---------- marking ----------

/// Sets (or with "" clears) the content type of files and folders. Returns path -> type.
pub fn set(lib: &'static Library, paths: &[String], t: &str) -> ApiResult<HashMap<String, String>> {
    let t = lower(t.trim());
    if !valid(&t) {
        return bad("unknown content type");
    }
    let mut d = lib.w();
    let mut out = HashMap::new();
    let mut first_err = None;
    for raw in paths {
        let p = match clean_abs(raw) {
            Ok(p) => p,
            Err(e) => {
                first_err.get_or_insert(e);
                continue;
            }
        };
        let id = file_id(&p);
        if !d.files.contains_key(&id) {
            if t.is_empty() {
                out.insert(raw.clone(), String::new());
                continue;
            }
            if let Err(e) = d.ensure(&p) {
                first_err.get_or_insert(ApiErr::from(e));
                continue;
            }
        }
        let f = d.files.get_mut(&id).unwrap();
        f.ctype = t.clone();
        let keep = f.keep();
        out.insert(raw.clone(), t.clone());
        if !keep {
            d.files.remove(&id);
        }
    }
    if t == "series" {
        let marked: Vec<String> = out.keys().cloned().collect();
        for p in marked {
            let twins = d.series_twins(&p);
            if twins.is_empty() {
                continue;
            }
            let mut all: Vec<String> = vec![];
            for q in twins.iter().chain(std::iter::once(&p)) {
                if let Some(f) = d.files.get(&file_id(q)) {
                    for tg in &f.tags {
                        if !all.contains(tg) {
                            all.push(tg.clone());
                        }
                    }
                }
            }
            crate::util::sort_tags(&mut all);
            for q in twins.iter().chain(std::iter::once(&p)) {
                if let Some(f) = d.files.get_mut(&file_id(q)) {
                    f.tags = all.clone();
                }
            }
        }
    }
    lib.touch(&mut d);
    match first_err {
        Some(e) if out.is_empty() => Err(e),
        _ => Ok(out),
    }
}

/// Leaves files out of (or back into) the scene or story they are in.
pub fn set_noplay(lib: &'static Library, paths: &[String], on: bool) -> ApiResult<()> {
    let mut d = lib.w();
    for raw in paths {
        let Ok(p) = clean_abs(raw) else { continue };
        let id = file_id(&p);
        if !d.files.contains_key(&id) && (!on || d.ensure(&p).is_err()) {
            continue;
        }
        let f = d.files.get_mut(&id).unwrap();
        f.noplay = on;
        if !f.keep() {
            d.files.remove(&id);
        }
    }
    lib.touch(&mut d);
    Ok(())
}

// ---------- finding folders by name ----------

/// What a folder's name says it is ("Scene 03 - Beach" -> scene).
pub fn guess_from_name(name: &str) -> Option<&'static str> {
    let n = lower(name);
    if n.contains("serie") {
        Some("series")
    } else if n.contains("story") || n.contains("stories") || n.contains("novel") {
        Some("story")
    } else if n.contains("scene") {
        Some("scene")
    } else {
        None
    }
}

fn skip_dir(name: &str) -> bool {
    let n = lower(name);
    n.starts_with('.') || n.starts_with('$') || matches!(n.as_str(), "windows" | "appdata" | "program files" | "program files (x86)" | "programdata" | "system volume information" | "node_modules")
}

/// Folders below `root` whose name says scene / story / series, with what they are marked as now.
pub fn detect(lib: &Library, root: &str) -> ApiResult<Value> {
    let root = clean_abs(root)?;
    if !std::fs::metadata(&root).map(|m| m.is_dir()).unwrap_or(false) {
        return bad("that folder doesn't exist");
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut found: Vec<(String, String, &'static str)> = vec![];
    let mut stack = vec![(root.clone(), 0usize)];
    let mut seen = 0usize;
    let mut partial = false;
    while let Some((dir, depth)) = stack.pop() {
        if Instant::now() > deadline || seen > 40_000 {
            partial = true;
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut subs: Vec<(String, String)> = vec![];
        for de in rd.flatten() {
            if !de.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = de.file_name().to_string_lossy().into_owned();
            if skip_dir(&name) {
                continue;
            }
            seen += 1;
            subs.push((join(&dir, &name), name));
        }
        subs.sort_by(|a, b| natural_cmp(&lower(&b.1), &lower(&a.1))); // reversed: the stack pops A first
        for (p, name) in subs {
            if let Some(t) = guess_from_name(&name) {
                found.push((p.clone(), name.clone(), t));
            }
            if depth < 12 {
                stack.push((p, depth + 1));
            }
        }
    }
    found.sort_by(|a, b| natural_cmp(&lower(&a.0), &lower(&b.0)));
    let d = lib.r();
    let items: Vec<Value> = found
        .iter()
        .map(|(p, n, t)| {
            let cur = d.files.get(&file_id(p)).map(|f| f.ctype.clone()).unwrap_or_default();
            json!({"p": p, "n": n, "c": t, "cur": cur})
        })
        .collect();
    Ok(json!({"items": items, "partial": partial}))
}

// ---------- the tree ----------

/// Marked folders and files that still exist (checked against the disk for a few seconds at most).
struct Marked {
    /// id -> (path, type) for every marked item
    by_id: HashMap<String, (String, String)>,
}

impl Marked {
    fn of(d: &LibData) -> Marked {
        Marked { by_id: d.files.values().filter(|f| !f.ctype.is_empty() && !f.missing).map(|f| (f.id.clone(), (f.path.clone(), f.ctype.clone()))).collect() }
    }
    fn type_of(&self, p: &str) -> Option<&str> {
        self.by_id.get(&file_id(p)).map(|x| x.1.as_str())
    }
    /// The closest marked folder above `p`.
    fn parent(&self, p: &str) -> Option<(String, String)> {
        let mut cur = dir_name(p);
        for _ in 0..64 {
            if let Some((pp, t)) = self.by_id.get(&file_id(&cur)) {
                return Some((pp.clone(), t.clone()));
            }
            let up = dir_name(&cur);
            if up == cur || up == "." {
                return None;
            }
            cur = up;
        }
        None
    }
}

fn stem(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => name[..i].to_string(),
        _ => name.to_string(),
    }
}

/// The name shown for an item: the folder's name, or the file's name without its extension.
pub fn display_name(f: &FileRec) -> String {
    if f.isdir {
        f.name.clone()
    } else {
        stem(&f.name)
    }
}

fn is_playable(name: &str) -> Option<&'static str> {
    let x = lower_ext(name);
    match kind_of(&x) {
        "image" => Some("image"),
        "video" => Some("video"),
        _ => None,
    }
}

/// Pictures/videos directly in a folder (name order) and its subfolders.
fn read_folder(dir: &str) -> (Vec<(String, std::fs::Metadata)>, Vec<String>) {
    let mut files = vec![];
    let mut dirs = vec![];
    let Ok(rd) = std::fs::read_dir(dir) else { return (files, dirs) };
    for de in rd.flatten() {
        let name = de.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(md) = de.metadata() else { continue };
        if crate::platform::is_hidden(&md, &name) {
            continue;
        }
        if md.is_dir() {
            dirs.push(name);
        } else if is_playable(&name).is_some() {
            files.push((name, md));
        }
    }
    files.sort_by(|a, b| natural_cmp(&lower(&a.0), &lower(&b.0)));
    dirs.sort_by(|a, b| natural_cmp(&lower(a), &lower(b)));
    (files, dirs)
}

/// The picture for an item: the one you chose, else for a folder the first picture/video inside it (or
/// inside its first marked subfolder), for a picture/video file itself.
fn cover_of(lib: &Library, f: &FileRec, mk: &Marked, depth: usize) -> (Option<Pic>, bool) {
    if let Some(img) = lib.cover_for(&f.path) {
        if img == "-" {
            return (None, true);
        }
        if let Ok(m) = std::fs::metadata(&img) {
            if !m.is_dir() {
                return (Some(pic_of(&img, mtime_unix(&m))), true);
            }
        }
    }
    if !f.isdir {
        return if f.kind == "image" || f.kind == "video" { (Some(pic_of(&f.path, f.mtime)), false) } else { (None, false) };
    }
    if let Some(info) = crate::covers::folder_preview(lib, &f.path) {
        if let Some(it) = info.items.first() {
            return (Some(Pic { p: it.p.clone(), k: it.k.clone(), x: it.x.clone(), m: it.m }), false);
        }
    }
    if depth < 3 {
        let (_, dirs) = read_folder(&f.path);
        // a marked subfolder first (a story's first scene), else any subfolder
        let mut order: Vec<&String> = dirs.iter().filter(|n| mk.type_of(&join(&f.path, n)).is_some()).collect();
        order.extend(dirs.iter().filter(|n| mk.type_of(&join(&f.path, n)).is_none()));
        for n in order.into_iter().take(4) {
            let sub = FileRec { path: join(&f.path, n), name: n.clone(), isdir: true, ..Default::default() };
            if let (Some(p), _) = cover_of(lib, &sub, mk, depth + 1) {
                return (Some(p), false);
            }
        }
    }
    (None, false)
}

/// One scene / story / series for the Shelf.
fn item_json(lib: &Library, f: &FileRec, mk: &Marked, kids: &HashMap<String, (i64, i64)>, slow: bool) -> Value {
    let (cover, custom) = if slow { (None, false) } else { cover_of(lib, f, mk, 0) };
    let (scenes, stories) = kids.get(&f.id).copied().unwrap_or((0, 0));
    let media = if f.isdir && !slow { read_folder(&f.path).0.len() as i64 } else { 0 };
    let parent = mk.parent(&f.path).map(|(p, t)| json!({"p": p, "n": base_name(&p), "c": t}));
    json!({
        "p": f.path, "n": display_name(f), "c": f.ctype, "d": f.isdir, "k": f.kind, "x": f.ext, "m": f.mtime, "a": f.added,
        "t": f.tags, "r": f.rating, "cover": cover, "custom": custom, "media": media, "scenes": scenes, "stories": stories, "parent": parent,
    })
}

/// How many marked scenes and stories sit directly under each marked folder.
fn kid_counts(mk: &Marked) -> HashMap<String, (i64, i64)> {
    let mut out: HashMap<String, (i64, i64)> = HashMap::new();
    for (p, t) in mk.by_id.values() {
        if let Some((pp, _)) = mk.parent(p) {
            let e = out.entry(file_id(&pp)).or_default();
            if t == "scene" {
                e.0 += 1;
            } else if t == "story" {
                e.1 += 1;
            }
        }
    }
    out
}

/// Marked items that still exist, optionally only those with a tag or under a folder.
fn marked_items(lib: &Library, keep: impl Fn(&FileRec) -> bool) -> Value {
    let (recs, mk) = {
        let d = lib.r();
        let recs: Vec<FileRec> = d.files.values().filter(|f| !f.ctype.is_empty() && !f.missing && keep(f)).cloned().collect();
        (recs, Marked::of(&d))
    };
    let kids = kid_counts(&mk);
    let deadline = Instant::now() + Duration::from_secs(4);
    let mut items: Vec<Value> = vec![];
    let mut recs = recs;
    recs.sort_by(|a, b| natural_cmp(&lower(&a.path), &lower(&b.path)));
    for mut f in recs {
        let slow = Instant::now() > deadline;
        if !slow {
            match std::fs::metadata(&f.path) {
                Ok(md) => f.mtime = mtime_unix(&md),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {}
            }
        }
        items.push(item_json(lib, &f, &mk, &kids, slow));
    }
    Value::Array(join_series(items))
}

/// Series folders with exactly the same name are one series: one item with every folder in "paths",
/// what is inside added up, and the tags of all of them.
fn join_series(items: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = vec![];
    let mut at: HashMap<String, usize> = HashMap::new();
    for mut it in items {
        let p = it["p"].as_str().unwrap_or("").to_string();
        it["paths"] = json!([p]);
        if !(it["c"] == "series" && it["d"] == true) {
            out.push(it);
            continue;
        }
        let key = it["n"].as_str().unwrap_or("").to_string();
        let Some(&i) = at.get(&key) else {
            at.insert(key, out.len());
            out.push(it);
            continue;
        };
        let first = &mut out[i];
        first["paths"].as_array_mut().unwrap().push(json!(p));
        for k in ["media", "scenes", "stories"] {
            first[k] = json!(first[k].as_i64().unwrap_or(0) + it[k].as_i64().unwrap_or(0));
        }
        let mut tags: Vec<String> = first["t"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        for x in it["t"].as_array().into_iter().flatten().filter_map(|x| x.as_str()) {
            if !tags.iter().any(|y| y == x) {
                tags.push(x.to_string());
            }
        }
        crate::util::sort_tags(&mut tags);
        first["t"] = json!(tags);
        first["r"] = json!(first["r"].as_i64().unwrap_or(0).max(it["r"].as_i64().unwrap_or(0)));
        first["a"] = json!(first["a"].as_i64().unwrap_or(0).max(it["a"].as_i64().unwrap_or(0)));
        // a picture you chose wins over an automatic one
        if (first["cover"].is_null() || first["custom"] != true) && !it["cover"].is_null() && (it["custom"] == true || first["cover"].is_null()) {
            first["cover"] = it["cover"].clone();
            first["custom"] = it["custom"].clone();
        }
    }
    out
}

/// Everything of one type, for the Shelf's Content pages. Panels: every tagged or rated picture/video
/// that is not marked as something else.
pub fn page(lib: &Library, t: &str) -> ApiResult<Value> {
    let t = lower(t);
    if t == "panel" {
        let d = lib.r();
        let files: Vec<Value> = d
            .files
            .values()
            .filter(|f| !f.missing && !f.isdir && f.ctype.is_empty() && (f.kind == "image" || f.kind == "video") && (!f.tags.is_empty() || f.rating != 0))
            .map(|f| {
                let (w, h) = crate::dims::get(&f.path, f.mtime, f.size).unwrap_or((0, 0));
                json!({"n": f.name, "p": f.path, "k": f.kind, "x": f.ext, "s": f.size, "m": f.mtime, "t": f.tags, "r": f.rating, "a": f.added, "w": w, "h": h})
            })
            .collect();
        return Ok(json!({"type": "panel", "files": files}));
    }
    if !TYPES.contains(&t.as_str()) {
        return bad("unknown content type");
    }
    Ok(json!({"type": t, "items": marked_items(lib, |f| f.ctype == t)}))
}

/// Items of a type that carry a tag (tag page tabs).
pub fn with_tag(lib: &Library, t: &str, tag: &str) -> Value {
    marked_items(lib, |f| f.ctype == t && f.tags.iter().any(|x| x == tag))
}

/// Counts per type, for the Shelf's left panel.
pub fn counts(d: &LibData) -> Value {
    let mut c: HashMap<&str, i64> = HashMap::new();
    let mut series_names: HashSet<&str> = HashSet::new();
    for f in d.files.values() {
        if f.missing {
            continue;
        }
        if f.isdir && f.ctype == "series" && !series_names.insert(f.name.as_str()) {
            continue; // another folder of a series already counted
        }
        if !f.ctype.is_empty() {
            *c.entry(f.ctype.as_str()).or_default() += 1;
        } else if !f.isdir && (f.kind == "image" || f.kind == "video") && (!f.tags.is_empty() || f.rating != 0) {
            *c.entry("panel").or_default() += 1;
        }
    }
    json!({"panel": c.get("panel").unwrap_or(&0), "scene": c.get("scene").unwrap_or(&0), "story": c.get("story").unwrap_or(&0), "series": c.get("series").unwrap_or(&0), "game": c.get("game").unwrap_or(&0)})
}

/// A series (or story) page: the item itself and the scenes / stories directly inside it, in name order.
pub fn children(lib: &Library, path: &str) -> ApiResult<Value> {
    let p = clean_abs(path)?;
    let (me, roots, recs, mk) = {
        let d = lib.r();
        let me = d.files.get(&file_id(&p)).cloned();
        // a series made of several same-name folders (on other drives, say) lists what is in all of them
        let mut roots = vec![p.clone()];
        roots.extend(d.series_twins(&p).into_iter().filter(|t| exists(t)));
        let mk = Marked::of(&d);
        let recs: Vec<FileRec> = d.files.values().filter(|f| !f.ctype.is_empty() && !f.missing && roots.iter().any(|r| under_root(&f.path, r) && !same_path(&f.path, r))).cloned().collect();
        let roots_recs: Vec<FileRec> = roots.iter().filter_map(|r| d.files.get(&file_id(r)).cloned()).collect();
        (me, roots_recs, recs, mk)
    };
    let Some(_) = me.filter(|f| !f.ctype.is_empty()) else { return Err(ApiErr::NotFound("that is not marked as a scene, story or series".into())) };
    let kids = kid_counts(&mk);
    let mut mine: Vec<FileRec> = recs
        .into_iter()
        .filter(|f| mk.parent(&f.path).map(|(pp, _)| roots.iter().any(|r| same_path(&pp, &r.path))).unwrap_or(false) && exists(&f.path))
        .collect();
    // in name order across all the folders (paths differ from drive to drive)
    mine.sort_by(|a, b| natural_cmp(&lower(&display_name(a)), &lower(&display_name(b))).then_with(|| natural_cmp(&lower(&a.path), &lower(&b.path))));
    let items: Vec<Value> = mine.iter().map(|f| item_json(lib, f, &mk, &kids, false)).collect();
    let mut me_items: Vec<Value> = roots.iter().map(|f| item_json(lib, f, &mk, &kids, false)).collect();
    // the folder you opened first, then the others
    if let Some(i) = me_items.iter().position(|x| x["p"].as_str().map(|s| same_path(s, &p)).unwrap_or(false)) {
        let m = me_items.remove(i);
        me_items.insert(0, m);
    }
    let item = join_series(me_items).into_iter().next().unwrap_or(Value::Null);
    Ok(json!({"item": item, "items": items}))
}

/// The other folders of a series (same name, also marked Series).
pub fn twins(lib: &Library, path: &str) -> ApiResult<Value> {
    let p = clean_abs(path)?;
    Ok(json!({"paths": lib.r().series_twins(&p)}))
}

fn exists(p: &str) -> bool {
    std::fs::metadata(p).is_ok()
}

// ---------- playing ----------

const PLAY_LIMIT: usize = 6000;

struct Play<'a> {
    mk: &'a Marked,
    skip: HashSet<String>,
    items: Vec<Value>,
    chapters: Vec<Value>,
    /// the folder whose loose files the last chapter holds
    loose_of: Option<String>,
}

impl Play<'_> {
    fn chapter(&mut self, name: &str, p: &str, c: &str) {
        self.chapters.push(json!({"name": name, "p": p, "c": c, "start": self.items.len()}));
    }
    fn add_file(&mut self, p: &str, name: &str, md: &std::fs::Metadata) {
        let x = lower_ext(name);
        let k = kind_of(&x);
        let (m, s) = (mtime_unix(md), md.len() as i64);
        let dur = if k == "video" { crate::dims::duration(p, m, s).unwrap_or(0) } else { 0 };
        let (w, h) = crate::dims::get(p, m, s).unwrap_or((0, 0));
        self.items.push(json!({"p": p, "n": name, "k": k, "x": x, "m": m, "s": s, "dur": dur, "w": w, "h": h}));
    }
    fn folder(&mut self, dir: &str, depth: usize) {
        if depth > 8 || self.items.len() >= PLAY_LIMIT {
            return;
        }
        let (files, dirs) = read_folder(dir);
        // files and marked subfolders together, in name order
        let mut all: Vec<(String, bool)> = files.iter().map(|(n, _)| (n.clone(), false)).chain(dirs.iter().map(|n| (n.clone(), true))).collect();
        all.sort_by(|a, b| natural_cmp(&lower(&a.0), &lower(&b.0)));
        let mds: HashMap<&str, &std::fs::Metadata> = files.iter().map(|(n, m)| (n.as_str(), m)).collect();
        for (name, is_dir) in all {
            if self.items.len() >= PLAY_LIMIT {
                return;
            }
            let p = join(dir, &name);
            let t = self.mk.type_of(&p).map(|s| s.to_string());
            if is_dir {
                match t.as_deref() {
                    Some("scene") | Some("story") => {
                        self.chapter(&name, &p, t.as_deref().unwrap());
                        // its own pictures belong to this chapter
                        self.loose_of = Some(p.clone());
                        self.folder(&p, depth + 1);
                        self.loose_of = None;
                    }
                    _ => {} // extras, trailers...: not part of it
                }
                continue;
            }
            if self.skip.contains(&file_id(&p)) {
                continue;
            }
            let md = mds[name.as_str()];
            if let Some(tt @ ("scene" | "story")) = t.as_deref() {
                // a single file marked as its own scene: a chapter of its own
                self.chapter(&stem(&name), &p, tt);
                self.add_file(&p, &name, md);
                self.loose_of = None;
                continue;
            }
            if !self.loose_of.as_deref().map(|l| same_path(l, dir)).unwrap_or(false) {
                self.chapter(&base_name(dir), dir, "");
                self.loose_of = Some(dir.to_string());
            }
            self.add_file(&p, &name, md);
        }
    }
}

/// What a scene or story plays, in order, with its chapters (marked subfolders and single-file scenes).
pub fn playlist(lib: &Library, path: &str) -> ApiResult<Value> {
    let p = clean_abs(path)?;
    let md = std::fs::metadata(&p)?;
    let (mk, skip, rec) = {
        let d = lib.r();
        let skip: HashSet<String> = d.files.values().filter(|f| f.noplay).map(|f| f.id.clone()).collect();
        (Marked::of(&d), skip, d.files.get(&file_id(&p)).cloned())
    };
    let c = rec.as_ref().map(|f| f.ctype.clone()).unwrap_or_default();
    let name = if md.is_dir() { base_name(&p) } else { stem(&base_name(&p)) };
    let mut play = Play { mk: &mk, skip, items: vec![], chapters: vec![], loose_of: None };
    if md.is_dir() {
        play.folder(&p, 0);
    } else if is_playable(&p).is_some() {
        play.add_file(&p, &base_name(&p), &md);
    }
    // chapter marks only make sense when there are several parts
    let marked_parts = play.chapters.iter().filter(|c| c["c"].as_str().map(|s| !s.is_empty()).unwrap_or(false)).count();
    let mut chapters = std::mem::take(&mut play.chapters);
    if marked_parts == 0 {
        chapters.clear();
    }
    chapters.retain(|c| c["start"].as_u64().map(|s| (s as usize) < play.items.len()).unwrap_or(false));
    Ok(json!({"p": p, "name": name, "c": c, "items": play.items, "chapters": chapters, "full": play.items.len() < PLAY_LIMIT}))
}

/// Video lengths measured by the page.
pub fn durations(args: &Args) {
    if let Some(list) = args.get("Items").and_then(|v| v.as_array()) {
        for it in list {
            let a = Args(it.clone());
            crate::dims::put_duration(&a.str("P"), a.int("M"), a.int("S"), a.int("Ms"));
        }
        crate::dims::save_soon();
    }
}

// ---------- games ----------
// A game is a file (started as Windows would) or a folder: its program, else its index.html, else the
// folder itself. When a folder has several programs (uninstallers, 32/64-bit, setup...), the likely one
// is picked; when it is not clear you choose, and the choice is remembered.

/// Names of programs that are not the game itself.
const NOT_THE_GAME: [&str; 22] = [
    "unins", "uninstall", "setup", "install", "redist", "vcredist", "vc_redist", "dxsetup", "directx", "crash", "report", "updat", "patch",
    "dotnet", "physx", "prereq", "helper", "cleanup", "repair", "touchup", "activation", "dxwebsetup",
];
/// Subfolders that never hold the game's program.
const SKIP_DIRS: [&str; 9] = ["redist", "_commonredist", "commonredist", "directx", "__installer", "_redist", "support", "vcredist", "dotnet"];

fn alnum(s: &str) -> String {
    lower(s).chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

struct Exe {
    rel: String,
    size: u64,
    score: i64,
    not_game: bool,
}

/// The programs in a game folder (and two levels of subfolders, like bin\x64), most likely first.
fn game_programs(dir: &str) -> Vec<Exe> {
    let folder = alnum(&base_name(dir));
    let mut out: Vec<Exe> = vec![];
    let mut stack = vec![(dir.to_string(), String::new(), 0usize)];
    while let Some((d, rel, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for de in rd.flatten() {
            let name = de.file_name().to_string_lossy().into_owned();
            let Ok(md) = de.metadata() else { continue };
            let r = if rel.is_empty() { name.clone() } else { format!("{rel}{}{name}", std::path::MAIN_SEPARATOR) };
            if md.is_dir() {
                if depth < 2 && !SKIP_DIRS.contains(&lower(&name).as_str()) && out.len() < 300 {
                    stack.push((join(&d, &name), r, depth + 1));
                }
                continue;
            }
            if lower_ext(&name) != ".exe" {
                continue;
            }
            let stem = alnum(&stem(&name));
            let ln = lower(&name);
            let not_game = NOT_THE_GAME.iter().any(|w| ln.contains(w));
            let mut score: i64 = if not_game { -100 } else { 0 };
            if !folder.is_empty() && stem == folder {
                score += 50;
            } else if !folder.is_empty() && stem.len() >= 3 && (folder.contains(&stem) || stem.contains(&folder)) {
                score += 25;
            }
            if ln.contains("x64") || ln.contains("win64") || ln.contains("64bit") || ln.contains("64-bit") || stem.ends_with("64") {
                score += 10;
            }
            if ln.contains("x86") || ln.contains("win32") || ln.contains("32bit") || ln.contains("32-bit") || stem.ends_with("32") {
                score -= 10;
            }
            if lower(&r).contains("x64") || lower(&r).contains("win64") {
                score += 5;
            }
            score += 6 - 3 * depth as i64; // closer to the top is more likely
            let mb = (md.len() / (1 << 20)).max(1);
            score += (64 - mb.leading_zeros() as i64).min(10); // bigger is more likely (log2 of MB)
            out.push(Exe { rel: r, size: md.len(), score, not_game });
        }
    }
    out.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| natural_cmp(&lower(&a.rel), &lower(&b.rel))));
    out
}

/// The top-level index.html, if any.
fn index_html(dir: &str) -> Option<String> {
    std::fs::read_dir(dir).ok()?.flatten().map(|de| de.file_name().to_string_lossy().into_owned()).find(|n| lower(n) == "index.html" || lower(n) == "index.htm")
}

/// What a game folder can start: its programs (likely first), your choice, the guess and its index.html.
pub fn game_options(lib: &Library, path: &str) -> ApiResult<Value> {
    let p = clean_abs(path)?;
    let chosen = lib.lookup(&p).map(|f| f.launch).unwrap_or_default();
    let exes = game_programs(&p);
    let items: Vec<Value> = exes.iter().map(|e| json!({"rel": e.rel, "size": e.size, "notGame": e.not_game})).collect();
    Ok(json!({"items": items, "best": exes.first().map(|e| e.rel.clone()), "chosen": chosen, "html": index_html(&p)}))
}

/// Starts a game. With `rel` (one of its programs) that one, remembered when asked; otherwise your earlier
/// choice, the clear favourite, its index.html or the folder. When several programs are equally likely
/// the answer asks which one ({"ask": true, ...}).
pub fn game_launch(lib: &'static Library, path: &str, rel: &str, remember: bool) -> ApiResult<Value> {
    let p = clean_abs(path)?;
    let md = std::fs::metadata(&p).map_err(|_| ApiErr::NotFound("this game is not there any more (is its drive connected?)".into()))?;
    if !md.is_dir() {
        crate::platform::launch(&p)?;
        return Ok(json!({"launched": p}));
    }
    let start = |target: &str| -> ApiResult<Value> {
        crate::platform::launch(target)?;
        Ok(json!({"launched": target}))
    };
    let resolve = |r: &str| -> Option<String> {
        if r.is_empty() || r.contains("..") {
            return None;
        }
        let t = join(&p, r);
        std::fs::metadata(&t).ok().filter(|m| m.is_file()).map(|_| t)
    };
    if !rel.is_empty() {
        let Some(t) = resolve(rel) else { return bad("that program is not in the game's folder") };
        if remember {
            let mut d = lib.w();
            if d.ensure(&p).is_ok() {
                if let Some(f) = d.files.get_mut(&file_id(&p)) {
                    f.launch = rel.to_string();
                }
                lib.touch(&mut d);
            }
        }
        return start(&t);
    }
    if let Some(t) = lib.lookup(&p).map(|f| f.launch).and_then(|r| resolve(&r)) {
        return start(&t);
    }
    let exes = game_programs(&p);
    let real: Vec<&Exe> = exes.iter().filter(|e| !e.not_game).collect();
    match real.len() {
        0 if exes.is_empty() => {}
        1 => return start(&join(&p, &real[0].rel)),
        n if n > 1 && real[0].score - real[1].score >= 20 => return start(&join(&p, &real[0].rel)),
        _ => {
            let items: Vec<Value> = exes.iter().map(|e| json!({"rel": e.rel, "size": e.size, "notGame": e.not_game})).collect();
            return Ok(json!({"ask": true, "items": items, "best": exes[0].rel}));
        }
    }
    if let Some(h) = index_html(&p) {
        return start(&join(&p, &h));
    }
    // nothing we know: let Windows decide (opens the folder)
    crate::platform::launch(&p)?;
    Ok(json!({"launched": p, "folder": true}))
}
