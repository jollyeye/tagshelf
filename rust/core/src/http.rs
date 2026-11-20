//! A small HTTP/1.1 server (standard library only): one thread per connection, keep-alive,
//! plus helpers for query strings, cookies, JSON and file responses (with range support).

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

pub struct Request {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub enum Body {
    Bytes(Vec<u8>),
    File(std::fs::File, u64),
}

pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Body,
}

impl Resp {
    pub fn with_header(mut self, h: (String, String)) -> Resp {
        self.headers.push(h);
        self
    }
}

pub fn hdr(k: &str, v: &str) -> (String, String) {
    (k.to_string(), v.to_string())
}

pub fn get_header(req: &Request, name: &str) -> Option<String> {
    req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone())
}

fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        204 => "No Content",
        206 => "Partial Content",
        302 => "Found",
        303 => "See Other",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        411 => "Length Required",
        413 => "Payload Too Large",
        416 => "Range Not Satisfiable",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        _ => "Status",
    }
}

const MAX_BODY: usize = 40 << 20;

/// Reads one request from the connection. None = connection closed / unusable.
fn read_request(r: &mut BufReader<TcpStream>) -> Option<Result<Request, u16>> {
    let mut line = String::new();
    // skip stray empty lines between keep-alive requests
    loop {
        line.clear();
        if r.read_line(&mut line).ok()? == 0 {
            return None;
        }
        if !line.trim().is_empty() {
            break;
        }
    }
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let url = parts.next()?.to_string();
    let mut headers = vec![];
    let mut total = line.len();
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).ok()? == 0 {
            return None;
        }
        total += h.len();
        if total > 64 * 1024 {
            return Some(Err(431));
        }
        let h = h.trim_end_matches(['\r', '\n']);
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let mut req = Request { method, url, headers, body: vec![] };
    if get_header(&req, "Transfer-Encoding").is_some() {
        return Some(Err(411));
    }
    let len: usize = get_header(&req, "Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > MAX_BODY {
        return Some(Err(413));
    }
    if len > 0 {
        let mut b = vec![0u8; len];
        r.read_exact(&mut b).ok()?;
        req.body = b;
    }
    Some(Ok(req))
}

fn write_response(w: &mut TcpStream, resp: Resp, head_only: bool, keep: bool) -> std::io::Result<()> {
    let len = match &resp.body {
        Body::Bytes(b) => b.len() as u64,
        Body::File(_, n) => *n,
    };
    let mut head = format!("HTTP/1.1 {} {}\r\n", resp.status, reason(resp.status));
    for (k, v) in &resp.headers {
        if v.contains(['\r', '\n']) {
            continue;
        }
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    if resp.status != 204 && !(100..200).contains(&resp.status) {
        head.push_str(&format!("Content-Length: {len}\r\n"));
    }
    head.push_str(if keep { "Connection: keep-alive\r\n\r\n" } else { "Connection: close\r\n\r\n" });
    w.write_all(head.as_bytes())?;
    if !head_only && resp.status != 204 {
        match resp.body {
            Body::Bytes(b) => w.write_all(&b)?,
            Body::File(f, n) => {
                std::io::copy(&mut f.take(n), w)?;
            }
        }
    }
    w.flush()
}

/// Serves `handler` on `listener` until the process ends. Each connection gets its own thread.
pub fn serve<H>(listener: TcpListener, handler: std::sync::Arc<H>)
where
    H: Fn(Request) -> Resp + Send + Sync + 'static,
{
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(stream) = conn else { continue };
            let h = handler.clone();
            std::thread::spawn(move || {
                let _ = stream.set_nodelay(true);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(120)));
                let Ok(mut w) = stream.try_clone() else { return };
                let mut r = BufReader::new(stream);
                while let Some(req) = read_request(&mut r) {
                    let req = match req {
                        Ok(q) => q,
                        Err(code) => {
                            let _ = write_response(&mut w, text(code, reason(code)), false, false);
                            return;
                        }
                    };
                    let close = get_header(&req, "Connection").map(|v| v.eq_ignore_ascii_case("close")).unwrap_or(false);
                    let head_only = req.method == "HEAD";
                    let resp = h(req);
                    if write_response(&mut w, resp, head_only, !close).is_err() || close {
                        return;
                    }
                }
            });
        }
    });
}

