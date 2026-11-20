//! A deliberately small "AI": every image/video gets a 152-number fingerprint (colour layout,
//! colour histogram, edge directions, a few global measures) computed in the browser. Tag
//! suggestions come from three signals that all learn from the user's own tagging:
//!   1. visual neighbours - the most similar files you already tagged,
//!   2. words             - file / folder name words that went with a tag before,
//!   3. habits            - tags often used together with tags the file already has.
//! Nothing is ever applied automatically; the UI only offers the suggestions.

use crate::store::{Library, Pair};
use crate::util::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use std::time::Duration;

pub const VEC_DIM: usize = 152;
const MIN_TRAINED: i64 = 6;

#[derive(Clone)]
pub struct VecRec {
    pub path: String,
    pub mtime: i64,
    pub size: i64,
    pub v: [i8; VEC_DIM],
}

pub struct VecIndex {
    rev: u64,
    pub ids: Vec<String>,
    pub paths: Vec<String>,
    mat: Vec<f32>, // centred, unit-length rows
    mean: [f32; VEC_DIM],
}

#[derive(Default)]
struct VecInner {
    path: String,
    m: HashMap<String, VecRec>,
    rev: u64,
    idx: Option<Arc<VecIndex>>,
}

pub struct VecStore {
    inner: RwLock<VecInner>,
    saver: Debounce,
}

static VECS: LazyLock<VecStore> = LazyLock::new(|| VecStore { inner: RwLock::new(VecInner::default()), saver: Debounce::new(Duration::from_secs(4)) });

pub fn vecs() -> &'static VecStore {
    &VECS
}

