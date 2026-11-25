//! Folder previews: up to four pictures/videos from inside a folder (automatic), or one the user chose.

use crate::platform;
use crate::store::{Cover, LibData, Library, Pair};
use crate::util::*;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

#[derive(Serialize, Clone)]
pub struct CoverItem {
    pub p: String,
    pub k: String,
    pub x: String,
    pub m: i64,
}

#[derive(Serialize, Clone)]
pub struct CoverInfo {
    pub items: Vec<CoverItem>,
    pub n: i64, // entries in the folder, -1 when too many to count cheaply
    #[serde(skip_serializing_if = "is_false")]
    pub custom: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub none: bool,
}
fn is_false(b: &bool) -> bool {
    !*b
}

static CACHE: LazyLock<Mutex<HashMap<String, (i64, CoverInfo)>>> = LazyLock::new(Default::default);
const SCAN_LIMIT: usize = 2000;

fn scan(dir: &str) -> CoverInfo {
    let mut info = CoverInfo { items: vec![], n: -1, custom: false, none: false };
    let Ok(rd) = std::fs::read_dir(dir) else { return info };
    let mut des: Vec<std::fs::DirEntry> = rd.flatten().take(SCAN_LIMIT).collect();
    info.n = des.iter().filter(|d| !d.file_name().to_string_lossy().starts_with('.')).count() as i64;
    if des.len() >= SCAN_LIMIT {
        info.n = -1;
    }
    des.sort_by_cached_key(|d| lower(&d.file_name().to_string_lossy()));
    for d in des {
        if info.items.len() >= 4 {
            break;
        }
        let name = d.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || d.file_type().map(|t| t.is_dir()).unwrap_or(true) {
            continue;
        }
        let ext = lower_ext(&name);
        let k = kind_of(&ext);
        if k != "image" && k != "video" {
            continue;
        }
        let Ok(md) = d.metadata() else { continue };
        if platform::is_hidden(&md, &name) {
            continue;
        }
        info.items.push(CoverItem { p: join(dir, &name), k: k.into(), x: ext, m: mtime_unix(&md) });
    }
    info
}

impl Library {
    pub fn cover_for(&self, folder: &str) -> Option<String> {
        self.r().covers.get(&file_id(folder)).map(|c| c.image.clone())
    }

    pub fn set_cover(&'static self, folder: &str, image: &str) {
        let mut d = self.w();
        let id = file_id(folder);
        if image.is_empty() {
            if d.covers.remove(&id).is_some() {
                self.touch(&mut d);
            }
            return;
        }
        d.covers.insert(id, Cover { folder: folder.into(), image: image.into() });
        self.touch(&mut d);
    }
}

/// Follows folders and chosen pictures moved or renamed inside TagShelf. Returns true when changed.
pub fn relocate_covers(d: &mut LibData, pairs: &[Pair]) -> bool {
    if d.covers.is_empty() {
        return false;
    }
    let map = |p: &str| pairs.iter().find_map(|pr| map_under(p, &pr.from, &pr.to));
    let mut changed = false;
    let old = std::mem::take(&mut d.covers);
    for (id, c) in old {
        let nf = map(&c.folder);
        let ni = if c.image == "-" { None } else { map(&c.image) };
        if nf.is_some() || ni.is_some() {
            changed = true;
            let folder = nf.unwrap_or(c.folder);
            d.covers.insert(file_id(&folder), Cover { image: ni.unwrap_or(c.image), folder });
        } else {
            d.covers.insert(id, c);
        }
    }
    changed
}

pub fn covers(lib: &Library, folders: &[String]) -> serde_json::Value {
    let folders = &folders[..folders.len().min(120)];
    let out: Mutex<serde_json::Map<String, serde_json::Value>> = Mutex::new(Default::default());
    let next = std::sync::atomic::AtomicUsize::new(0);
    std::thread::scope(|s| {
        for _ in 0..4.min(folders.len()) {
            s.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(raw) = folders.get(i) else { return };
                if let Some(info) = one(lib, raw) {
                    out.lock().unwrap().insert(raw.clone(), serde_json::to_value(info).unwrap());
                }
            });
        }
    });
    serde_json::json!({ "covers": out.into_inner().unwrap() })
}

/// A folder's preview (the picture you chose, else up to four from inside it).
pub fn folder_preview(lib: &Library, folder: &str) -> Option<CoverInfo> {
    one(lib, folder)
}

fn one(lib: &Library, raw: &str) -> Option<CoverInfo> {
    let p = clean_abs(raw).ok()?;
    let md = std::fs::metadata(&p).ok()?;
    // a file (a scene, story or series in one file) only has a preview when you chose one
    let custom_only = !md.is_dir();
    if let Some(img) = lib.cover_for(&p) {
        if img == "-" {
            return Some(CoverInfo { items: vec![], n: -1, custom: false, none: true });
        }
        if let Ok(im) = std::fs::metadata(&img) {
            if !im.is_dir() {
                let ext = lower_ext(&img);
                return Some(CoverInfo { items: vec![CoverItem { k: kind_of(&ext).into(), x: ext, m: mtime_unix(&im), p: img }], n: -1, custom: true, none: false });
            }
        }
        // the chosen picture is gone: fall back to automatic
    }
    if custom_only {
        return None;
    }
    let mt = nanos_of(md.modified());
    if let Some((m, info)) = CACHE.lock().unwrap().get(&p) {
        if *m == mt {
            return Some(info.clone());
        }
    }
    let info = scan(&p);
    let mut c = CACHE.lock().unwrap();
    if c.len() > 5000 {
        c.clear();
    }
    c.insert(p, (mt, info.clone()));
    Some(info)
}

pub fn set(lib: &'static Library, folder: &str, image: &str) -> ApiResult<()> {
    let folder = clean_abs(folder)?;
    let md = std::fs::metadata(&folder).map_err(|_| ApiErr::Bad("that folder doesn't exist".into()))?;
    // files get a preview only as a scene, story or series (a PDF, an ISO...)
    if !md.is_dir() && lib.lookup(&folder).map(|f| f.ctype.is_empty()).unwrap_or(true) {
        return bad("only folders, scenes, stories and series can have a chosen preview");
    }
    let mut img = image.to_string();
    if !img.is_empty() && img != "-" {
        img = clean_abs(&img)?;
        match std::fs::metadata(&img) {
            Ok(m) if !m.is_dir() => {}
            _ => return bad("that picture doesn't exist"),
        }
        let k = kind_of(&lower_ext(&img));
        if k != "image" && k != "video" {
            return bad("choose a picture or a video");
        }
    }
    lib.set_cover(&folder, &img);
    Ok(())
}
