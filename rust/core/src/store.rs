//! The tag library (library.json): tags, ratings, pinned folders, saved filters, settings.
//! Only files that carry tags or a rating are stored; the file system is the source of truth.
//! The JSON format is identical to the Go version, so libraries move between versions freely.

use crate::ai::vecs;
use crate::util::*;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::Duration;

fn nullable<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}
fn is_zero(n: &i64) -> bool {
    *n == 0
}
fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct FileRec {
    pub id: String,
    pub path: String,
    pub name: String,
    pub dir: String,
    pub ext: String,
    pub kind: String,
    pub size: i64,
    pub mtime: i64,
    pub added: i64,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "nullable")]
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "is_zero")]
    pub rating: i64,
    #[serde(skip_serializing_if = "is_false")]
    pub isdir: bool,
    #[serde(skip)]
    pub missing: bool,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct TagInfo {
    pub color: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub used: i64,
    /// id of the Shelf category this tag belongs to ("" = uncategorized)
    #[serde(skip_serializing_if = "String::is_empty")]
    pub category: String,
    /// picture chosen for the tag's card and page banner ("" = automatic)
    #[serde(skip_serializing_if = "String::is_empty")]
    pub cover: String,
}

/// A Shelf category ("Topics", "Characters", ...) with its layout preset.
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub color: String,
    /// banner | profile | gallery | timeline
    pub preset: String,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct View {
    pub id: String,
    pub name: String,
    pub state: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Prefs {
    #[serde(rename = "watchDownloads")]
    pub watch_downloads: bool,
    #[serde(rename = "watchDirs", deserialize_with = "nullable")]
    pub watch_dirs: Vec<String>,
    pub background: bool,
    pub unblock: bool,
    #[serde(rename = "noDriveWatch")]
    pub no_drive_watch: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { watch_downloads: true, watch_dirs: vec![], background: false, unblock: false, no_drive_watch: false }
    }
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Cover {
    pub folder: String,
    pub image: String,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Pair {
    pub from: String,
    pub to: String,
}

#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(default)]
pub struct LibData {
    pub version: i64,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "nullable")]
    pub roots: Vec<String>,
    #[serde(deserialize_with = "nullable")]
    pub pins: Vec<String>,
    #[serde(deserialize_with = "nullable")]
    pub files: HashMap<String, FileRec>,
    #[serde(deserialize_with = "nullable")]
    pub tags: HashMap<String, TagInfo>,
    #[serde(deserialize_with = "nullable")]
    pub views: Vec<View>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<Value>,
    pub prefs: Prefs,
    #[serde(rename = "recentDirs", skip_serializing_if = "Vec::is_empty", deserialize_with = "nullable")]
    pub recent: Vec<String>,
    #[serde(skip_serializing_if = "HashMap::is_empty", deserialize_with = "nullable")]
    pub rejected: HashMap<String, Vec<String>>,
    #[serde(skip_serializing_if = "HashMap::is_empty", deserialize_with = "nullable")]
    pub covers: HashMap<String, Cover>,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "nullable")]
    pub categories: Vec<Category>,

    #[serde(skip)]
    pub tag_idx: HashMap<String, String>,
    #[serde(skip)]
    pub rev: u64,
    #[serde(skip)]
    pub orphans: HashMap<String, Vec<String>>,
}

pub struct Library {
    d: RwLock<LibData>,
    path: String,
    saver: Debounce,
}

#[derive(Serialize, Clone, Debug)]
pub struct TagOut {
    pub name: String,
    pub color: String,
    pub count: i64,
    pub used: i64,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub category: String,
}

fn orphan_key(name: &str, size: i64, mtime: i64) -> String {
    format!("{}|{}|{}", lower(name), size, mtime)
}

pub fn rec_from_meta(path: &str, md: &std::fs::Metadata) -> FileRec {
    let ext = lower_ext(path);
    let mut f = FileRec {
        id: file_id(path),
        path: path.to_string(),
        name: base_name(path),
        dir: dir_name(path),
        kind: kind_of(&ext).to_string(),
        ext,
        size: md.len() as i64,
        mtime: mtime_unix(md),
        added: now_unix(),
        isdir: md.is_dir(),
        ..Default::default()
    };
    if f.isdir {
        f.kind = "folder".into();
        f.ext = String::new();
        f.size = 0;
    }
    f
}