fn rd16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn rd32(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
fn rd64(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}

impl VecStore {
    fn r(&self) -> std::sync::RwLockReadGuard<'_, VecInner> {
        self.inner.read().unwrap_or_else(|e| e.into_inner())
    }
    fn w(&self) -> std::sync::RwLockWriteGuard<'_, VecInner> {
        self.inner.write().unwrap_or_else(|e| e.into_inner())
    }

    /// Loads vectors.bin (format "TSV2", shared with the Go version).
    pub fn open(&self, dir: &str) {
        let mut s = self.w();
        s.path = join(dir, "vectors.bin");
        let Ok(b) = std::fs::read(&s.path) else { return };
        if b.len() < 10 || &b[..4] != b"TSV2" || rd16(&b, 4) as usize != VEC_DIM {
            return; // missing, or fingerprint format changed: they will be recomputed
        }
        let n = rd32(&b, 6) as usize;
        let mut off = 10;
        for _ in 0..n {
            if off + 8 > b.len() {
                break;
            }
            off += 6; // id (recomputed from the path)
            let pl = rd16(&b, off) as usize;
            off += 2;
            if off + pl + 16 + VEC_DIM > b.len() {
                break;
            }
            let path = String::from_utf8_lossy(&b[off..off + pl]).into_owned();
            off += pl;
            let mtime = rd64(&b, off) as i64;
            let size = rd64(&b, off + 8) as i64;
            off += 16;
            let mut v = [0i8; VEC_DIM];
            for (j, x) in v.iter_mut().enumerate() {
                *x = b[off + j] as i8;
            }
            off += VEC_DIM;
            s.m.insert(file_id(&path), VecRec { path, mtime, size, v });
        }
    }

    pub fn save(&self) -> std::io::Result<()> {
        let (buf, p) = {
            let s = self.r();
            let mut buf = Vec::with_capacity(10 + s.m.len() * (8 + 100 + 16 + VEC_DIM));
            buf.extend_from_slice(b"TSV2");
            buf.extend_from_slice(&(VEC_DIM as u16).to_le_bytes());
            buf.extend_from_slice(&(s.m.len() as u32).to_le_bytes());
            for (id, r) in &s.m {
                let mut idb = [0u8; 6];
                for (i, x) in idb.iter_mut().enumerate() {
                    *x = u8::from_str_radix(id.get(i * 2..i * 2 + 2).unwrap_or("00"), 16).unwrap_or(0);
                }
                buf.extend_from_slice(&idb);
                buf.extend_from_slice(&(r.path.len() as u16).to_le_bytes());
                buf.extend_from_slice(r.path.as_bytes());
                buf.extend_from_slice(&(r.mtime as u64).to_le_bytes());
                buf.extend_from_slice(&(r.size as u64).to_le_bytes());
                buf.extend(r.v.iter().map(|&x| x as u8));
            }
            (buf, s.path.clone())
        };
        if p.is_empty() {
            return Ok(());
        }
        let tmp = format!("{p}.tmp");
        std::fs::write(&tmp, buf)?;
        std::fs::rename(&tmp, &p)
    }

    fn dirty(&'static self, s: &mut VecInner) {
        s.rev += 1;
        self.saver.schedule(move || {
            let _ = self.save();
        });
    }

    pub fn get(&self, id: &str, mtime: i64, size: i64) -> Option<VecRec> {
        let s = self.r();
        s.m.get(id).filter(|r| r.mtime == mtime && r.size == size).cloned()
    }

    pub fn has_id(&self, id: &str) -> bool {
        self.r().m.contains_key(id)
    }

    pub fn count(&self) -> usize {
        self.r().m.len()
    }

    pub fn put(&'static self, path: &str, mtime: i64, size: i64, v: &[f64]) -> Result<(), String> {
        if v.len() != VEC_DIM {
            return Err("wrong fingerprint size".into());
        }
        let mut r = VecRec { path: path.to_string(), mtime, size, v: [0; VEC_DIM] };
        for (i, &x) in v.iter().enumerate() {
            if !x.is_finite() {
                return Err("bad fingerprint".into());
            }
            r.v[i] = (x.clamp(-1.0, 1.0) * 127.0).round() as i8;
        }
        let mut s = self.w();
        s.m.insert(file_id(path), r);
        self.dirty(&mut s);
        Ok(())
    }

    pub fn rekey(&'static self, id_map: &HashMap<String, String>, path_map: &HashMap<String, String>) {
        let mut s = self.w();
        for (old, nw) in id_map {
            if let Some(mut r) = s.m.remove(old) {
                if let Some(p) = path_map.get(nw) {
                    r.path = p.clone();
                }
                s.m.insert(nw.clone(), r);
            }
        }
        self.dirty(&mut s);
    }

    pub fn relocate_paths(&'static self, pairs: &[Pair]) {
        let mut s = self.w();
        let mut moves = vec![];
        for (id, r) in &s.m {
            for p in pairs {
                if let Some(np) = map_under(&r.path, &p.from, &p.to) {
                    moves.push((id.clone(), np));
                    break;
                }
            }
        }
        let mut moved = vec![];
        for (old, np) in &moves {
            if let Some(mut r) = s.m.remove(old) {
                r.path = np.clone();
                moved.push(r);
            }
        }
        for r in moved {
            s.m.insert(file_id(&r.path), r);
        }
        if !moves.is_empty() {
            self.dirty(&mut s);
        }
    }

    pub fn copy(&'static self, from: &str, to: &str) {
        let Ok(md) = std::fs::metadata(to) else { return };
        let mut s = self.w();
        if let Some(r) = s.m.get(&file_id(from)).cloned() {
            let c = VecRec { path: to.to_string(), mtime: mtime_unix(&md), size: md.len() as i64, v: r.v };
            s.m.insert(file_id(to), c);
            self.dirty(&mut s);
        }
    }

    /// A matrix of mean-centred unit vectors for fast similarity search (cached until vectors change).
    pub fn index(&self) -> Arc<VecIndex> {
        {
            let s = self.r();
            if let Some(ix) = &s.idx {
                if ix.rev == s.rev {
                    return ix.clone();
                }
            }
        }
        let (rev, ids, paths, mut mat, mean) = {
            let s = self.r();
            let n = s.m.len();
            let mut ids = Vec::with_capacity(n);
            let mut paths = Vec::with_capacity(n);
            let mut mat = vec![0f32; n * VEC_DIM];
            let mut sum = [0f64; VEC_DIM];
            for (id, r) in &s.m {
                let row = ids.len();
                ids.push(id.clone());
                paths.push(r.path.clone());
                for (j, &x) in r.v.iter().enumerate() {
                    let f = x as f32 / 127.0;
                    mat[row * VEC_DIM + j] = f;
                    sum[j] += f as f64;
                }
            }
            let mut mean = [0f32; VEC_DIM];
            if n > 0 {
                for j in 0..VEC_DIM {
                    mean[j] = (sum[j] / n as f64) as f32;
                }
            }
            (s.rev, ids, paths, mat, mean)
        };
        for row in mat.chunks_exact_mut(VEC_DIM) {
            let mut nn = 0f64;
            for j in 0..VEC_DIM {
                row[j] -= mean[j];
                nn += (row[j] * row[j]) as f64;
            }
            if nn > 1e-12 {
                let inv = (1.0 / nn.sqrt()) as f32;
                for x in row.iter_mut() {
                    *x *= inv;
                }
            }
        }
        let ix = Arc::new(VecIndex { rev, ids, paths, mat, mean });
        let mut s = self.w();
        if s.rev == rev {
            s.idx = Some(ix.clone());
        }
        ix
    }
}

