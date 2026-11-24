//! Thumbnails (max 360 px, JPEG) kept in <data>/thumbs.
//! Speed: JPEGs are decoded directly at 1/2, 1/4 or 1/8 size (the decoder skips the detail we
//! would throw away anyway), several thumbnails are made in parallel, and the pictures of the
//! folder you open are prepared in the background before you scroll to them.

use crate::store::FileRec;
use crate::util::*;
use std::collections::VecDeque;
use std::io::{BufReader, Read};
use std::sync::{Condvar, Mutex};

pub const THUMB_MAX: u32 = 360;
/// sharper previews for big tiles (large Shelf sizes, high-DPI screens)
pub const THUMB_BIG: u32 = 900;

pub fn thumb_exts(ext: &str) -> bool {
    matches!(ext, ".jpg" | ".jpeg" | ".jfif" | ".png" | ".gif")
}

fn hexi(n: i64) -> String {
    if n < 0 {
        format!("-{:x}", n.unsigned_abs())
    } else {
        format!("{n:x}")
    }
}

pub fn thumb_path(data_dir: &str, f: &FileRec) -> String {
    join(&join(data_dir, "thumbs"), &format!("{}_{}_{}.jpg", f.id, hexi(f.mtime), hexi(f.size)))
}

pub fn thumb_path_big(data_dir: &str, f: &FileRec) -> String {
    join(&join(data_dir, "thumbs"), &format!("{}_{}_{}_L.jpg", f.id, hexi(f.mtime), hexi(f.size)))
}

// ---------- a small counting semaphore ----------

struct Sem {
    n: Mutex<usize>,
    cv: Condvar,
}
static SEM: Sem = Sem { n: Mutex::new(0), cv: Condvar::new() };

fn sem_max() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).clamp(2, 8)
}
struct Permit;
fn acquire() -> Permit {
    let mut n = SEM.n.lock().unwrap();
    while *n >= sem_max() {
        n = SEM.cv.wait(n).unwrap();
    }
    *n += 1;
    Permit
}
impl Drop for Permit {
    fn drop(&mut self) {
        *SEM.n.lock().unwrap() -= 1;
        SEM.cv.notify_one();
    }
}

// ---------- making one thumbnail ----------

/// RGB pixels, 3 bytes each.
struct Rgb {
    w: u32,
    h: u32,
    px: Vec<u8>,
}

pub fn make_thumb(src: &str, dst: &str, ext: &str) -> Result<(), String> {
    make_thumb_sized(src, dst, ext, THUMB_MAX)
}

pub fn make_thumb_sized(src: &str, dst: &str, ext: &str, max: u32) -> Result<(), String> {
    let _p = acquire();
    if std::path::Path::new(dst).exists() {
        return Ok(()); // another request produced it while we waited
    }
    let img = if matches!(ext, ".jpg" | ".jpeg" | ".jfif") {
        match decode_jpeg_scaled(src, max) {
            Ok(i) => i,
            Err(_) => decode_generic(src)?, // unusual JPEGs (e.g. arithmetic coding): let the image crate try
        }
    } else {
        decode_generic(src)?
    };
    let mut th = scale_box(&img, max);
    if matches!(ext, ".jpg" | ".jpeg" | ".jfif") {
        th = orient(th, exif_orientation(src));
    }
    if let Some(dir) = std::path::Path::new(dst).parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut out = Vec::with_capacity((th.w * th.h) as usize / 4);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82)
        .encode(&th.px, th.w, th.h, image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    let tmp = format!("{dst}.{}.tmp", rand_hex(3));
    std::fs::write(&tmp, &out).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dst).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

