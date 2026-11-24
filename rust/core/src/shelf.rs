//! Shelf (media-center mode): categories, tag cards and tag pages, built from the tag library
//! (no folder scanning, so it covers every folder and drive at once).

use crate::store::{Category, LibData, Library};
use crate::util::*;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const PRESETS: [&str; 4] = ["banner", "profile", "gallery", "timeline"];

#[derive(Serialize, Clone, Debug)]
pub struct Pic {
    pub p: String,
    pub k: String,
    pub x: String,
    pub m: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct TagCard {
    pub name: String,
    pub color: String,
    pub count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover: Option<Pic>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub chosen: bool,
    /// when a file last got this tag (unix seconds)
    pub last: i64,
    /// pictures chosen by the user for the tag
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<Pic>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub banner: Option<Pic>,
}

fn chosen_pic(path: &str) -> Option<Pic> {
    if path.is_empty() {
        return None;
    }
    std::fs::metadata(path).ok().filter(|m| !m.is_dir()).map(|m| pic_of(path, mtime_unix(&m)))
}

fn pic_of(path: &str, mtime: i64) -> Pic {
    let x = lower_ext(path);
    Pic { k: kind_of(&x).into(), p: path.into(), x, m: mtime }
}

/// One pass over the library: count and automatic cover (newest tagged picture, else video) per tag.
fn cards(d: &LibData) -> HashMap<String, TagCard> {
    let mut best: HashMap<&str, (i64, i64, &str, i64)> = HashMap::new(); // tag -> (rank, added, path, mtime)
    let mut counts: HashMap<&str, i64> = HashMap::new();
    let mut last: HashMap<&str, i64> = HashMap::new();
    for f in d.files.values() {
        if f.missing || f.isdir {
            continue;
        }
        let rank = match f.kind.as_str() {
            "image" => 2,
            "video" => 1,
            _ => 0,
        };
        for t in &f.tags {
            *counts.entry(t.as_str()).or_default() += 1;
            let l = last.entry(t.as_str()).or_default();
            *l = (*l).max(f.added);
            if rank == 0 {
                continue;
            }
            let cur = best.get(t.as_str());
            if cur.map(|c| (rank, f.added) > (c.0, c.1)).unwrap_or(true) {
                best.insert(t.as_str(), (rank, f.added, f.path.as_str(), f.mtime));
            }
        }
    }
    let mut out = HashMap::new();
    for (name, info) in &d.tags {
        let mut card = TagCard { name: name.clone(), color: info.color.clone(), count: *counts.get(name.as_str()).unwrap_or(&0), cover: None, chosen: false, last: info.used.max(*last.get(name.as_str()).unwrap_or(&0)), icon: chosen_pic(&info.icon), banner: chosen_pic(&info.banner) };
        if !info.cover.is_empty() {
            if let Ok(md) = std::fs::metadata(&info.cover) {
                card.cover = Some(pic_of(&info.cover, mtime_unix(&md)));
                card.chosen = true;
            }
        }
        if card.cover.is_none() {
            if let Some((_, _, p, m)) = best.get(name.as_str()) {
                card.cover = Some(pic_of(p, *m));
            }
        }
        out.insert(name.clone(), card);
    }
    out
}

fn sorted_cards(mut v: Vec<TagCard>) -> Vec<TagCard> {
    v.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| natural_cmp(&lower(&a.name), &lower(&b.name))));
    v
}

pub fn home(lib: &Library) -> Value {
    let d = lib.r();
    let mut all = cards(&d);
    let known: std::collections::HashSet<&str> = d.categories.iter().map(|c| c.id.as_str()).collect();
    let mut by_cat: HashMap<String, Vec<TagCard>> = HashMap::new();
    let mut loose = vec![];
    for (name, info) in &d.tags {
        let Some(card) = all.remove(name) else { continue };
        if card.count == 0 && info.category.is_empty() {
            continue; // unused and uncategorized: not worth a card
        }
        if !info.category.is_empty() && known.contains(info.category.as_str()) {
            by_cat.entry(info.category.clone()).or_default().push(card);
        } else {
            loose.push(card);
        }
    }
    let cats: Vec<Value> = d
        .categories
        .iter()
        .map(|c| json!({"id": c.id, "name": c.name, "color": c.color, "preset": c.preset, "tags": sorted_cards(by_cat.remove(&c.id).unwrap_or_default())}))
        .collect();
    // recently tagged pictures and videos
    let mut recent: Vec<(&i64, Pic)> = d
        .files
        .values()
        .filter(|f| !f.missing && !f.isdir && !f.tags.is_empty() && (f.kind == "image" || f.kind == "video"))
        .map(|f| (&f.added, pic_of(&f.path, f.mtime)))
        .collect();
    recent.sort_by(|a, b| b.0.cmp(a.0));
    let recent: Vec<Pic> = recent.into_iter().take(24).map(|x| x.1).collect();
    json!({"categories": cats, "uncategorized": sorted_cards(loose), "recent": recent})
}