impl VecIndex {
    pub fn centred(&self, v: &[i8; VEC_DIM]) -> [f32; VEC_DIM] {
        let mut q = [0f32; VEC_DIM];
        let mut nn = 0f64;
        for j in 0..VEC_DIM {
            q[j] = v[j] as f32 / 127.0 - self.mean[j];
            nn += (q[j] * q[j]) as f64;
        }
        if nn > 1e-12 {
            let inv = (1.0 / nn.sqrt()) as f32;
            for x in q.iter_mut() {
                *x *= inv;
            }
        }
        q
    }

    /// The k most similar rows accepted by `ok`, best first.
    pub fn nearest(&self, q: &[f32; VEC_DIM], k: usize, ok: impl Fn(usize) -> bool) -> Vec<(usize, f32)> {
        let mut top: Vec<(usize, f32)> = Vec::with_capacity(k + 1);
        for row in 0..self.ids.len() {
            if !ok(row) {
                continue;
            }
            let m = &self.mat[row * VEC_DIM..(row + 1) * VEC_DIM];
            let d: f32 = m.iter().zip(q.iter()).map(|(a, b)| a * b).sum();
            if top.len() == k && d <= top[k - 1].1 {
                continue;
            }
            let pos = top.partition_point(|x| x.1 >= d);
            top.insert(pos, (row, d));
            top.truncate(k);
        }
        top
    }
}

// ---------- name words ----------

fn stop_word(w: &str) -> bool {
    matches!(
        w,
        "img" | "image" | "images" | "photo" | "photos" | "pic" | "pics" | "dsc" | "jpg" | "jpeg" | "png" | "gif" | "webp" | "copy" | "new"
            | "final" | "the" | "and" | "for" | "with" | "untitled" | "download" | "downloads" | "file" | "files" | "video" | "videos"
            | "vid" | "mov" | "mp4" | "desktop" | "pictures" | "documents" | "users" | "temp" | "tmp"
    )
}

pub fn words(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut seen = HashSet::new();
    let mut cur = String::new();
    let mut prev = ' ';
    let mut flush = |cur: &mut String, out: &mut Vec<String>| {
        if cur.chars().count() >= 3 {
            let w = cur.to_lowercase();
            let all_digits = w.chars().all(|c| c.is_numeric());
            if !all_digits && !stop_word(&w) && seen.insert(w.clone()) {
                out.push(w);
            }
        }
        cur.clear();
    };
    for r in s.chars() {
        if !r.is_alphanumeric() {
            flush(&mut cur, &mut out);
            prev = r;
            continue;
        }
        if r.is_uppercase() && prev.is_lowercase() {
            flush(&mut cur, &mut out);
        }
        cur.push(r);
        prev = r;
    }
    flush(&mut cur, &mut out);
    out
}

pub fn name_words(path: &str) -> (Vec<String>, Vec<String>) {
    let base = base_name(path);
    let stem = &base[..base.len() - ext_of(&base).len()];
    (words(stem), words(&base_name(&dir_name(path))))
}

// ---------- learning tables ----------

#[derive(Default)]
struct Tables {
    rev: u64,
    tok_count: HashMap<String, i64>,
    tok_tag: HashMap<String, HashMap<String, i64>>,
    tag_count: HashMap<String, i64>,
    co: HashMap<String, HashMap<String, i64>>,
}

