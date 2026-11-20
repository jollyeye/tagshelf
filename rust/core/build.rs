// Embeds the web interface (../../web) into the binary.
use std::io::Write;

fn main() {
    let web = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web").canonicalize().expect("web folder not found");
    println!("cargo:rerun-if-changed={}", web.display());
    let mut files: Vec<_> = std::fs::read_dir(&web).unwrap().flatten().filter(|e| e.path().is_file()).collect();
    files.sort_by_key(|e| e.file_name());
    let out = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("web_files.rs");
    let mut f = std::fs::File::create(out).unwrap();
    writeln!(f, "pub static WEB: &[(&str, &[u8])] = &[").unwrap();
    for e in files {
        println!("cargo:rerun-if-changed={}", e.path().display());
        writeln!(f, "    ({:?}, include_bytes!({:?})),", e.file_name().to_string_lossy(), e.path().to_string_lossy()).unwrap();
    }
    writeln!(f, "];").unwrap();
}
