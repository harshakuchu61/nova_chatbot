use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

struct AlwaysOnTop(AtomicBool);

fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AlwaysOnTop(AtomicBool::new(false)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let toggle_shortcut = if cfg!(target_os = "macos") {
                Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::Space)
            } else {
                Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space)
            };

            app.global_shortcut().on_shortcut(
                toggle_shortcut,
                |handle, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_window(handle);
                    }
                },
            )?;

            let show_item = MenuItem::with_id(app, "show", "Show Nova", true, None::<&str>)?;
            let hide_item = MenuItem::with_id(app, "hide", "Hide Nova", true, None::<&str>)?;
            let always_top_item = MenuItem::with_id(
                app,
                "always_top",
                "Toggle always on top",
                true,
                None::<&str>,
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Nova", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[
                    &show_item,
                    &hide_item,
                    &always_top_item,
                    &separator,
                    &quit_item,
                ],
            )?;

            TrayIconBuilder::with_id("nova-tray")
                .menu(&menu)
                .tooltip("Nova")
                .icon(
                    app.default_window_icon()
                        .expect("missing default window icon")
                        .clone(),
                )
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    "always_top" => {
                        let state = app.state::<AlwaysOnTop>();
                        let new_value = !state.0.load(Ordering::SeqCst);
                        state.0.store(new_value, Ordering::SeqCst);
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.set_always_on_top(new_value);
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Nova Desktop");
}