#[derive(Serialize)]
struct PageFile {
    n: String,
    p: String,
    k: String,
    x: String,
    s: i64,
    m: i64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    t: Vec<String>,
    #[serde(skip_serializing_if = "is_zero")]
    r: i64,
    a: i64,
    /// width and height (images and videos whose still has been made), for the rows / masonry layouts
    #[serde(skip_serializing_if = "is_zero_u")]
    w: u32,
    #[serde(skip_serializing_if = "is_zero_u")]
    h: u32,
}
fn is_zero_u(n: &u32) -> bool {
    *n == 0
}
fn is_zero(n: &i64) -> bool {
    *n == 0
}

/// Everything for one tag's page: its files (from every folder), counts and related tags by category.
pub fn tag_page(lib: &'static Library, name: &str) -> ApiResult<Value> {
    let (tag, info, mut files, cards, cats) = {
        let d = lib.r();
        let Some(tag) = d.tag_idx.get(&lower(&clean_tag(name))).cloned() else { return Err(ApiErr::NotFound("there is no tag with that name".into())) };
        let info = d.tags.get(&tag).cloned().unwrap_or_default();
        let files: Vec<PageFile> = d
            .files
            .values()
            .filter(|f| !f.missing && !f.isdir && f.tags.contains(&tag))
            .map(|f| PageFile { n: f.name.clone(), p: f.path.clone(), k: f.kind.clone(), x: f.ext.clone(), s: f.size, m: f.mtime, t: f.tags.clone(), r: f.rating, a: f.added, w: 0, h: 0 })
            .collect();
        (tag, info, files, cards(&d), d.categories.clone())
    };
    // check the files still exist and pick up their current size/date (thumbnail cache keys)
    let deadline = Instant::now() + Duration::from_secs(3);
    files.retain_mut(|f| {
        if Instant::now() > deadline {
            return true;
        }
        match std::fs::metadata(&f.p) {
            Ok(md) => {
                f.s = md.len() as i64;
                f.m = mtime_unix(&md);
                true
            }
            Err(e) => e.kind() != std::io::ErrorKind::NotFound,
        }
    });
    files.sort_by(|a, b| b.a.cmp(&a.a).then_with(|| natural_cmp(&lower(&a.n), &lower(&b.n))));

    // each file's shape: remembered sizes are instant; new pictures are read from their header for
    // a moment, the rest in the background (the page learns those from the previews meanwhile)
    let deadline = Instant::now() + Duration::from_millis(1500);
    let mut later: Vec<(String, String, i64, i64)> = Vec::new();
    for f in files.iter_mut() {
        if let Some((w, h)) = crate::dims::get(&f.p, f.m, f.s) {
            (f.w, f.h) = (w, h);
        } else if f.k == "image" {
            if Instant::now() < deadline {
                if let Some((w, h)) = crate::dims::of(&f.p, &f.x, f.m, f.s) {
                    (f.w, f.h) = (w, h);
                }
            } else {
                later.push((f.p.clone(), f.x.clone(), f.m, f.s));
            }
        }
    }
    if !later.is_empty() {
        std::thread::spawn(move || {
            for (p, x, m, s) in later {
                let _ = crate::dims::of(&p, &x, m, s);
            }
            crate::dims::save_soon();
        });
    }
    crate::dims::save_soon();

    // the page's own tabs: tags of a category, filtered by your list
    let tag_cat: HashMap<String, String> = lib.r().tags.iter().map(|(n, i)| (n.clone(), i.category.clone())).collect();
    let card_json = |t: &str, n: i64| {
        let card = cards.get(t);
        json!({"name": t, "shared": n, "color": card.map(|c| c.color.clone()), "count": card.map(|c| c.count), "last": card.map(|c| c.last), "cover": card.and_then(|c| c.cover.clone()),
            "icon": card.and_then(|c| c.icon.clone()), "banner": card.and_then(|c| c.banner.clone())})
    };
    let tabs: Vec<Value> = info
        .tabs
        .iter()
        .map(|tab| {
            let mut shared: HashMap<&str, i64> = HashMap::new();
            for f in &files {
                for t in &f.t {
                    if *t != tag && tag_cat.get(t).map(|c| *c == tab.category).unwrap_or(false) {
                        *shared.entry(t.as_str()).or_default() += 1;
                    }
                }
            }
            let mut all: Vec<(&str, i64)> = shared.iter().map(|(t, n)| (*t, *n)).collect();
            all.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| natural_cmp(&lower(a.0), &lower(b.0))));
            let only = tab.mode == "only";
            let items: Vec<Value> = if only {
                // exactly your list, in your order (tags that no longer exist are skipped)
                tab.only.iter().filter(|t| cards.contains_key(t.as_str())).map(|t| card_json(t, *shared.get(t.as_str()).unwrap_or(&0))).collect()
            } else {
                all.iter().filter(|(t, _)| !tab.exclude.iter().any(|x| x == t)).map(|(t, n)| card_json(t, *n)).collect()
            };
            // every tag of the category, for picking: sharing ones first
            let mut pick: Vec<Value> = all.iter().map(|(t, n)| json!({"name": t, "shared": n})).collect();
            let mut rest: Vec<&String> = tag_cat.iter().filter(|(t, c)| **c == tab.category && !shared.contains_key(t.as_str())).map(|(t, _)| t).collect();
            rest.sort_by(|a, b| natural_cmp(&lower(a), &lower(b)));
            pick.extend(rest.into_iter().map(|t| json!({"name": t, "shared": 0})));
            json!({
                "id": tab.id, "label": tab.label, "mode": if only { "only" } else { "exclude" },
                "only": tab.only, "exclude": tab.exclude,
                "category": cats.iter().find(|c| c.id == tab.category), "items": items, "pick": pick,
            })
        })
        .collect();
    let category = cats.iter().find(|c| c.id == info.category).cloned();
    let me = cards.get(&tag);
    Ok(json!({
        "name": tag, "color": info.color, "category": category,
        "cover": me.and_then(|c| c.cover.clone()), "chosen": me.map(|c| c.chosen).unwrap_or(false),
        "icon": me.and_then(|c| c.icon.clone()), "banner": me.and_then(|c| c.banner.clone()),
        "files": files, "tabs": tabs,
    }))
}