impl LibData {
    /// The stored spelling for a tag, creating it if needed.
    pub fn canon(&mut self, name: &str) -> String {
        let name = clean_tag(name);
        if name.is_empty() {
            return name;
        }
        let key = lower(&name);
        if let Some(c) = self.tag_idx.get(&key) {
            return c.clone();
        }
        self.tag_idx.insert(key, name.clone());
        self.tags.insert(name.clone(), TagInfo { color: auto_color(&name), ..Default::default() });
        name
    }

    fn ensure(&mut self, path: &str) -> std::io::Result<&mut FileRec> {
        let id = file_id(path);
        if !self.files.contains_key(&id) {
            let md = std::fs::metadata(path)?;
            self.files.insert(id.clone(), rec_from_meta(path, &md));
        }
        Ok(self.files.get_mut(&id).unwrap())
    }
}

impl Library {
    pub fn load(dir: &str) -> std::io::Result<&'static Library> {
        let path = join(dir, "library.json");
        let mut d = LibData { version: 2, ..Default::default() };
        let mut old_version = 2;
        match std::fs::read(&path) {
            Ok(b) => match serde_json::from_slice::<LibData>(&b) {
                Ok(parsed) => {
                    d = parsed;
                    old_version = d.version;
                    if old_version < 2 {
                        let _ = std::fs::write(join(dir, "library.v1.backup.json"), &b);
                    } else {
                        let _ = std::fs::write(format!("{path}.bak"), &b);
                    }
                }
                Err(e) => {
                    log::warn(&format!("library.json is unreadable ({e}); trying backup"));
                    let stamp = now_unix();
                    let _ = std::fs::rename(&path, format!("{path}.corrupt-{stamp}"));
                    if let Ok(bb) = std::fs::read(format!("{path}.bak")) {
                        if let Ok(parsed) = serde_json::from_slice::<LibData>(&bb) {
                            d = parsed;
                        }
                    }
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let mut migrate = false;
        if old_version < 2 {
            // v1 scanned whole folders; v2 only remembers files with tags or a rating,
            // and the old library folders become pinned folders in the tree.
            let roots = std::mem::take(&mut d.roots);
            d.pins.extend(roots);
            d.files.retain(|_, f| !f.tags.is_empty() || f.rating != 0);
            d.version = 2;
            migrate = true;
        }
        let mut missing_tags = vec![];
        for f in d.files.values_mut() {
            if f.id.is_empty() {
                f.id = file_id(&f.path);
            }
            for t in &f.tags {
                if !d.tags.contains_key(t) {
                    missing_tags.push(t.clone());
                }
            }
        }
        for t in missing_tags {
            let c = auto_color(&t);
            d.tags.entry(t).or_insert(TagInfo { color: c, ..Default::default() });
        }
        // Go stored ids that may differ from the key after a migration; key everything by id.
        let files = std::mem::take(&mut d.files);
        for (_, f) in files {
            d.files.insert(f.id.clone(), f);
        }
        let names: Vec<String> = d.tags.keys().cloned().collect();
        for n in names {
            d.tag_idx.insert(lower(&n), n);
        }
        let lib: &'static Library = Box::leak(Box::new(Library { d: RwLock::new(d), path, saver: Debounce::new(Duration::from_millis(900)) }));
        if migrate {
            let _ = lib.flush();
        }
        Ok(lib)
    }

    pub fn r(&self) -> RwLockReadGuard<'_, LibData> {
        self.d.read().unwrap_or_else(|e| e.into_inner())
    }
    pub fn w(&self) -> RwLockWriteGuard<'_, LibData> {
        self.d.write().unwrap_or_else(|e| e.into_inner())
    }

    pub fn flush(&self) -> std::io::Result<()> {
        let b = {
            let d = self.r();
            serde_json::to_vec(&*d).map_err(std::io::Error::other)?
        };
        let tmp = format!("{}.tmp", self.path);
        std::fs::write(&tmp, b)?;
        std::fs::rename(&tmp, &self.path)
    }

