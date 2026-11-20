//! Windows implementation: raw Win32 calls (no extra libraries).

use crate::fsops::Drive;
use crate::util::*;
use std::ffi::c_void;
use std::fs::Metadata;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::os::windows::process::CommandExt;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type Handle = *mut c_void;
const INVALID_HANDLE: Handle = -1isize as Handle;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[repr(C)]
#[allow(non_snake_case)]
struct ShFileOpW {
    hwnd: Handle,
    wFunc: u32,
    pFrom: *const u16,
    pTo: *const u16,
    fFlags: u16,
    fAnyOperationsAborted: i32,
    hNameMappings: *mut c_void,
    lpszProgressTitle: *const u16,
}

#[link(name = "kernel32")]
extern "system" {
    fn SetErrorMode(mode: u32) -> u32;
    fn GetLogicalDrives() -> u32;
    fn GetDriveTypeW(root: *const u16) -> u32;
    fn GetVolumeInformationW(root: *const u16, name: *mut u16, size: u32, serial: *mut u32, maxlen: *mut u32, flags: *mut u32, fs: *mut u16, fs_size: u32) -> i32;
    fn CreateFileW(name: *const u16, access: u32, share: u32, sa: *mut c_void, disposition: u32, flags: u32, template: Handle) -> Handle;
    fn ReadDirectoryChangesW(h: Handle, buf: *mut c_void, len: u32, subtree: i32, filter: u32, ret: *mut u32, ov: *mut c_void, cr: *mut c_void) -> i32;
    fn CloseHandle(h: Handle) -> i32;
}

#[link(name = "user32")]
extern "system" {
    fn keybd_event(vk: u8, scan: u8, flags: u32, extra: usize);
    fn AllowSetForegroundWindow(pid: u32) -> i32;
}

#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(hwnd: Handle, op: *const u16, file: *const u16, params: *const u16, dir: *const u16, show: i32) -> isize;
    fn SHFileOperationW(op: *mut ShFileOpW) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

fn from_wide(b: &[u16]) -> String {
    let n = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf16_lossy(&b[..n])
}

pub fn init() {
    // Probing an empty card reader must not pop up a "no disk in drive" dialog.
    unsafe {
        SetErrorMode(0x0001);
    }
}

pub fn is_hidden(md: &Metadata, _name: &str) -> bool {
    md.file_attributes() & (0x2 | 0x4) != 0 // hidden | system
}

fn volume_label(root: &str) -> String {
    let w = wide(root);
    let mut buf = [0u16; 261];
    let ok = unsafe { GetVolumeInformationW(w.as_ptr(), buf.as_mut_ptr(), 261, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), 0) };
    if ok == 0 {
        String::new()
    } else {
        from_wide(&buf)
    }
}

fn drive_kind(root: &str) -> &'static str {
    let w = wide(root);
    match unsafe { GetDriveTypeW(w.as_ptr()) } {
        2 => "removable",
        4 => "network",
        5 => "cdrom",
        _ => "fixed",
    }
}