// ---------- editing ----------

fn valid_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())
}

pub fn create_category(lib: &'static Library, name: &str, color: &str, preset: &str) -> ApiResult<Category> {
    let name = clean_tag(name);
    if name.is_empty() {
        return bad("give the category a name");
    }
    let mut d = lib.w();
    if d.categories.iter().any(|c| lower(&c.name) == lower(&name)) {
        return bad("there is already a category with that name");
    }
    let c = Category {
        id: rand_hex(4),
        color: if valid_color(color) { color.into() } else { auto_color(&name) },
        preset: if PRESETS.contains(&preset) { preset.into() } else { "banner".into() },
        name,
    };
    d.categories.push(c.clone());
    lib.touch(&mut d);
    Ok(c)
}

pub fn update_category(lib: &'static Library, a: &Args) -> ApiResult<()> {
    let id = a.str("ID");
    let mut d = lib.w();
    let name = a.has("Name").then(|| clean_tag(&a.str("Name")));
    if let Some(n) = &name {
        if n.is_empty() {
            return bad("give the category a name");
        }
        if d.categories.iter().any(|c| c.id != id && lower(&c.name) == lower(n)) {
            return bad("there is already a category with that name");
        }
    }
    let Some(c) = d.categories.iter_mut().find(|c| c.id == id) else { return bad("no such category") };
    if let Some(n) = name {
        c.name = n;
    }
    let color = a.str("Color");
    if valid_color(&color) {
        c.color = color;
    }
    let preset = a.str("Preset");
    if PRESETS.contains(&preset.as_str()) {
        c.preset = preset;
    }
    lib.touch(&mut d);
    Ok(())
}

pub fn delete_category(lib: &'static Library, id: &str) {
    let mut d = lib.w();
    d.categories.retain(|c| c.id != id);
    for t in d.tags.values_mut() {
        if t.category == id {
            t.category.clear();
        }
        t.tabs.retain(|tab| tab.category != id); // tabs that listed this category go too
    }
    lib.touch(&mut d);
}

pub fn order_categories(lib: &'static Library, ids: &[String]) {
    let mut d = lib.w();
    let mut cats = std::mem::take(&mut d.categories);
    cats.sort_by_key(|c| ids.iter().position(|i| *i == c.id).unwrap_or(usize::MAX));
    d.categories = cats;
    lib.touch(&mut d);
}

/// Puts tags into a category ("" = none).
pub fn set_tag_category(lib: &'static Library, names: &[String], cat: &str) -> ApiResult<()> {
    let mut d = lib.w();
    if !cat.is_empty() && !d.categories.iter().any(|c| c.id == cat) {
        return bad("no such category");
    }
    for n in names {
        if let Some(t) = d.tag_idx.get(&lower(&clean_tag(n))).cloned() {
            if let Some(info) = d.tags.get_mut(&t) {
                info.category = cat.to_string();
            }
        }
    }
    lib.touch(&mut d);
    Ok(())
}