    /// Schedules a save; may be called with or without the lock held.
    pub fn touch(&'static self, d: &mut LibData) {
        d.rev += 1;
        self.saver.schedule(move || {
            if let Err(e) = self.flush() {
                log::warn(&format!("save failed: {e}"));
            }
        });
    }

    pub fn rev(&self) -> u64 {
        self.r().rev
    }

    pub fn lookup(&self, path: &str) -> Option<FileRec> {
        self.r().files.get(&file_id(path)).cloned()
    }

    // ---------- listing support ----------

    /// Fills in tags and ratings for directory entries and re-attaches tags to files that were
    /// moved or renamed outside TagShelf (matched by name, size and modified time).
    pub fn annotate(&'static self, entries: &mut [crate::fsops::Entry]) -> i64 {
        let mut cands = vec![];
        {
            let d = self.r();
            let has_orphans = !d.orphans.is_empty();
            for (i, e) in entries.iter_mut().enumerate() {
                if let Some(f) = d.files.get(&file_id(&e.p)) {
                    e.t = f.tags.clone();
                    e.r = f.rating;
                } else if has_orphans && !e.d {
                    cands.push(i);
                }
            }
        }
        if cands.is_empty() {
            return 0;
        }
        let mut relinked = 0;
        let mut d = self.w();
        for i in cands {
            let e = &mut entries[i];
            let k = orphan_key(&e.n, e.s, e.m);
            let Some(ids) = d.orphans.get_mut(&k) else { continue };
            if ids.is_empty() {
                continue;
            }
            let old_id = ids.remove(0);
            if ids.is_empty() {
                d.orphans.remove(&k);
            }
            let Some(mut old) = d.files.remove(&old_id) else { continue };
            old.path = e.p.clone();
            old.name = e.n.clone();
            old.dir = dir_name(&e.p);
            old.id = file_id(&e.p);
            old.missing = false;
            e.t = old.tags.clone();
            e.r = old.rating;
            let nid = old.id.clone();
            d.files.insert(nid.clone(), old);
            relinked += 1;
            vecs().rekey(&[(old_id, nid.clone())].into_iter().collect(), &[(nid, e.p.clone())].into_iter().collect());
        }
        if relinked > 0 {
            self.touch(&mut d);
        }
        relinked
    }

    /// Flags remembered files that no longer exist and indexes them for relinking.
    pub fn check_missing(&self) {
        let snap: Vec<(String, String)> = self.r().files.iter().map(|(id, f)| (id.clone(), f.path.clone())).collect();
        let mut gone = std::collections::HashSet::new();
        for (id, p) in snap {
            if let Err(e) = std::fs::symlink_metadata(&p) {
                if e.kind() == std::io::ErrorKind::NotFound {
                    gone.insert(id);
                }
            }
        }
        let mut d = self.w();
        let mut orphans: HashMap<String, Vec<String>> = HashMap::new();
        for (id, f) in d.files.iter_mut() {
            f.missing = gone.contains(id);
            if f.missing && !f.isdir {
                orphans.entry(orphan_key(&f.name, f.size, f.mtime)).or_default().push(id.clone());
            }
        }
        d.orphans = orphans;
    }

    pub fn missing_list(&self) -> Vec<FileRec> {
        let d = self.r();
        let mut out: Vec<FileRec> = d.files.values().filter(|f| f.missing).cloned().collect();
        out.sort_by(|a, b| natural_cmp(&lower(&a.path), &lower(&b.path)));
        out
    }

    pub fn missing_count(&self) -> usize {
        self.r().files.values().filter(|f| f.missing).count()
    }

    pub fn purge_missing(&'static self, ids: &[String]) -> i64 {
        let mut d = self.w();
        let want: std::collections::HashSet<&String> = ids.iter().collect();
        let before = d.files.len();
        d.files.retain(|id, f| !(f.missing && (want.is_empty() || want.contains(id))));
        let n = (before - d.files.len()) as i64;
        if n > 0 {
            self.touch(&mut d);
        }
        n
    }

    // ---------- moves, copies ----------