fn decode_jpeg_scaled(src: &str, max: u32) -> Result<Rgb, String> {
    let f = std::fs::File::open(src).map_err(|e| e.to_string())?;
    let mut dec = jpeg_decoder::Decoder::new(BufReader::with_capacity(256 * 1024, f));
    dec.read_info().map_err(|e| e.to_string())?;
    let info = dec.info().ok_or("no image info")?;
    let (w, h) = (info.width as u32, info.height as u32);
    if w == 0 || h == 0 || (w as u64) * (h as u64) > 250_000_000 {
        return Err("image dimensions not supported".into());
    }
    let longest = w.max(h);
    if longest > max {
        let rw = ((w as u64 * max as u64) / longest as u64).max(1) as u16;
        let rh = ((h as u64 * max as u64) / longest as u64).max(1) as u16;
        dec.scale(rw, rh).map_err(|e| e.to_string())?;
    }
    let data = dec.decode().map_err(|e| e.to_string())?;
    let info = dec.info().ok_or("no image info")?;
    let (w, h) = (info.width as u32, info.height as u32);
    let n = (w * h) as usize;
    let px = match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => data,
        jpeg_decoder::PixelFormat::L8 => data.iter().flat_map(|&g| [g, g, g]).collect(),
        jpeg_decoder::PixelFormat::L16 => data.chunks_exact(2).flat_map(|c| [c[0], c[0], c[0]]).collect(),
        jpeg_decoder::PixelFormat::CMYK32 => data
            .chunks_exact(4)
            .flat_map(|c| {
                // Adobe CMYK JPEGs are stored inverted
                let (cc, m, y, k) = (c[0] as u32, c[1] as u32, c[2] as u32, c[3] as u32);
                [(cc * k / 255) as u8, (m * k / 255) as u8, (y * k / 255) as u8]
            })
            .collect(),
    };
    if px.len() < n * 3 {
        return Err("truncated image".into());
    }
    Ok(Rgb { w, h, px })
}

fn decode_generic(src: &str) -> Result<Rgb, String> {
    let mut b = Vec::new();
    std::fs::File::open(src).and_then(|mut f| f.read_to_end(&mut b)).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&b).map_err(|e| e.to_string())?;
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 || (w as u64) * (h as u64) > 250_000_000 {
        return Err("image dimensions not supported".into());
    }
    let rgba = img.to_rgba8();
    // flatten transparency over the app's dark background
    const BG: u32 = 0x1c;
    let mut px = Vec::with_capacity((w * h * 3) as usize);
    for p in rgba.pixels() {
        let a = p[3] as u32;
        for c in 0..3 {
            px.push(((p[c] as u32 * a + BG * (255 - a)) / 255) as u8);
        }
    }
    Ok(Rgb { w, h, px })
}

/// Area-averaging downscale so the longest side is at most `max`.
fn scale_box(src: &Rgb, max: u32) -> Rgb {
    let (w, h) = (src.w as usize, src.h as usize);
    let longest = w.max(h);
    let scale = (max as f64 / longest as f64).min(1.0);
    let dw = ((w as f64 * scale + 0.5) as usize).max(1);
    let dh = ((h as f64 * scale + 0.5) as usize).max(1);
    if dw == w && dh == h {
        return Rgb { w: src.w, h: src.h, px: src.px.clone() };
    }
    let mut px = vec![0u8; dw * dh * 3];
    for y in 0..dh {
        let sy0 = y * h / dh;
        let sy1 = ((y + 1) * h / dh).max(sy0 + 1);
        for x in 0..dw {
            let sx0 = x * w / dw;
            let sx1 = ((x + 1) * w / dw).max(sx0 + 1);
            let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
            for yy in sy0..sy1 {
                let row = yy * w * 3;
                for xx in sx0..sx1 {
                    let o = row + xx * 3;
                    r += src.px[o] as u32;
                    g += src.px[o + 1] as u32;
                    b += src.px[o + 2] as u32;
                    n += 1;
                }
            }
            let o = (y * dw + x) * 3;
            px[o] = (r / n) as u8;
            px[o + 1] = (g / n) as u8;
            px[o + 2] = (b / n) as u8;
        }
    }
    Rgb { w: dw as u32, h: dh as u32, px }
}

fn orient(src: Rgb, o: u32) -> Rgb {
    if !(2..=8).contains(&o) {
        return src;
    }
    let (w, h) = (src.w as usize, src.h as usize);
    let (dw, dh) = if o >= 5 { (h, w) } else { (w, h) };
    let mut px = vec![0u8; dw * dh * 3];
    for y in 0..h {
        for x in 0..w {
            let (dx, dy) = match o {
                2 => (w - 1 - x, y),
                3 => (w - 1 - x, h - 1 - y),
                4 => (x, h - 1 - y),
                5 => (y, x),
                6 => (h - 1 - y, x),
                7 => (h - 1 - y, w - 1 - x),
                _ => (y, w - 1 - x),
            };
            let so = (y * w + x) * 3;
            let d = (dy * dw + dx) * 3;
            px[d..d + 3].copy_from_slice(&src.px[so..so + 3]);
        }
    }
    Rgb { w: dw as u32, h: dh as u32, px }
}

