//! Browsing and changing the file system: listing, tree, new folder, rename, move, copy.

use crate::platform;
use crate::store::{Library, Pair};
use crate::util::*;
use serde::Serialize;
use std::fs;

fn is_false(b: &bool) -> bool {
    !*b
}
fn is_zero(n: &i64) -> bool {
    *n == 0
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Entry {
    pub n: String,
    pub p: String,
    #[serde(skip_serializing_if = "is_false")]
    pub d: bool,
    pub k: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub x: String,
    pub s: i64,
    pub m: i64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub t: Vec<String>,
    #[serde(skip_serializing_if = "is_zero")]
    pub r: i64,
    #[serde(skip_serializing_if = "is_false")]
    pub h: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub rel: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Drive {
    pub name: String,
    pub path: String,
    pub kind: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Place {
    pub name: String,
    pub path: String,
    pub icon: String,
}

pub fn entry_from(dir: &str, name: &str, md: &fs::Metadata) -> Entry {
    let full = join(dir, name);
    let mut e = Entry {
        n: name.to_string(),
        p: full,
        d: md.is_dir(),
        s: md.len() as i64,
        m: mtime_unix(md),
        h: platform::is_hidden(md, name),
        ..Default::default()
    };
    if e.d {
        e.k = "folder".into();
        e.s = 0;
    } else {
        e.x = lower_ext(name);
        e.k = kind_of(&e.x).into();
    }
    e
}

fn odd_type(ft: &fs::FileType) -> bool {
    ft.is_symlink() || (!ft.is_dir() && !ft.is_file())
}

/// Lists a folder (or everything below it when `recursive`). Returns (entries, truncated).
pub fn list_dir(root: &str, recursive: bool, show_hidden: bool, limit: usize, deadline: std::time::Instant) -> ApiResult<(Vec<Entry>, bool)> {
    if !recursive {
        let rd = fs::read_dir(root)?;
        let mut des: Vec<_> = rd.flatten().collect();
        des.sort_by_key(|d| d.file_name()); // alphabetical, like the Go version
        let mut out = Vec::with_capacity(des.len());
        for de in des {
            let name = de.file_name().to_string_lossy().into_owned();
            let Ok(ft) = de.file_type() else { continue };
            let md = if odd_type(&ft) { fs::metadata(de.path()) } else { de.metadata() };
            let Ok(md) = md else { continue };
            let e = entry_from(root, &name, &md);
            if e.h && !show_hidden {
                continue;
            }
            out.push(e);
        }
        return Ok((out, false));
    }
    let mut out = Vec::new();
    let mut truncated = false;
    fs::read_dir(root)?; // report an unreadable root as an error, like the Go version
    // depth-first, lexical order like filepath.WalkDir
    fn walk(root: &str, dir: &str, show_hidden: bool, limit: usize, out: &mut Vec<Entry>, truncated: &mut bool, deadline: std::time::Instant) -> bool {
        if std::time::Instant::now() > deadline {
            return false;
        }
        let Ok(rd) = fs::read_dir(dir) else { return true };
        let mut des: Vec<_> = rd.flatten().collect();
        des.sort_by_key(|d| d.file_name());
        for de in des {
            let name = de.file_name().to_string_lossy().into_owned();
            let Ok(ft) = de.file_type() else { continue };
            if odd_type(&ft) {
                continue;
            }
            let Ok(md) = de.metadata() else { continue };
            if ft.is_dir() {
                if !show_hidden && platform::is_hidden(&md, &name) {
                    continue;
                }
                if !walk(root, &join(dir, &name), show_hidden, limit, out, truncated, deadline) {
                    return false;
                }
                continue;
            }
            if !show_hidden && platform::is_hidden(&md, &name) {
                continue;
            }
            if out.len() >= limit {
                *truncated = true;
                return false;
            }
            let mut e = entry_from(dir, &name, &md);
            if dir != root {
                let cut = root.trim_end_matches(SEP).len() + 1;
                e.rel = dir.get(cut..).unwrap_or("").to_string();
            }
            out.push(e);
        }
        true
    }
    walk(root, root, show_hidden, limit, &mut out, &mut truncated, deadline);
    Ok((out, truncated))
}

pub fn tree_children(path: &str, show_hidden: bool) -> ApiResult<Vec<TreeNode>> {
    let rd = fs::read_dir(path)?;
    let mut out = vec![];
    for de in rd.flatten() {
        let name = de.file_name().to_string_lossy().into_owned();
        let full = join(path, &name);
        let Ok(ft) = de.file_type() else { continue };
        let mut is_dir = ft.is_dir();
        if odd_type(&ft) {
            match fs::metadata(&full) {
                Ok(m) if m.is_dir() => is_dir = true,
                _ => continue,
            }
        }
        if !is_dir {
            continue;
        }
        if let Ok(md) = de.metadata() {
            if !show_hidden && platform::is_hidden(&md, &name) {
                continue;
            }
        }
        out.push(TreeNode { name, path: full });
    }
    out.sort_by(|a, b| natural_cmp(&lower(&a.name), &lower(&b.name)));
    Ok(out)
}

pub fn quick_places() -> Vec<Place> {
    let Some(home) = home_dir() else { return vec![] };
    let mut out = vec![Place { name: "Home".into(), path: home.clone(), icon: "home".into() }];
    let od = std::env::var("OneDrive").unwrap_or_default();
    let opt = |n: &str| {
        let mut l = vec![join(&home, n)];
        if !od.is_empty() {
            l.push(join(&od, n));
        }
        l
    };
    let mut add = |name: &str, icon: &str, cands: Vec<String>| {
        for c in cands {
            if fs::metadata(&c).map(|m| m.is_dir()).unwrap_or(false) {
                out.push(Place { name: name.into(), path: c, icon: icon.into() });
                return;
            }
        }
    };
    add("Desktop", "desktop", opt("Desktop"));
    add("Downloads", "download", vec![join(&home, "Downloads")]);
    add("Documents", "doc", opt("Documents"));
    add("Pictures", "image", opt("Pictures"));
    add("Videos", "video", opt(if cfg!(target_os = "macos") { "Movies" } else { "Videos" }));
    add("Music", "music", opt("Music"));
    out
}

// ---------- names & conflicts ----------

pub fn valid_name(name: &str) -> ApiResult<()> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return bad("that name is not allowed");
    }
    if name.contains(['\\', '/', '\0']) {
        return bad("a name can't contain slashes");
    }
    if IS_WIN {
        if name.contains(['<', '>', ':', '"', '|', '?', '*']) {
            return bad("a name can't contain any of  < > : \" | ? *");
        }
        if name.ends_with('.') || name.ends_with(' ') {
            return bad("a name can't end with a dot or a space");
        }
    }
    Ok(())
}

pub fn unique_path(dir: &str, name: &str) -> String {
    let p = join(dir, name);
    if !exists(&p) {
        return p;
    }
    let (mut stem, mut ext) = {
        let e = ext_of(name);
        (name[..name.len() - e.len()].to_string(), e)
    };
    if fs::metadata(&p).map(|m| m.is_dir()).unwrap_or(false) {
        stem = name.to_string();
        ext = String::new();
    }
    let mut i = 2;
    loop {
        let p = join(dir, &format!("{stem} ({i}){ext}"));
        if !exists(&p) {
            return p;
        }
        i += 1;
    }
}

pub fn make_dir(parent: &str, name: &str) -> ApiResult<String> {
    valid_name(name)?;
    let p = join(parent, name.trim());
    if exists(&p) {
        return bad("something with that name already exists here");
    }
    fs::create_dir(&p)?;
    Ok(p)
}

pub fn rename_entry(path: &str, new_name: &str) -> ApiResult<String> {
    valid_name(new_name)?;
    let np = join(&dir_name(path), new_name.trim());
    if !same_path(&np, path) && exists(&np) {
        return bad("something with that name already exists here");
    }
    if np == path {
        return Ok(np);
    }
    fs::rename(path, &np)?;
    Ok(np)
}

// ---------- copy / move ----------

fn set_mtime(p: &str, t: std::time::SystemTime) {
    if let Ok(f) = fs::OpenOptions::new().write(true).open(p) {
        let _ = f.set_modified(t);
    } else if let Ok(f) = fs::File::open(p) {
        let _ = f.set_modified(t);
    }
}

fn copy_file(src: &str, dst: &str, md: &fs::Metadata) -> std::io::Result<()> {
    let mut input = fs::File::open(src)?;
    let mut out = fs::OpenOptions::new().write(true).create_new(true).open(dst)?;
    if let Err(e) = std::io::copy(&mut input, &mut out) {
        drop(out);
        let _ = fs::remove_file(dst);
        return Err(e);
    }
    if let Ok(t) = md.modified() {
        let _ = out.set_modified(t);
    }
    Ok(())
}

/// Copies a file or folder and reports every (source, copy) pair so tags can follow.
fn copy_tree(src: &str, dst: &str, pairs: &mut Vec<Pair>) -> std::io::Result<()> {
    let md = fs::metadata(src)?;
    if !md.is_dir() {
        copy_file(src, dst, &md)?;
        pairs.push(Pair { from: src.into(), to: dst.into() });
        return Ok(());
    }
    fs::create_dir(dst)?;
    pairs.push(Pair { from: src.into(), to: dst.into() });
    for de in fs::read_dir(src)? {
        let de = de?;
        let name = de.file_name().to_string_lossy().into_owned();
        copy_tree(&join(src, &name), &join(dst, &name), pairs)?;
    }
    if let Ok(t) = md.modified() {
        set_mtime(dst, t);
    }
    Ok(())
}

fn remove_all(p: &str) -> std::io::Result<()> {
    match fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(p),
        Ok(_) => fs::remove_file(p),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[derive(Serialize, Default, Debug)]
pub struct OpResult {
    pub done: Vec<Pair>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

pub fn move_entries(lib: &'static Library, paths: &[String], dest: &str) -> OpResult {
    let mut res = OpResult::default();
    for src in paths {
        let name = base_name(src);
        if same_path(&dir_name(src), dest) {
            continue; // already there
        }
        if fs::metadata(src).map(|m| m.is_dir()).unwrap_or(false) && under_root(dest, src) {
            res.errors.push(format!("can't move “{name}” into itself"));
            continue;
        }
        let dst = unique_path(dest, &name);
        if fs::rename(src, &dst).is_err() {
            // different drive (or locked): copy, then remove the original
            let mut pairs = vec![];
            if let Err(e) = copy_tree(src, &dst, &mut pairs) {
                let _ = remove_all(&dst);
                res.errors.push(format!("couldn't move “{name}”: {}", friendly_io(&e)));
                continue;
            }
            if remove_all(src).is_err() {
                res.errors.push(format!("“{name}” was copied, but the original couldn't be removed"));
            }
        }
        let pr = Pair { from: src.clone(), to: dst };
        lib.relocate(std::slice::from_ref(&pr));
        res.done.push(pr);
    }
    res
}

pub fn copy_entries(lib: &'static Library, paths: &[String], dest: &str) -> OpResult {
    let mut res = OpResult::default();
    for src in paths {
        let name = base_name(src);
        if fs::metadata(src).map(|m| m.is_dir()).unwrap_or(false) && under_root(dest, src) {
            res.errors.push(format!("can't copy “{name}” into itself"));
            continue;
        }
        let dst = unique_path(dest, &name);
        let mut pairs = vec![];
        if let Err(e) = copy_tree(src, &dst, &mut pairs) {
            let _ = remove_all(&dst);
            res.errors.push(format!("couldn't copy “{name}”: {}", friendly_io(&e)));
            continue;
        }
        lib.copy_meta(&pairs);
        res.done.push(Pair { from: src.clone(), to: dst });
    }
    res
}

/// Outside Windows deleted files go to <data>/trash (tests and development).
pub fn trash_fallback(data_dir: &str, paths: &[String]) -> ApiResult<()> {
    let dir = join(&join(data_dir, "trash"), &now_unix().to_string());
    fs::create_dir_all(&dir)?;
    for p in paths {
        fs::rename(p, unique_path(&dir, &base_name(p)))?;
    }
    Ok(())
}