    /// Follows files and folders that were moved or renamed through TagShelf.
    pub fn relocate(&'static self, pairs: &[Pair]) {
        if pairs.is_empty() {
            return;
        }
        let mut d = self.w();
        let mut moves: Vec<(String, String)> = vec![]; // old id, new path
        for (id, f) in d.files.iter() {
            for p in pairs {
                if let Some(np) = map_under(&f.path, &p.from, &p.to) {
                    moves.push((id.clone(), np));
                    break;
                }
            }
        }
        let mut id_map = HashMap::new();
        let mut path_map = HashMap::new();
        let mut moved = vec![];
        for (old, np) in &moves {
            if let Some(mut f) = d.files.remove(old) {
                f.path = np.clone();
                f.name = base_name(np);
                f.dir = dir_name(np);
                if !f.isdir {
                    f.ext = lower_ext(np);
                    f.kind = kind_of(&f.ext).to_string();
                }
                f.id = file_id(np);
                f.missing = false;
                moved.push((old.clone(), f));
            }
        }
        for (old, f) in moved {
            id_map.insert(old, f.id.clone());
            path_map.insert(f.id.clone(), f.path.clone());
            d.files.insert(f.id.clone(), f);
        }
        if !moves.is_empty() {
            vecs().rekey(&id_map, &path_map);
            self.touch(&mut d);
        }
        if crate::covers::relocate_covers(&mut d, pairs) {
            self.touch(&mut d);
        }
        // pictures chosen for Shelf tag pages follow too
        let mut cover_moved = false;
        for t in d.tags.values_mut() {
            if t.cover.is_empty() {
                continue;
            }
            if let Some(np) = pairs.iter().find_map(|p| map_under(&t.cover, &p.from, &p.to)) {
                t.cover = np;
                cover_moved = true;
            }
        }
        if cover_moved {
            self.touch(&mut d);
        }
        drop(d);
        // fingerprints also exist for untagged files, so follow those too
        vecs().relocate_paths(pairs);
    }

    /// Gives copies the same tags and rating as their originals.
    pub fn copy_meta(&'static self, pairs: &[Pair]) {
        let mut d = self.w();
        let mut n = 0;
        for p in pairs {
            let src = d.files.get(&file_id(&p.from)).cloned();
            vecs().copy(&p.from, &p.to);
            let Some(src) = src else { continue };
            let Ok(md) = std::fs::metadata(&p.to) else { continue };
            let mut nf = rec_from_meta(&p.to, &md);
            nf.tags = src.tags.clone();
            nf.rating = src.rating;
            d.files.insert(nf.id.clone(), nf);
            n += 1;
        }
        if n > 0 {
            self.touch(&mut d);
        }
    }

    // ---------- tags & metadata ----------

    pub fn tag_paths(&'static self, paths: &[String], add: &[String], remove: &[String]) -> (HashMap<String, Vec<String>>, Option<ApiErr>) {
        let mut d = self.w();
        let add_c: Vec<String> = add.iter().map(|a| d.canon(a)).filter(|c| !c.is_empty()).collect();
        let rem: std::collections::HashSet<String> =
            remove.iter().filter_map(|r| d.tag_idx.get(&lower(&clean_tag(r))).cloned()).collect();
        let now = now_unix();
        for a in &add_c {
            if let Some(t) = d.tags.get_mut(a) {
                t.used = now;
            }
        }
        let mut out = HashMap::new();
        let mut first_err = None;
        for p in paths {
            let id = file_id(p);
            if !d.files.contains_key(&id) {
                if add_c.is_empty() {
                    continue;
                }
                if let Err(e) = d.ensure(p) {
                    first_err.get_or_insert(ApiErr::from(e));
                    continue;
                }
            }
            let f = d.files.get_mut(&id).unwrap();
            let mut nt: Vec<String> = f.tags.iter().filter(|t| !rem.contains(*t)).cloned().collect();
            for a in &add_c {
                if !nt.contains(a) {
                    nt.push(a.clone());
                }
            }
            sort_tags(&mut nt);
            f.tags = nt.clone();
            let drop_it = nt.is_empty() && f.rating == 0;
            out.insert(p.clone(), nt);
            if drop_it {
                d.files.remove(&id);
            }
        }
        self.touch(&mut d);
        (out, first_err)
    }