pub struct Ai {
    lib: &'static Library,
    tb: Mutex<Option<Arc<Tables>>>,
}

#[derive(Serialize, Clone)]
pub struct Sug {
    pub tag: String,
    pub score: f64,
    pub why: Vec<String>,
}

#[derive(Serialize, Default)]
pub struct SugOut {
    pub ready: bool,
    pub trained: i64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub need: Vec<String>,
    pub items: Vec<Sug>,
}

#[derive(Default, Clone)]
struct Acc {
    vis: f64,
    tok: f64,
    co: f64,
    why: Vec<String>,
}

#[derive(Serialize)]
pub struct Similar {
    pub path: String,
    pub sim: f64,
}

#[derive(Serialize, Default)]
pub struct TestOut {
    pub tested: i64,
    pub hit: f64,
    pub recall: f64,
    pub trained: i64,
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

impl Ai {
    pub fn new(lib: &'static Library) -> Self {
        Ai { lib, tb: Mutex::new(None) }
    }

    fn tables(&self) -> Arc<Tables> {
        let d = self.lib.r();
        let mut cache = self.tb.lock().unwrap();
        if let Some(t) = cache.as_ref() {
            if t.rev == d.rev {
                return t.clone();
            }
        }
        let mut t = Tables { rev: d.rev, ..Default::default() };
        for f in d.files.values() {
            if f.tags.is_empty() || f.isdir {
                continue;
            }
            let (n, dw) = name_words(&f.path);
            let union: HashSet<String> = n.into_iter().chain(dw).collect();
            for w in union {
                *t.tok_count.entry(w.clone()).or_default() += 1;
                let m = t.tok_tag.entry(w).or_default();
                for tg in &f.tags {
                    *m.entry(tg.clone()).or_default() += 1;
                }
            }
            for u in &f.tags {
                *t.tag_count.entry(u.clone()).or_default() += 1;
                let m = t.co.entry(u.clone()).or_default();
                for v in &f.tags {
                    if v != u {
                        *m.entry(v.clone()).or_default() += 1;
                    }
                }
            }
        }
        let t = Arc::new(t);
        *cache = Some(t.clone());
        t
    }