pub fn list_drives() -> Vec<Drive> {
    let mask = unsafe { GetLogicalDrives() };
    let (tx, rx) = std::sync::mpsc::channel();
    let mut n = 0;
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        n += 1;
        let tx = tx.clone();
        std::thread::spawn(move || {
            let c = (b'A' + i as u8) as char;
            let root = format!("{c}:\\");
            let kind = drive_kind(&root);
            // a network drive or an empty card reader can be slow or absent: keep it short
            if std::fs::metadata(&root).is_err() {
                let _ = tx.send(None);
                return;
            }
            let label = volume_label(&root);
            let name = if label.is_empty() { format!("Local Disk ({c}:)") } else { format!("{label} ({c}:)") };
            let _ = tx.send(Some(Drive { name, path: root, kind: kind.into() }));
        });
    }
    drop(tx);
    let deadline = std::time::Instant::now() + Duration::from_millis(1500);
    let mut out = vec![];
    for _ in 0..n {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(left) {
            Ok(Some(d)) => out.push(d),
            Ok(None) => {}
            Err(_) => break,
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Sends files and folders to the Recycle Bin (asks first only if something is too big for it).
pub fn trash_paths(_data_dir: &str, paths: &[String]) -> ApiResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut from: Vec<u16> = vec![];
    for p in paths {
        from.extend(std::ffi::OsStr::new(p).encode_wide());
        from.push(0);
    }
    from.push(0);
    const FO_DELETE: u32 = 3;
    const FLAGS: u16 = 0x0040 | 0x0010 | 0x0004 | 0x0400 | 0x4000; // ALLOWUNDO, NOCONFIRMATION, SILENT, NOERRORUI, WANTNUKEWARNING
    let mut op = ShFileOpW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        pTo: std::ptr::null(),
        fFlags: FLAGS,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    let r = unsafe { SHFileOperationW(&mut op) };
    if r != 0 {
        return bad(format!("couldn't move to the Recycle Bin (Windows error {r:#x})"));
    }
    if op.fAnyOperationsAborted != 0 {
        return bad("deleting was cancelled");
    }
    Ok(())
}

/// Lets the program we are about to start come to the front. Windows only allows that for a
/// process that recently received keyboard input; a tap on the Alt key counts, and we pass it on.
pub fn claim_foreground() {
    unsafe {
        keybd_event(0x12, 0, 0, 0);
        keybd_event(0x12, 0, 0x2, 0);
        AllowSetForegroundWindow(u32::MAX); // ASFW_ANY
    }
}

/// Opens a file or folder with its default program, like a double-click in Explorer.
fn shell_open(path: &str) -> bool {
    let (verb, file) = (wide("open"), wide(path));
    let r = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), 1) };
    r > 32
}

pub fn open_path(path: &str, reveal: bool) -> ApiResult<()> {
    let is_dir = std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false);
    // Explorer windows must NOT be started hidden, or they stay invisible
    claim_foreground();
    if reveal && !is_dir {
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{path}\""))
            .spawn()
            .map_err(|e| ApiErr::Bad(e.to_string()))?;
        return Ok(());
    }
    if shell_open(path) {
        return Ok(());
    }
    std::process::Command::new("explorer.exe").arg(path).spawn().map_err(|e| ApiErr::Bad(e.to_string()))?;
    Ok(())
}

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

fn hidden(cmd: &mut std::process::Command) -> &mut std::process::Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}

pub fn autostart_get() -> bool {
    hidden(std::process::Command::new("reg.exe").args(["query", RUN_KEY, "/v", "TagShelf"])).output().map(|o| o.status.success()).unwrap_or(false)
}

pub fn autostart_set(on: bool) -> ApiResult<()> {
    let mut cmd = std::process::Command::new("reg.exe");
    if on {
        let exe = std::env::current_exe().map_err(|e| ApiErr::Bad(e.to_string()))?;
        cmd.args(["add", RUN_KEY, "/v", "TagShelf", "/t", "REG_SZ", "/d", &format!("\"{}\" --background", exe.display()), "/f"]);
    } else {
        cmd.args(["delete", RUN_KEY, "/v", "TagShelf", "/f"]);
    }
    let out = hidden(&mut cmd).output().map_err(|e| ApiErr::Bad(e.to_string()))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
        if !on && msg.to_lowercase().contains("unable to find") {
            return Ok(());
        }
        return bad(format!("couldn't change the start-up setting: {}", msg.trim()));
    }
    Ok(())
}

pub fn pick_folder() -> ApiResult<String> {
    let script = r#"[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = 'Choose a folder'
$f.ShowNewFolderButton = $true
if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }"#;
    let out = hidden(std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script]))
        .output()
        .map_err(|e| ApiErr::Code(500, format!("couldn't open the folder picker: {e}")))?;
    let s = String::from_utf8_lossy(&out.stdout);
    Ok(s.trim_start_matches('\u{feff}').trim().to_string())
}