    /// Sets exact tag lists (used by undo).
    pub fn set_exact_tags(&'static self, items: &serde_json::Map<String, Value>) -> HashMap<String, Option<Vec<String>>> {
        let mut d = self.w();
        let mut out = HashMap::new();
        for (p, tags) in items {
            let mut nt: Vec<String> = vec![];
            for t in strs_of(Some(tags)) {
                let c = d.canon(&t);
                if !c.is_empty() && !nt.contains(&c) {
                    nt.push(c);
                }
            }
            sort_tags(&mut nt);
            let id = file_id(p);
            if !d.files.contains_key(&id) {
                if nt.is_empty() {
                    out.insert(p.clone(), None);
                    continue;
                }
                if d.ensure(p).is_err() {
                    continue;
                }
            }
            let f = d.files.get_mut(&id).unwrap();
            f.tags = nt.clone();
            let drop_it = nt.is_empty() && f.rating == 0;
            out.insert(p.clone(), Some(nt));
            if drop_it {
                d.files.remove(&id);
            }
        }
        self.touch(&mut d);
        out
    }

    pub fn set_rating(&'static self, paths: &[String], r: i64) {
        let r = r.clamp(0, 5);
        let mut d = self.w();
        for p in paths {
            let id = file_id(p);
            if !d.files.contains_key(&id) && (r == 0 || d.ensure(p).is_err()) {
                continue;
            }
            let f = d.files.get_mut(&id).unwrap();
            f.rating = r;
            if r == 0 && f.tags.is_empty() {
                d.files.remove(&id);
            }
        }
        self.touch(&mut d);
    }

    pub fn create_tag(&'static self, name: &str) -> ApiResult<String> {
        let mut d = self.w();
        let c = d.canon(name);
        if c.is_empty() {
            return bad("tag name is empty");
        }
        self.touch(&mut d);
        Ok(c)
    }

    pub fn rename_tag(&'static self, from: &str, to: &str) -> ApiResult<()> {
        let to = clean_tag(to);
        if to.is_empty() {
            return bad("tag name is empty");
        }
        let mut d = self.w();
        let Some(src) = d.tag_idx.get(&lower(&clean_tag(from))).cloned() else { return bad("no such tag") };
        let existing = d.tag_idx.get(&lower(&to)).cloned();
        let merge = matches!(&existing, Some(e) if lower(e) != lower(&src));
        let dst = if merge { existing.unwrap() } else { to };
        for f in d.files.values_mut() {
            if !f.tags.contains(&src) {
                continue;
            }
            let mut nt: Vec<String> = f.tags.iter().filter(|t| **t != src).cloned().collect();
            if !nt.contains(&dst) {
                nt.push(dst.clone());
            }
            sort_tags(&mut nt);
            f.tags = nt;
        }
        for rej in d.rejected.values_mut() {
            for t in rej.iter_mut() {
                if *t == src {
                    *t = dst.clone();
                }
            }
        }
        let info = d.tags.remove(&src);
        d.tag_idx.remove(&lower(&src));
        if !merge {
            let info = info.unwrap_or_else(|| TagInfo { color: auto_color(&dst), ..Default::default() });
            d.tags.insert(dst.clone(), info);
            d.tag_idx.insert(lower(&dst), dst);
        } else if let (Some(old), Some(t)) = (info, d.tags.get_mut(&dst)) {
            // merging: keep the target's settings, borrow what it doesn't have yet
            if t.category.is_empty() {
                t.category = old.category;
            }
            if t.cover.is_empty() {
                t.cover = old.cover;
            }
        }
        self.touch(&mut d);
        Ok(())
    }

    pub fn delete_tag(&'static self, name: &str) {
        let mut d = self.w();
        let Some(c) = d.tag_idx.get(&lower(&clean_tag(name))).cloned() else { return };
        d.files.retain(|_, f| {
            if f.tags.contains(&c) {
                f.tags.retain(|t| *t != c);
                return !(f.tags.is_empty() && f.rating == 0);
            }
            true
        });
        d.tags.remove(&c);
        d.tag_idx.remove(&lower(&c));
        self.touch(&mut d);
    }

    pub fn set_tag_color(&'static self, name: &str, color: &str) {
        let mut d = self.w();
        if let Some(c) = d.tag_idx.get(&lower(&clean_tag(name))).cloned() {
            if color.len() == 7 && color.starts_with('#') {
                if let Some(t) = d.tags.get_mut(&c) {
                    t.color = color.to_string();
                }
                self.touch(&mut d);
            }
        }
    }

