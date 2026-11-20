//! Small helpers shared by every part of the backend.

use std::path::{Path, MAIN_SEPARATOR};
use std::time::{SystemTime, UNIX_EPOCH};

pub const IS_WIN: bool = cfg!(windows);
pub const SEP: char = MAIN_SEPARATOR;

/// Error returned by API handlers. `NotFound` becomes HTTP 404, everything else 400.
#[derive(Debug, Clone)]
pub enum ApiErr {
    Bad(String),
    NotFound(String),
    Code(u16, String),
}

impl ApiErr {
    pub fn msg(&self) -> &str {
        match self {
            ApiErr::Bad(m) | ApiErr::NotFound(m) | ApiErr::Code(_, m) => m,
        }
    }
    pub fn code(&self) -> u16 {
        match self {
            ApiErr::Bad(_) => 400,
            ApiErr::NotFound(_) => 404,
            ApiErr::Code(c, _) => *c,
        }
    }
}

impl From<String> for ApiErr {
    fn from(s: String) -> Self {
        ApiErr::Bad(s)
    }
}
impl From<&str> for ApiErr {
    fn from(s: &str) -> Self {
        ApiErr::Bad(s.to_string())
    }
}
impl From<std::io::Error> for ApiErr {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => ApiErr::NotFound(friendly_io(&e)),
            _ => ApiErr::Bad(friendly_io(&e)),
        }
    }
}

pub type ApiResult<T> = Result<T, ApiErr>;

pub fn bad<T>(m: impl Into<String>) -> ApiResult<T> {
    Err(ApiErr::Bad(m.into()))
}

/// Turns file-system errors into sentences people understand.
pub fn friendly_io(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => "Windows says you don't have permission to open this".into(),
        std::io::ErrorKind::NotFound => "this folder or file no longer exists".into(),
        _ => e.to_string(),
    }
}

pub fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn now_nanos() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as i64).unwrap_or(0)
}

pub fn unix_of(t: std::io::Result<SystemTime>) -> i64 {
    match t {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_secs() as i64,
            Err(e) => -(e.duration().as_secs() as i64) - if e.duration().subsec_nanos() > 0 { 1 } else { 0 },
        },
        Err(_) => 0,
    }
}

pub fn nanos_of(t: std::io::Result<SystemTime>) -> i64 {
    match t {
        Ok(t) => t.duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as i64).unwrap_or(0),
        Err(_) => 0,
    }
}

pub fn mtime_unix(md: &std::fs::Metadata) -> i64 {
    unix_of(md.modified())
}

/// ASCII-only lower-casing (same as the Go version; file names keep their non-ASCII letters).
pub fn to_lower(s: &str) -> String {
    s.to_ascii_lowercase()
}

/// Unicode lower-casing (used for comparisons where Go used strings.ToLower).
pub fn lower(s: &str) -> String {
    s.to_lowercase()
}

pub fn ext_of(name: &str) -> String {
    // filepath.Ext: from the last dot in the final element (including the dot)
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match base.rfind('.') {
        Some(i) => base[i..].to_string(),
        None => String::new(),
    }
}

pub fn lower_ext(name: &str) -> String {
    to_lower(&ext_of(name))
}

pub fn kind_of(ext: &str) -> &'static str {
    match ext {
        ".jpg" | ".jpeg" | ".jfif" | ".png" | ".gif" | ".webp" | ".bmp" | ".svg" | ".avif" => "image",
        ".mp4" | ".webm" | ".mov" | ".mkv" | ".avi" | ".m4v" | ".wmv" => "video",
        ".mp3" | ".flac" | ".wav" | ".ogg" | ".m4a" | ".aac" | ".opus" | ".wma" => "audio",
        _ => "other",
    }
}

pub fn base_name(p: &str) -> String {
    let t = p.trim_end_matches([SEP, '/']);
    if t.is_empty() {
        return SEP.to_string();
    }
    t.rsplit([SEP, '/']).next().unwrap_or(t).to_string()
}

/// filepath.Dir
pub fn dir_name(p: &str) -> String {
    let pb = Path::new(p);
    match pb.parent() {
        Some(par) if !par.as_os_str().is_empty() => par.to_string_lossy().into_owned(),
        Some(_) => ".".into(),
        None => p.to_string(), // root
    }
}