    fn score_one(&self, path: &str, ix: &VecIndex, tb: &Tables, loo: bool, skip: &HashSet<String>, md: &std::fs::Metadata) -> (HashMap<String, Acc>, bool) {
        let mut res: HashMap<String, Acc> = HashMap::new();
        let id = file_id(path);
        let (own_exists, own_tags, tag_names) = {
            let d = self.lib.r();
            let own = d.files.get(&id);
            (own.is_some(), own.map(|f| f.tags.clone()).unwrap_or_default(), d.tags.keys().cloned().collect::<Vec<_>>())
        };

        // 1. visual neighbours
        let mut need_vec = false;
        let kind = kind_of(&lower_ext(path));
        if kind == "image" || kind == "video" {
            match vecs().get(&id, mtime_unix(md), md.len() as i64) {
                None => need_vec = true,
                Some(r) if !ix.ids.is_empty() => {
                    let q = ix.centred(&r.v);
                    let d = self.lib.r();
                    let nb = ix.nearest(&q, 10, |row| {
                        let rid = &ix.ids[row];
                        if *rid == id || skip.contains(rid) {
                            return false;
                        }
                        d.files.get(rid).map(|f| !f.tags.is_empty()).unwrap_or(false)
                    });
                    let mut hits: Vec<(Vec<String>, f64)> = vec![];
                    let mut wsum = 0.0;
                    let mut best = -1f32;
                    for (row, sim) in nb {
                        let Some(f) = d.files.get(&ix.ids[row]) else { continue };
                        let w = (8.0 * sim as f64).exp();
                        hits.push((f.tags.clone(), w));
                        wsum += w;
                        if sim > best {
                            best = sim;
                        }
                    }
                    drop(d);
                    if wsum > 0.0 {
                        let conf = ((best as f64 - 0.25) / 0.45).clamp(0.0, 1.0);
                        let mut per: HashMap<String, f64> = HashMap::new();
                        let mut cnt: HashMap<String, i64> = HashMap::new();
                        for (tags, w) in &hits {
                            for t in tags {
                                *per.entry(t.clone()).or_default() += w;
                                *cnt.entry(t.clone()).or_default() += 1;
                            }
                        }
                        for (t, w) in per {
                            let s = w / wsum * conf;
                            if s >= 0.05 {
                                let x = res.entry(t.clone()).or_default();
                                x.vis = s;
                                x.why.push(format!("looks like {} of your “{}” files", cnt[&t], t));
                            }
                        }
                    }
                }
                Some(_) => {}
            }
        }

        // 2. words in the file / folder name
        let (nw, dw) = name_words(path);
        let ws: Vec<(String, f64)> = nw.iter().map(|w| (w.clone(), 1.0)).chain(dw.iter().map(|w| (w.clone(), 0.7))).collect();
        let own_words: HashSet<String> = if loo && own_exists { nw.iter().chain(dw.iter()).cloned().collect() } else { HashSet::new() };
        for (w, k) in &ws {
            let mut ct = *tb.tok_count.get(w).unwrap_or(&0);
            if own_words.contains(w) {
                ct -= 1;
            }
            if ct >= 2 {
                if let Some(m) = tb.tok_tag.get(w) {
                    for (t, &c0) in m {
                        let mut c = c0;
                        if own_words.contains(w) && own_tags.contains(t) {
                            c -= 1;
                        }
                        if c <= 0 {
                            continue;
                        }
                        let p = c as f64 / (ct as f64 + 1.0) * k;
                        if p >= 0.2 {
                            let x = res.entry(t.clone()).or_default();
                            if p > x.tok {
                                x.tok = p;
                                x.why.push(format!("name has “{w}” (went with “{t}” before)"));
                            }
                        }
                    }
                }
            }
        }
        for t in &tag_names {
            let tw = words(t);
            if tw.is_empty() {
                continue;
            }
            let found = tw.iter().all(|w| ws.iter().any(|(e, _)| e == w || *e == format!("{w}s") || format!("{e}s") == *w));
            if found {
                let x = res.entry(t.clone()).or_default();
                if x.tok < 0.6 {
                    x.tok = 0.6;
                    x.why.push(format!("name contains “{}”", t.to_lowercase()));
                }
            }
        }

        // 3. habits: tags often used together with the ones this file already has
        if !loo {
            for u in &own_tags {
                let n = *tb.tag_count.get(u).unwrap_or(&0);
                if n < 3 {
                    continue;
                }
                if let Some(m) = tb.co.get(u) {
                    for (t, &c) in m {
                        let p = c as f64 / n as f64;
                        if c >= 3 && p >= 0.3 {
                            let x = res.entry(t.clone()).or_default();
                            let s = 0.6 * p;
                            if s > x.co {
                                x.co = s;
                                x.why.push(format!("often used together with “{u}”"));
                            }
                        }
                    }
                }
            }
        }
        (res, need_vec)
    }