pub fn percent_decode(s: &str, plus_space: bool) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                let h = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
                match h {
                    Some(x) => {
                        out.push(x);
                        i += 3;
                    }
                    None => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b'+' if plus_space => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub struct Url {
    pub path: String,
    pub query: Vec<(String, String)>,
}

impl Url {
    pub fn parse(raw: &str) -> Url {
        let (p, q) = raw.split_once('?').unwrap_or((raw, ""));
        let query = q
            .split('&')
            .filter(|s| !s.is_empty())
            .map(|kv| {
                let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
                (percent_decode(k, true), percent_decode(v, true))
            })
            .collect();
        Url { path: percent_decode(p, false), query }
    }
    pub fn q(&self, k: &str) -> String {
        self.query.iter().find(|(kk, _)| kk == k).map(|(_, v)| v.clone()).unwrap_or_default()
    }
}

pub fn cookie(req: &Request, name: &str) -> Option<String> {
    let c = get_header(req, "Cookie")?;
    c.split(';').map(|p| p.trim()).find_map(|p| p.strip_prefix(&format!("{name}=")).map(String::from))
}

pub fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn bytes(code: u16, ct: &str, body: Vec<u8>) -> Resp {
    Resp { status: code, headers: vec![hdr("Content-Type", ct)], body: Body::Bytes(body) }
}

pub fn json(v: &impl serde::Serialize) -> Resp {
    let mut b = serde_json::to_vec(v).unwrap_or_else(|_| b"null".to_vec());
    b.push(b'\n');
    bytes(200, "application/json", b).with_header(hdr("Cache-Control", "no-store"))
}

pub fn error(code: u16, msg: &str) -> Resp {
    let mut b = serde_json::to_vec(&serde_json::json!({ "error": msg })).unwrap();
    b.push(b'\n');
    bytes(code, "application/json", b)
}

pub fn text(code: u16, msg: &str) -> Resp {
    bytes(code, "text/plain; charset=utf-8", format!("{msg}\n").into_bytes()).with_header(hdr("X-Content-Type-Options", "nosniff"))
}

pub fn empty(code: u16) -> Resp {
    Resp { status: code, headers: vec![], body: Body::Bytes(vec![]) }
}

pub fn redirect(code: u16, to: &str) -> Resp {
    empty(code).with_header(hdr("Location", to))
}

pub fn content_type(ext: &str) -> &'static str {
    match ext {
        ".html" => "text/html; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".jpg" | ".jpeg" | ".jfif" => "image/jpeg",
        ".png" => "image/png",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".bmp" => "image/bmp",
        ".svg" => "image/svg+xml",
        ".avif" => "image/avif",
        ".ico" => "image/x-icon",
        ".mp4" | ".m4v" => "video/mp4",
        ".webm" => "video/webm",
        ".mov" => "video/quicktime",
        ".mkv" => "video/x-matroska",
        ".avi" => "video/x-msvideo",
        ".wmv" => "video/x-ms-wmv",
        ".mp3" => "audio/mpeg",
        ".flac" => "audio/flac",
        ".wav" => "audio/wav",
        ".ogg" | ".opus" => "audio/ogg",
        ".m4a" => "audio/mp4",
        ".aac" => "audio/aac",
        ".wma" => "audio/x-ms-wma",
        ".pdf" => "application/pdf",
        ".txt" => "text/plain; charset=utf-8",
        _ => "",
    }
}

/// Serves a file with HTTP range support (needed for seeking in videos).
pub fn file(req: &Request, path: &str, ct: &str, extra: Vec<(String, String)>) -> Resp {
    let Ok(mut f) = std::fs::File::open(path) else { return text(404, "404 page not found") };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut headers = extra;
    if !ct.is_empty() {
        headers.push(hdr("Content-Type", ct));
    }
    headers.push(hdr("Accept-Ranges", "bytes"));
    if let Some(r) = get_header(req, "Range") {
        if let Some((a, b)) = parse_range(&r, size) {
            if f.seek(SeekFrom::Start(a)).is_ok() {
                let len = b - a + 1;
                headers.push(hdr("Content-Range", &format!("bytes {a}-{b}/{size}")));
                return Resp { status: 206, headers, body: Body::File(f, len) };
            }
        } else {
            headers.push(hdr("Content-Range", &format!("bytes */{size}")));
            return Resp { status: 416, headers, body: Body::Bytes(vec![]) };
        }
    }
    Resp { status: 200, headers, body: Body::File(f, size) }
}

fn parse_range(h: &str, size: u64) -> Option<(u64, u64)> {
    let spec = h.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (a, b) = first.split_once('-')?;
    if size == 0 {
        return None;
    }
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        let n = n.min(size);
        return Some((size - n, size - 1));
    }
    let a: u64 = a.parse().ok()?;
    if a >= size {
        return None;
    }
    let b = if b.is_empty() { size - 1 } else { b.parse::<u64>().ok()?.min(size - 1) };
    if b < a {
        return None;
    }
    Some((a, b))
}


