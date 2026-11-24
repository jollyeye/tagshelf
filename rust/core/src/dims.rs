//! Picture sizes (width × height) for the Shelf layouts (rows and masonry need each file's shape
//! before its preview has loaded). Read from the file header only, so it is fast, and remembered
//! in <data>/dims.json so it is done once per file.

use crate::util::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

#[derive(Default)]
struct Dims {
    file: String,
    /// path -> [mtime, size, width, height]
    map: HashMap<String, [i64; 4]>,
    dirty: bool,
}

static D: Mutex<Option<Dims>> = Mutex::new(None);
static SAVING: AtomicBool = AtomicBool::new(false);

pub fn open(data_dir: &str) {
    let file = join(data_dir, "dims.json");
    let map = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    *D.lock().unwrap() = Some(Dims { file, map, dirty: false });
}

/// The remembered size, if the file has not changed since.
pub fn get(p: &str, mtime: i64, size: i64) -> Option<(u32, u32)> {
    let g = D.lock().unwrap();
    let v = g.as_ref()?.map.get(p)?;
    (v[0] == mtime && v[1] == size && v[2] > 0 && v[3] > 0).then(|| (v[2] as u32, v[3] as u32))
}

pub fn put(p: &str, mtime: i64, size: i64, w: u32, h: u32) {
    if let Some(d) = D.lock().unwrap().as_mut() {
        d.map.insert(p.to_string(), [mtime, size, w as i64, h as i64]);
        d.dirty = true;
    }
}

/// Reads the size from the file header (turned for photos taken sideways).
pub fn read(p: &str, ext: &str) -> Option<(u32, u32)> {
    let (w, h) = image::ImageReader::open(p).ok()?.with_guessed_format().ok()?.into_dimensions().ok()?;
    if matches!(ext, ".jpg" | ".jpeg" | ".jfif") && crate::thumbs::exif_orientation(p) >= 5 {
        return Some((h, w));
    }
    Some((w, h))
}

/// The size of an image, from memory or from its header.
pub fn of(p: &str, ext: &str, mtime: i64, size: i64) -> Option<(u32, u32)> {
    if let Some(d) = get(p, mtime, size) {
        return Some(d);
    }
    let d = read(p, ext)?;
    put(p, mtime, size, d.0, d.1);
    Some(d)
}

pub fn save() {
    let (file, data) = {
        let mut g = D.lock().unwrap();
        let Some(d) = g.as_mut() else { return };
        if !d.dirty {
            return;
        }
        d.dirty = false;
        (d.file.clone(), serde_json::to_vec(&d.map).unwrap_or_default())
    };
    let tmp = format!("{file}.tmp");
    if std::fs::write(&tmp, &data).and_then(|_| std::fs::rename(&tmp, &file)).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Saves a few seconds from now (many sizes usually arrive together).
pub fn save_soon() {
    if SAVING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(5));
        SAVING.store(false, Ordering::SeqCst);
        save();
    });
}
