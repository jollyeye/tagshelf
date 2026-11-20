// TagShelf 3: the native window around tagshelf-core.
// No console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tagshelf_core::server::Shell;
use tagshelf_core::{call_instance, Options, Started};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// Lets the core open windows (it runs on other threads; windows are made on the main thread).
struct TauriShell {
    app: OnceLock<AppHandle>,
}

impl Shell for TauriShell {
    fn open_window(&self, url: &str) {
        if let Some(app) = self.app.get() {
            let (a, u) = (app.clone(), url.to_string());
            let _ = app.run_on_main_thread(move || show_main(&a, &u));
        }
    }
    fn open_popup(&self, url: &str) {
        if let Some(app) = self.app.get() {
            let (a, u) = (app.clone(), url.to_string());
            let _ = app.run_on_main_thread(move || show_popup(&a, &u));
        }
    }
}

fn show_main(app: &AppHandle, url: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let Ok(u) = url.parse() else { return };
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(u))
        .title("TagShelf")
        .inner_size(1500.0, 920.0)
        .min_inner_size(900.0, 560.0)
        .build();
}

fn show_popup(app: &AppHandle, url: &str) {
    if let Some(w) = app.get_webview_window("popup") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let Ok(u) = url.parse() else { return };
    let _ = WebviewWindowBuilder::new(app, "popup", WebviewUrl::External(u))
        .title("TagShelf - new downloads")
        .inner_size(640.0, 860.0)
        .min_inner_size(480.0, 560.0)
        .focused(true)
        .build();
}

fn main() {
    let mut data_dir = None;
    let mut background = false;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].trim_start_matches('-');
        match a.split_once('=') {
            Some(("data", v)) => data_dir = Some(v.to_string()),
            _ if a == "data" => {
                i += 1;
                data_dir = args.get(i).cloned();
            }
            _ if a == "background" => background = true,
            _ => {}
        }
        i += 1;
    }

    let shell = Arc::new(TauriShell { app: OnceLock::new() });
    let srv = match tagshelf_core::start(Options { data_dir, port: 47821, background }, shell.clone()) {
        Ok(Started::Running(s)) => s,
        Ok(Started::Existing(inst)) => {
            // already running (maybe only in the tray): bring its window up and leave
            if !background {
                call_instance(&inst, "POST", "/api/show", Duration::from_secs(3));
            }
            return;
        }
        Err(e) => {
            eprintln!("TagShelf could not start: {e}");
            std::process::exit(1);
        }
    };

    let url = srv.url();
    let srv_exit = srv.clone();
    let srv_keep = srv.clone();
    let app = tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            let _ = shell.app.set(handle.clone());

            // notification-area icon: click = open, right-click = menu
            let open = MenuItem::with_id(app, "open", "Open TagShelf", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit TagShelf", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &sep, &quit])?;
            let (u1, u2, s1) = (url.clone(), url.clone(), srv.clone());
            let mut tray = TrayIconBuilder::with_id("tray")
                .tooltip("TagShelf - click to open, right-click for the menu")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, ev| match ev.id().as_ref() {
                    "open" => show_main(app, &u1),
                    "quit" => s1.request_quit(),
                    _ => {}
                })
                .on_tray_icon_event(move |tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        show_main(tray.app_handle(), &u2);
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            if !background {
                show_main(&handle, &url);
            }

            // "Quit TagShelf" (from the window, the tray or a second start with --quit)
            let s2 = srv.clone();
            std::thread::spawn(move || {
                while !s2.quit.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(200));
                }
                handle.exit(0);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("TagShelf could not start its window");

    app.run(move |_app, event| match event {
        // the last window was closed: keep running in the tray if catching downloads is on
        RunEvent::ExitRequested { api, code: None, .. } => {
            if srv_keep.background_mode() {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => tagshelf_core::shutdown(&srv_exit),
        _ => {}
    });
}
