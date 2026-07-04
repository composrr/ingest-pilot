mod commands;
mod core;
mod ingest;
mod platform;
mod sync;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};

/// Whether closing the window should hide to the tray (true) or quit (false).
/// Kept in sync with `settings.camera_watcher.tray_mode` by `save_settings` so the
/// window-close handler can decide without re-reading the file each time.
pub struct BackgroundMode(pub AtomicBool);

/// Shows, unminimizes, and focuses the main window — the single place we surface the
/// app from the tray/background (tray click, card insert, ingest complete, relaunch).
pub fn show_and_focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItemBuilder::with_id("show", "Open Ingest Pilot").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Ingest Pilot")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_and_focus(app),
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
                show_and_focus(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance must be registered first so a relaunch focuses the
        // already-running (possibly tray-only) instance instead of starting a second.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_and_focus(app);
        }))
        .manage(commands::ingest::IngestJobs::default())
        .manage(BackgroundMode(AtomicBool::new(true)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // The auto-updater is desktop-only. Registered here (rather than in the
            // builder chain) so it can be `#[cfg(desktop)]`-gated cleanly.
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                build_tray(app.handle())?;
                // Seed the background-mode flag from saved settings so the very first
                // window close behaves per the user's preference.
                if let Ok(settings) = commands::settings::get_settings(app.handle().clone()) {
                    app.state::<BackgroundMode>()
                        .0
                        .store(settings.camera_watcher.tray_mode, Ordering::Relaxed);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close-to-tray: when background mode is on, hide the window instead of
            // quitting so the card watcher keeps running.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(state) = window.app_handle().try_state::<BackgroundMode>() {
                    if state.0.load(Ordering::Relaxed) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::system::greet,
            commands::system::open_path,
            commands::system::disk_space,
            commands::system::filter_directories,
            commands::system::show_main_window,
            commands::system::set_launch_at_login,
            commands::system::get_launch_at_login,
            commands::history::list_history,
            commands::history::save_history_job,
            commands::history::clear_history,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::presets::list_presets,
            commands::presets::get_preset,
            commands::presets::save_preset,
            commands::presets::delete_preset,
            commands::presets::import_preset,
            commands::presets::export_preset,
            commands::presets::duplicate_preset,
            commands::presets::import_folder_tree,
            commands::presets::inspect_template_drop,
            commands::metadata_presets::list_metadata_presets,
            commands::metadata_presets::get_metadata_preset,
            commands::metadata_presets::save_metadata_preset,
            commands::metadata_presets::delete_metadata_preset,
            commands::naming_catalog::get_naming_catalog,
            commands::naming_catalog::save_naming_catalog,
            commands::iconik::iconik_list_views,
            commands::iconik::iconik_view_fields,
            commands::iconik::iconik_push_metadata,
            commands::ingest::scaffold_project,
            commands::ingest::run_ingest,
            commands::ingest::retry_failed_copies,
            commands::ingest::generate_offload_proof,
            commands::ingest::export_reel_index,
            commands::ingest::export_metadata_manifest,
            commands::ingest::cancel_ingest,
            commands::ingest::write_ingest_report,
            commands::ingest::generate_ingest_report,
            commands::scan::scan_source,
            commands::scan::detect_camera_sources,
            commands::tokens::preview_pattern
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ingest Pilot");
}