pub fn exif_orientation(path: &str) -> u32 {
    let Ok(mut f) = std::fs::File::open(path) else { return 1 };
    let mut buf = vec![0u8; 128 * 1024];
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(_) => break,
        }
    }
    let b = &buf[..n];
    if b.len() < 4 || b[0] != 0xFF || b[1] != 0xD8 {
        return 1;
    }
    let mut i = 2;
    while i + 4 <= b.len() {
        if b[i] != 0xFF {
            return 1;
        }
        let m = b[i + 1];
        if m == 0xD8 || m == 0x01 || (0xD0..=0xD7).contains(&m) {
            i += 2;
            continue;
        }
        if m == 0xDA || m == 0xD9 {
            return 1;
        }
        let seg = ((b[i + 2] as usize) << 8) | b[i + 3] as usize;
        if m == 0xE1 && i + 10 <= b.len() && &b[i + 4..i + 10] == b"Exif\0\0" {
            let end = (i + 2 + seg).min(b.len());
            return tiff_orientation(&b[i + 10..end]);
        }
        i += 2 + seg;
    }
    1
}

fn tiff_orientation(t: &[u8]) -> u32 {
    if t.len() < 8 {
        return 1;
    }
    let le = match &t[..2] {
        b"II" | b"ii" => true,
        b"MM" | b"mm" => false,
        _ => return 1,
    };
    let u16_ = |o: usize| if le { u16::from_le_bytes([t[o], t[o + 1]]) } else { u16::from_be_bytes([t[o], t[o + 1]]) } as usize;
    let u32_ = |o: usize| if le { u32::from_le_bytes([t[o], t[o + 1], t[o + 2], t[o + 3]]) } else { u32::from_be_bytes([t[o], t[o + 1], t[o + 2], t[o + 3]]) } as usize;
    let off = u32_(4);
    if off < 8 || off + 2 > t.len() {
        return 1;
    }
    let n = u16_(off);
    for k in 0..n {
        let e = off + 2 + k * 12;
        if e + 12 > t.len() {
            return 1;
        }
        if u16_(e) == 0x0112 {
            let v = u16_(e + 8) as u32;
            return if (1..=8).contains(&v) { v } else { 1 };
        }
    }
    1
}

// ---------- background preparation for the open folder ----------

struct Warm {
    q: Mutex<(u64, VecDeque<(String, String, String)>)>, // generation, (src, dst, ext)
    cv: Condvar,
}
static WARM: Warm = Warm { q: Mutex::new((0, VecDeque::new())), cv: Condvar::new() };
static WARM_STARTED: std::sync::Once = std::sync::Once::new();

/// Replaces the background queue with the pictures of the folder that was just opened.
/// Uses at most half the CPU cores so the thumbnails you are looking at stay fast.
pub fn warm(data_dir: &str, files: Vec<FileRec>) {
    let mut jobs = VecDeque::new();
    for f in files.into_iter().take(3000) {
        if f.kind != "image" || !thumb_exts(&f.ext) {
            continue;
        }
        let dst = thumb_path(data_dir, &f);
        if !std::path::Path::new(&dst).exists() {
            jobs.push_back((f.path, dst, f.ext));
        }
    }
    {
        let mut q = WARM.q.lock().unwrap();
        q.0 += 1;
        q.1 = jobs;
    }
    WARM.cv.notify_all();
    WARM_STARTED.call_once(|| {
        let n = (sem_max() / 2).max(1);
        for _ in 0..n {
            std::thread::spawn(|| loop {
                let job = {
                    let mut q = WARM.q.lock().unwrap();
                    while q.1.is_empty() {
                        q = WARM.cv.wait(q).unwrap();
                    }
                    q.1.pop_front().unwrap()
                };
                let (src, dst, ext) = job;
                if !std::path::Path::new(&dst).exists() {
                    let _ = make_thumb(&src, &dst, &ext);
                }
            });
        }
    });
}