/// Chooses the picture for a tag's card and banner ("" = automatic).
pub fn set_tag_cover(lib: &'static Library, name: &str, image: &str) -> ApiResult<()> {
    let img = if image.is_empty() { String::new() } else { clean_abs(image)? };
    if !img.is_empty() {
        match std::fs::metadata(&img) {
            Ok(m) if !m.is_dir() => {}
            _ => return bad("that picture doesn't exist"),
        }
        let k = kind_of(&lower_ext(&img));
        if k != "image" && k != "video" {
            return bad("choose a picture or a video");
        }
    }
    let mut d = lib.w();
    let Some(t) = d.tag_idx.get(&lower(&clean_tag(name))).cloned() else { return bad("no such tag") };
    if let Some(info) = d.tags.get_mut(&t) {
        info.cover = img;
    }
    lib.touch(&mut d);
    Ok(())
}

// ---------- tabs on a tag page ----------

fn with_tag<R>(lib: &'static Library, name: &str, f: impl FnOnce(&mut crate::store::TagInfo, &[Category]) -> ApiResult<R>) -> ApiResult<R> {
    let mut d = lib.w();
    let Some(t) = d.tag_idx.get(&lower(&clean_tag(name))).cloned() else { return bad("no such tag") };
    let cats = d.categories.clone();
    let info = d.tags.get_mut(&t).ok_or("no such tag")?;
    let r = f(info, &cats)?;
    lib.touch(&mut d);
    Ok(r)
}

pub fn tab_add(lib: &'static Library, name: &str, cat: &str, label: &str) -> ApiResult<String> {
    with_tag(lib, name, |info, cats| {
        let Some(c) = cats.iter().find(|c| c.id == cat) else { return bad("no such category") };
        let id = rand_hex(3);
        let label = clean_tag(label);
        info.tabs.push(crate::store::PageTab {
            id: id.clone(),
            label: if label.is_empty() { c.name.clone() } else { label },
            category: cat.into(),
            mode: "exclude".into(),
            ..Default::default()
        });
        Ok(id)
    })
}

pub fn tab_update(lib: &'static Library, a: &Args) -> ApiResult<()> {
    let id = a.str("ID");
    with_tag(lib, &a.str("Name"), |info, _| {
        let Some(tab) = info.tabs.iter_mut().find(|t| t.id == id) else { return bad("no such tab") };
        if a.has("Label") {
            let l = clean_tag(&a.str("Label"));
            if l.is_empty() {
                return bad("give the tab a name");
            }
            tab.label = l;
        }
        let mode = a.str("Mode");
        if mode == "only" || mode == "exclude" {
            tab.mode = mode;
        }
        let clean_list = |v: Vec<String>| {
            let mut seen = std::collections::HashSet::new();
            v.into_iter().map(|t| clean_tag(&t)).filter(|t| !t.is_empty() && seen.insert(lower(t))).collect::<Vec<_>>()
        };
        if a.has("Only") {
            tab.only = clean_list(a.strs("Only"));
        }
        if a.has("Exclude") {
            tab.exclude = clean_list(a.strs("Exclude"));
        }
        Ok(())
    })
}

pub fn tab_delete(lib: &'static Library, name: &str, id: &str) -> ApiResult<()> {
    with_tag(lib, name, |info, _| {
        info.tabs.retain(|t| t.id != id);
        Ok(())
    })
}

pub fn tab_move(lib: &'static Library, name: &str, id: &str, dir: i64) -> ApiResult<()> {
    with_tag(lib, name, |info, _| {
        let Some(i) = info.tabs.iter().position(|t| t.id == id) else { return bad("no such tab") };
        let j = i as i64 + dir.signum();
        if j >= 0 && (j as usize) < info.tabs.len() {
            info.tabs.swap(i, j as usize);
        }
        Ok(())
    })
}

/// Chooses the tag's icon or banner ("" = back to automatic).
pub fn set_tag_picture(lib: &'static Library, name: &str, kind: &str, image: &str) -> ApiResult<()> {
    if kind != "icon" && kind != "banner" {
        return bad("unknown picture kind");
    }
    let img = if image.is_empty() { String::new() } else { clean_abs(image)? };
    if !img.is_empty() {
        match std::fs::metadata(&img) {
            Ok(m) if !m.is_dir() => {}
            _ => return bad("that picture doesn't exist"),
        }
        if kind_of(&lower_ext(&img)) != "image" {
            return bad("choose a picture");
        }
    }
    let mut d = lib.w();
    let Some(t) = d.tag_idx.get(&lower(&clean_tag(name))).cloned() else { return bad("no such tag") };
    if let Some(info) = d.tags.get_mut(&t) {
        if kind == "icon" {
            info.icon = img;
        } else {
            info.banner = img;
        }
    }
    lib.touch(&mut d);
    Ok(())
}