    pub fn save_view(&'static self, name: &str, state: Value) {
        let name = name.trim().to_string();
        let mut d = self.w();
        if let Some(v) = d.views.iter_mut().find(|v| lower(&v.name) == lower(&name)) {
            v.state = state;
        } else {
            d.views.push(View { id: rand_hex(4), name, state });
        }
        self.touch(&mut d);
    }

    pub fn delete_view(&'static self, id: &str) {
        let mut d = self.w();
        d.views.retain(|v| v.id != id);
        self.touch(&mut d);
    }

    pub fn set_settings(&'static self, raw: Value) {
        let mut d = self.w();
        d.settings = Some(raw);
        self.touch(&mut d);
    }

    pub fn set_pin(&'static self, path: &str, on: bool) {
        let mut d = self.w();
        d.pins.retain(|p| !same_path(p, path));
        if on {
            d.pins.push(path.to_string());
        }
        self.touch(&mut d);
    }

    pub fn add_recent_dir(&'static self, p: &str) {
        let mut d = self.w();
        let mut out = vec![p.to_string()];
        for r in &d.recent {
            if !same_path(r, p) && out.len() < 8 {
                out.push(r.clone());
            }
        }
        d.recent = out;
        self.touch(&mut d);
    }

    pub fn reject(&'static self, paths: &[String], tag: &str) {
        let mut d = self.w();
        for p in paths {
            let list = d.rejected.entry(file_id(p)).or_default();
            if !list.iter().any(|t| t == tag) {
                list.push(tag.to_string());
            }
        }
        self.touch(&mut d);
    }

    /// The tags used by remembered files at or inside the given paths (for the delete warning).
    pub fn tags_under(&self, paths: &[String]) -> (Vec<(String, i64)>, i64) {
        let d = self.r();
        let mut counts: HashMap<String, i64> = HashMap::new();
        let mut files = 0;
        for f in d.files.values() {
            if f.tags.is_empty() || f.missing || !paths.iter().any(|p| under_root(&f.path, p)) {
                continue;
            }
            files += 1;
            for t in &f.tags {
                *counts.entry(t.clone()).or_default() += 1;
            }
        }
        let mut out: Vec<(String, i64)> = counts.into_iter().collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| lower(&a.0).cmp(&lower(&b.0))));
        (out, files)
    }

    pub fn prefs(&self) -> Prefs {
        self.r().prefs.clone()
    }

    pub fn set_prefs(&'static self, p: Prefs) {
        let mut d = self.w();
        d.prefs = p;
        self.touch(&mut d);
    }

    pub fn tag_list(&self) -> Vec<TagOut> {
        let d = self.r();
        let mut counts: HashMap<&str, i64> = HashMap::new();
        for f in d.files.values() {
            for t in &f.tags {
                *counts.entry(t.as_str()).or_default() += 1;
            }
        }
        let mut out: Vec<TagOut> = d
            .tags
            .iter()
            .map(|(n, ti)| TagOut { name: n.clone(), color: ti.color.clone(), count: *counts.get(n.as_str()).unwrap_or(&0), used: ti.used, category: ti.category.clone() })
            .collect();
        out.sort_by(|a, b| lower(&a.name).cmp(&lower(&b.name)));
        out
    }
}

/// A tiny logger that writes to tagshelf.log in the data folder.
pub mod log {
    use std::io::Write;
    use std::sync::Mutex;
    static FILE: Mutex<Option<std::fs::File>> = Mutex::new(None);

    pub fn init(dir: &str) {
        let f = std::fs::OpenOptions::new().create(true).append(true).open(crate::util::join(dir, "tagshelf.log")).ok();
        *FILE.lock().unwrap() = f;
    }
    pub fn info(m: &str) {
        write(m);
    }
    pub fn warn(m: &str) {
        write(m);
    }
    fn write(m: &str) {
        if let Some(f) = FILE.lock().unwrap().as_mut() {
            let _ = writeln!(f, "{} {}", crate::util::now_unix(), m);
        }
    }
}