pub fn join(dir: &str, name: &str) -> String {
    Path::new(dir).join(name).to_string_lossy().into_owned()
}

pub fn file_id(p: &str) -> String {
    let key = if IS_WIN { lower(p) } else { p.to_string() };
    let d = sha1_smol::Sha1::from(key.as_bytes()).digest().bytes();
    hex(&d[..6])
}

pub fn hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for &x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

pub fn same_path(a: &str, b: &str) -> bool {
    if IS_WIN {
        lower(a) == lower(b)
    } else {
        a == b
    }
}

pub fn under_root(p: &str, root: &str) -> bool {
    let (p, root) = if IS_WIN { (lower(p), lower(root)) } else { (p.to_string(), root.to_string()) };
    let root = root.trim_end_matches(SEP);
    p == root || p.starts_with(&format!("{root}{SEP}"))
}

/// If `p` is `from` or inside it, returns the matching path under `to`.
pub fn map_under(p: &str, from: &str, to: &str) -> Option<String> {
    if same_path(p, from) {
        return Some(to.to_string());
    }
    if under_root(p, from) {
        let cut = from.trim_end_matches(SEP).len();
        return Some(format!("{}{}", to, &p[cut..]));
    }
    None
}

/// Cleans an absolute path like Go's filepath.Clean; rejects relative paths.
pub fn clean_abs(p: &str) -> ApiResult<String> {
    let p = p.trim();
    if p.is_empty() || !is_abs(p) {
        return bad("that is not a full folder path");
    }
    Ok(clean(p))
}

pub fn is_abs(p: &str) -> bool {
    if IS_WIN {
        let b = p.as_bytes();
        (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
            || p.starts_with("\\\\")
            || p.starts_with("//")
    } else {
        p.starts_with('/')
    }
}

pub fn clean(p: &str) -> String {
    let sep = SEP;
    let norm: String = if IS_WIN { p.replace('/', "\\") } else { p.to_string() };
    let (prefix, rest) = if IS_WIN {
        if norm.starts_with("\\\\") {
            // \\server\share\...
            let parts: Vec<&str> = norm[2..].splitn(3, '\\').collect();
            if parts.len() >= 2 {
                let pre = format!("\\\\{}\\{}", parts[0], parts[1]);
                let rest = if parts.len() == 3 { parts[2].to_string() } else { String::new() };
                (pre, format!("\\{rest}"))
            } else {
                (String::new(), norm.clone())
            }
        } else if norm.len() >= 2 && norm.as_bytes()[1] == b':' {
            (norm[..2].to_string(), norm[2..].to_string())
        } else {
            (String::new(), norm.clone())
        }
    } else {
        (String::new(), norm.clone())
    };
    let rooted = rest.starts_with(sep);
    let mut out: Vec<&str> = Vec::new();
    for seg in rest.split(sep) {
        match seg {
            "" | "." => {}
            ".." => {
                if !out.is_empty() && *out.last().unwrap() != ".." {
                    out.pop();
                } else if !rooted {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let body = out.join(&sep.to_string());
    let mut s = prefix;
    if rooted {
        s.push(sep);
    }
    s.push_str(&body);
    if s.is_empty() {
        ".".into()
    } else {
        s
    }
}

/// Random hex string from the OS random source (via std's randomly-seeded hasher).
pub fn rand_hex(n: usize) -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = Vec::with_capacity(n);
    let mut ctr: u64 = 0;
    while out.len() < n {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(ctr);
        h.write_i64(now_nanos());
        h.write_u32(std::process::id());
        ctr += 1;
        for b in h.finish().to_le_bytes() {
            if out.len() < n {
                out.push(b);
            }
        }
    }
    hex(&out)
}

pub fn clean_tag(s: &str) -> String {
    let s = s.replace(',', " ");
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    s.chars().take(60).collect()
}

const TAG_PALETTE: [&str; 12] = [
    "#e5645f", "#e8924a", "#e0b84a", "#7cc36a", "#4bbfa0", "#4cb4d8", "#6e9bf0", "#9a82ec", "#c978e0", "#e56fa6", "#9aa5b8", "#b8895f",
];

pub fn auto_color(name: &str) -> String {
    let mut h: u32 = 0x811c9dc5;
    for b in lower(name).as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(16777619);
    }
    TAG_PALETTE[(h as usize) % TAG_PALETTE.len()].to_string()
}

pub fn sort_tags(t: &mut [String]) {
    t.sort_by(|a, b| lower(a).cmp(&lower(b)));
}

pub fn natural_less(a: &str, b: &str) -> bool {
    natural_cmp(a, b) == std::cmp::Ordering::Less
}

pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        let (ca, cb) = (a[i], b[j]);
        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            let si = i;
            while i < a.len() && a[i].is_ascii_digit() {
                i += 1;
            }
            let sj = j;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            let na = trim_zeros(&a[si..i]);
            let nb = trim_zeros(&b[sj..j]);
            if na.len() != nb.len() {
                return na.len().cmp(&nb.len());
            }
            if na != nb {
                return na.cmp(nb);
            }
            continue;
        }
        if ca != cb {
            return ca.cmp(&cb);
        }
        i += 1;
        j += 1;
    }
    let (ra, rb) = (a.len() - i, b.len() - j);
    if ra < rb {
        Less
    } else if ra > rb {
        Greater
    } else {
        Equal
    }
}

