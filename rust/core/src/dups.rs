//! Exact duplicate finder: same size, then same first 64 KiB, then same full SHA-1.

use crate::fsops::list_dir;
use crate::store::Library;
use crate::util::*;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::time::{Duration, Instant};

#[derive(Serialize)]
pub struct DupFile {
    pub p: String,
    pub m: i64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub t: Vec<String>,
    #[serde(skip_serializing_if = "is_zero")]
    pub r: i64,
}
fn is_zero(n: &i64) -> bool {
    *n == 0
}

#[derive(Serialize)]
pub struct DupGroup {
    pub size: i64,
    pub files: Vec<DupFile>,
}

const HEAD: u64 = 64 << 10;

fn hash_file(path: &str, limit: u64, deadline: Instant) -> Option<String> {
    let f = std::fs::File::open(path).ok()?;
    let mut r: Box<dyn Read> = if limit > 0 { Box::new(f.take(limit)) } else { Box::new(f) };
    let mut h = sha1_smol::Sha1::new();
    let mut buf = vec![0u8; 256 << 10];
    loop {
        if Instant::now() > deadline {
            return None;
        }
        let n = r.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Some(h.digest().to_string())
}

fn hash_all(paths: &[String], limit: u64, deadline: Instant) -> HashMap<String, String> {
    let chunks: Vec<Vec<String>> = {
        let n = 4.min(paths.len().max(1));
        let mut c = vec![vec![]; n];
        for (i, p) in paths.iter().enumerate() {
            c[i % n].push(p.clone());
        }
        c
    };
    std::thread::scope(|s| {
        let hs: Vec<_> = chunks.into_iter().map(|c| s.spawn(move || c.into_iter().filter_map(|p| hash_file(&p, limit, deadline).map(|h| (p, h))).collect::<Vec<_>>())).collect();
        hs.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    })
}

pub fn find(lib: &Library, path: &str, sub: bool, hidden: bool) -> ApiResult<serde_json::Value> {
    let p = clean_abs(path)?;
    let deadline = Instant::now() + Duration::from_secs(300);
    let (entries, trunc) = list_dir(&p, sub, hidden, 200_000, deadline)?;
    let mut by_size: HashMap<i64, Vec<(String, i64)>> = HashMap::new();
    let mut scanned = 0;
    for e in entries {
        if e.d || e.s == 0 {
            continue;
        }
        scanned += 1;
        by_size.entry(e.s).or_default().push((e.p, e.m));
    }
    let mut groups = vec![];
    for (size, list) in by_size {
        if list.len() < 2 {
            continue;
        }
        let mt: HashMap<String, i64> = list.iter().cloned().collect();
        let paths: Vec<String> = list.into_iter().map(|x| x.0).collect();
        let heads = hash_all(&paths, HEAD, deadline);
        let mut by_head: HashMap<String, Vec<String>> = HashMap::new();
        for p in &paths {
            if let Some(h) = heads.get(p) {
                by_head.entry(h.clone()).or_default().push(p.clone());
            }
        }
        for cand in by_head.into_values() {
            if cand.len() < 2 {
                continue;
            }
            let mut sets: HashMap<String, Vec<String>> = HashMap::new();
            if size as u64 <= HEAD {
                sets.insert("same".into(), cand);
            } else {
                let full = hash_all(&cand, 0, deadline);
                for p in cand {
                    if let Some(h) = full.get(&p) {
                        sets.entry(h.clone()).or_default().push(p);
                    }
                }
            }
            for mut same in sets.into_values() {
                if same.len() < 2 {
                    continue;
                }
                same.sort();
                let files = same
                    .into_iter()
                    .map(|p| {
                        let rec = lib.lookup(&p);
                        DupFile { m: mt[&p], t: rec.as_ref().map(|r| r.tags.clone()).unwrap_or_default(), r: rec.map(|r| r.rating).unwrap_or(0), p }
                    })
                    .collect();
                groups.push(DupGroup { size, files });
            }
        }
    }
    if Instant::now() > deadline {
        return bad("the duplicate search took too long");
    }
    groups.sort_by_key(|g| -(g.size * (g.files.len() as i64 - 1)));
    groups.truncate(500);
    Ok(serde_json::json!({"groups": groups, "scanned": scanned, "truncated": trunc}))
}