/// Whether Windows recorded that this file came from the internet or another computer
/// (the "Mark of the Web" that Edge, Chrome, Firefox and Brave add to every download on NTFS).
pub fn has_web_mark(path: &str) -> bool {
    std::fs::read_to_string(format!("{path}:Zone.Identifier")).map(|s| s.contains("ZoneId=3") || s.contains("ZoneId=4")).unwrap_or(false)
}

pub fn remove_web_mark(path: &str) {
    let _ = std::fs::remove_file(format!("{path}:Zone.Identifier"));
}

pub fn created_at(md: &Metadata) -> SystemTime {
    // 100-ns intervals since 1601-01-01
    let t = md.creation_time();
    let unix_100ns = t.saturating_sub(116_444_736_000_000_000);
    UNIX_EPOCH + Duration::from_nanos(unix_100ns.saturating_mul(100))
}

/// Listens for new files on every fixed or removable drive (change notifications, no scanning).
/// Drives that appear later are picked up within 30 seconds.
pub fn start_drive_watch(w: std::sync::Arc<crate::watch::Watcher>) {
    std::thread::spawn(move || {
        let active = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::<String>::new()));
        while !w.stopped() {
            for d in list_drives() {
                if d.kind != "fixed" && d.kind != "removable" {
                    continue;
                }
                if !active.lock().unwrap().insert(d.path.clone()) {
                    continue;
                }
                let (w2, act, root) = (w.clone(), active.clone(), d.path.clone());
                std::thread::spawn(move || {
                    watch_root(&w2, &root);
                    act.lock().unwrap().remove(&root);
                });
            }
            for _ in 0..30 {
                if w.stopped() {
                    return;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    });
}

fn watch_root(w: &crate::watch::Watcher, root: &str) {
    const FILE_LIST_DIRECTORY: u32 = 0x0001;
    const SHARE_ALL: u32 = 0x0007;
    const OPEN_EXISTING: u32 = 3;
    const BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const NOTIFY_FILE_NAME: u32 = 0x0001; // files appearing and being renamed into place
    let wr = wide(root);
    let h = unsafe { CreateFileW(wr.as_ptr(), FILE_LIST_DIRECTORY, SHARE_ALL, std::ptr::null_mut(), OPEN_EXISTING, BACKUP_SEMANTICS, std::ptr::null_mut()) };
    if h == INVALID_HANDLE || h.is_null() {
        return;
    }
    let mut buf = vec![0u32; 16 * 1024]; // 64 KiB, DWORD aligned
    while !w.stopped() {
        let mut n: u32 = 0;
        let ok = unsafe {
            ReadDirectoryChangesW(h, buf.as_mut_ptr() as *mut c_void, (buf.len() * 4) as u32, 1, NOTIFY_FILE_NAME, &mut n, std::ptr::null_mut(), std::ptr::null_mut())
        };
        if ok == 0 {
            break; // drive removed or no longer readable
        }
        if n == 0 {
            continue; // too many changes at once; some were missed
        }
        let bytes = unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u8, n as usize) };
        let mut off = 0usize;
        while off + 12 <= bytes.len() {
            let rd = |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
            let (next, action, name_len) = (rd(off), rd(off + 4), rd(off + 8) as usize);
            let start = off + 12;
            if start + name_len > bytes.len() {
                break;
            }
            if action == 1 || action == 5 {
                // added, or renamed (new name)
                let units: Vec<u16> = bytes[start..start + name_len].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                let name = String::from_utf16_lossy(&units);
                w.note_file(&join(root, &name));
            }
            if next == 0 {
                break;
            }
            off += next as usize;
        }
    }
    unsafe {
        CloseHandle(h);
    }
}