fn trim_zeros(s: &[u8]) -> &[u8] {
    let mut k = 0;
    while k < s.len() && s[k] == b'0' {
        k += 1;
    }
    &s[k..]
}

/// Runs `f` once, `delay` after the first call since the last run (a simple debounced saver).
pub struct Debounce {
    pending: std::sync::Arc<std::sync::Mutex<bool>>,
    delay: std::time::Duration,
}

impl Debounce {
    pub fn new(delay: std::time::Duration) -> Self {
        Debounce { pending: Default::default(), delay }
    }
    pub fn schedule<F: FnOnce() + Send + 'static>(&self, f: F) {
        {
            let mut p = self.pending.lock().unwrap();
            if *p {
                return;
            }
            *p = true;
        }
        let (flag, delay) = (self.pending.clone(), self.delay);
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            *flag.lock().unwrap() = false;
            f();
        });
    }
}

/// Case-insensitive access to the fields of a JSON request body (the Go version accepted
/// "Paths", "paths", ... alike).
pub struct Args(pub serde_json::Value);

impl Args {
    pub fn get(&self, k: &str) -> Option<&serde_json::Value> {
        get_ci(&self.0, k)
    }
    pub fn str(&self, k: &str) -> String {
        self.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string()
    }
    pub fn strs(&self, k: &str) -> Vec<String> {
        strs_of(self.get(k))
    }
    pub fn bool(&self, k: &str) -> bool {
        self.get(k).and_then(|v| v.as_bool()).unwrap_or(false)
    }
    pub fn opt_bool(&self, k: &str) -> Option<bool> {
        self.get(k).and_then(|v| v.as_bool())
    }
    pub fn int(&self, k: &str) -> i64 {
        self.get(k).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))).unwrap_or(0)
    }
    pub fn has(&self, k: &str) -> bool {
        matches!(self.get(k), Some(v) if !v.is_null())
    }
}

pub fn get_ci<'a>(v: &'a serde_json::Value, k: &str) -> Option<&'a serde_json::Value> {
    let o = v.as_object()?;
    if let Some(x) = o.get(k) {
        return Some(x);
    }
    o.iter().find(|(kk, _)| kk.eq_ignore_ascii_case(k)).map(|(_, v)| v)
}

pub fn strs_of(v: Option<&serde_json::Value>) -> Vec<String> {
    match v.and_then(|v| v.as_array()) {
        Some(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
        None => vec![],
    }
}

pub fn exists(p: &str) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

pub fn home_dir() -> Option<String> {
    let v = if IS_WIN { std::env::var("USERPROFILE") } else { std::env::var("HOME") };
    v.ok().filter(|s| !s.is_empty())
}

pub fn default_downloads() -> String {
    home_dir().map(|h| join(&h, "Downloads")).unwrap_or_default()
}
