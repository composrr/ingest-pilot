mod commands;
mod core;
mod ingest;
mod platform;
mod sync;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(commands::ingest::IngestJobs::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::system::greet,
            commands::system::open_path,
            commands::system::disk_space,
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
            commands::ingest::scaffold_project,
            commands::ingest::run_ingest,
            commands::ingest::retry_failed_copies,
            commands::ingest::generate_offload_proof,
            commands::ingest::export_reel_index,
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