    /// Tag ideas for one or more files, averaged when several are given.
    pub fn suggest(&self, paths: &[String], loo: bool) -> SugOut {
        let mut out = SugOut::default();
        let ix = vecs().index();
        let tb = self.tables();
        let rejected = {
            let d = self.lib.r();
            for (rid, f) in &d.files {
                if !f.tags.is_empty() && !f.isdir && vecs().has_id(rid) {
                    out.trained += 1;
                }
            }
            d.rejected.clone()
        };
        out.ready = out.trained >= MIN_TRAINED;
        let skip: HashSet<String> = paths.iter().map(|p| file_id(p)).collect();
        let mut total: HashMap<String, Acc> = HashMap::new();
        let mut n = 0i64;
        let mut exclude: HashMap<String, i64> = HashMap::new();
        for p in paths {
            let Ok(md) = std::fs::metadata(p) else { continue };
            if md.is_dir() {
                continue;
            }
            n += 1;
            let (sc, need) = self.score_one(p, &ix, &tb, loo, &skip, &md);
            if need {
                out.need.push(p.clone());
            }
            let id = file_id(p);
            if !loo {
                // when testing, the file's own tags are the answer key
                if let Some(f) = self.lib.r().files.get(&id) {
                    for t in &f.tags {
                        *exclude.entry(t.clone()).or_default() += 1;
                    }
                }
            }
            for t in rejected.get(&id).into_iter().flatten() {
                *exclude.entry(t.clone()).or_default() += paths.len() as i64 + 1;
            }
            for (t, x) in sc {
                let s = 1.0 - (1.0 - x.vis) * (1.0 - x.tok) * (1.0 - x.co);
                let tt = total.entry(t).or_default();
                tt.vis += s; // running sum
                if tt.why.len() < 2 {
                    tt.why.extend(x.why);
                }
            }
        }
        if n == 0 {
            return out;
        }
        for (t, x) in total {
            if *exclude.get(&t).unwrap_or(&0) >= n {
                continue;
            }
            let s = x.vis / n as f64;
            if s < 0.18 {
                continue;
            }
            let why: Vec<String> = x.why.into_iter().take(2).collect();
            out.items.push(Sug { tag: t, score: round2(s), why });
        }
        out.items.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.tag.cmp(&b.tag)));
        out.items.truncate(10);
        out
    }

    /// The files that look most like the given one. Returns (items, needs a fingerprint first).
    pub fn find_similar(&self, path: &str, n: usize) -> (Vec<Similar>, bool) {
        let Ok(md) = std::fs::metadata(path) else { return (vec![], false) };
        let self_id = file_id(path);
        let Some(r) = vecs().get(&self_id, mtime_unix(&md), md.len() as i64) else { return (vec![], true) };
        let ix = vecs().index();
        let q = ix.centred(&r.v);
        let nb = ix.nearest(&q, n + 5, |row| ix.ids[row] != self_id);
        let mut out = vec![];
        for (row, sim) in nb {
            let p = &ix.paths[row];
            if std::fs::metadata(p).is_err() {
                continue;
            }
            out.push(Similar { path: p.clone(), sim: (sim as f64 * 1000.0).round() / 1000.0 });
            if out.len() >= n {
                break;
            }
        }
        (out, false)
    }

    /// Tagged media files that still need a fingerprint.
    pub fn backlog(&self, limit: usize) -> (Vec<String>, i64) {
        let d = self.lib.r();
        let mut paths = vec![];
        let mut total = 0;
        for (id, f) in &d.files {
            if f.tags.is_empty() || f.isdir || f.missing || (f.kind != "image" && f.kind != "video") {
                continue;
            }
            if vecs().get(id, f.mtime, f.size).is_some() {
                continue;
            }
            total += 1;
            if paths.len() < limit {
                paths.push(f.path.clone());
            }
        }
        (paths, total)
    }

    /// Hides each tagged file's own tags in turn and checks whether the suggestions would have found them.
    pub fn test(&self, max: usize) -> TestOut {
        let mut cands: Vec<String> = {
            let d = self.lib.r();
            d.files.iter().filter(|(id, f)| !f.tags.is_empty() && !f.isdir && vecs().get(id, f.mtime, f.size).is_some()).map(|(_, f)| f.path.clone()).collect()
        };
        let mut out = TestOut { trained: cands.len() as i64, ..Default::default() };
        if (cands.len() as i64) < MIN_TRAINED {
            return out;
        }
        cands.sort_by_key(|p| file_id(p));
        let step = if cands.len() > max { cands.len() / max } else { 1 };
        let (mut hits, mut found, mut truth) = (0f64, 0f64, 0f64);
        let mut i = 0;
        while i < cands.len() && (out.tested as usize) < max {
            let p = &cands[i];
            i += step;
            let tags = self.lib.r().files.get(&file_id(p)).map(|f| f.tags.clone()).unwrap_or_default();
            if tags.is_empty() {
                continue;
            }
            let res = self.suggest(std::slice::from_ref(p), true);
            let got = res.items.iter().take(5).filter(|s| tags.contains(&s.tag)).count();
            if got > 0 {
                hits += 1.0;
            }
            found += got as f64;
            truth += tags.len() as f64;
            out.tested += 1;
        }
        if out.tested > 0 {
            out.hit = round2(hits / out.tested as f64);
            out.recall = round2(found / truth);
        }
        out
    }
}
