use crate::commands::presets::get_preset;
use crate::core::folder_tree::{scaffold_project as scaffold, ScaffoldResult};
use crate::ingest::copier::{
    attach_report_thumbnails, run_ingest as run_ingest_copy, CopiedFile, IngestProgress,
    IngestResult, SkippedFile,
};
use crate::ingest::report::{write_html_report, ReportInput};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct IngestJobs {
    jobs: Mutex<BTreeMap<String, Arc<AtomicBool>>>,
}

#[tauri::command]
pub fn scaffold_project(
    app: AppHandle,
    preset_id: String,
    variable_values: BTreeMap<String, String>,
    destination_override: Option<String>,
) -> Result<ScaffoldResult, String> {
    let preset =
        get_preset(app.clone(), preset_id)?.ok_or_else(|| "Preset not found.".to_string())?;
    scaffold(&preset, variable_values, destination_override)
}

#[tauri::command]
pub async fn run_ingest(
    app: AppHandle,
    jobs: State<'_, IngestJobs>,
    preset_id: String,
    source_path: String,
    variable_values: BTreeMap<String, String>,
    destination_override: Option<String>,
    preserve_sidecars: bool,
    rename_files: bool,
    included_relative_paths: Option<Vec<String>>,
    use_existing_root: bool,
    job_id: Option<String>,
) -> Result<IngestResult, String> {
    let preset =
        get_preset(app.clone(), preset_id)?.ok_or_else(|| "Preset not found.".to_string())?;
    let cancel_flag = Arc::new(AtomicBool::new(false));
    if let Some(job_id) = job_id.as_ref() {
        jobs.jobs
            .lock()
            .map_err(|_| "Ingest job registry is unavailable.".to_string())?
            .insert(job_id.clone(), cancel_flag.clone());
    }

    let app_for_progress = app.clone();
    let emit_job_id = job_id.clone().unwrap_or_default();
    let cancel_for_copy = cancel_flag.clone();
    let should_emit_progress = job_id.is_some();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut emit_progress = |mut progress: IngestProgress| {
            progress.job_id = emit_job_id.clone();
            let _ = app_for_progress.emit("ingest-progress", progress);
        };
        let progress_callback: Option<&mut dyn FnMut(IngestProgress)> = if should_emit_progress {
            Some(&mut emit_progress)
        } else {
            None
        };

        run_ingest_copy(
            &preset,
            source_path,
            variable_values,
            destination_override,
            preserve_sidecars,
            rename_files,
            included_relative_paths,
            use_existing_root,
            Some(cancel_for_copy.as_ref()),
            progress_callback,
        )
    })
    .await
    .map_err(|error| format!("Ingest worker failed: {error}"))?;

    if let Some(job_id) = job_id.as_ref() {
        let _ = jobs.jobs.lock().map(|mut current| current.remove(job_id));
    }

    result
}

#[tauri::command]
pub fn cancel_ingest(jobs: State<'_, IngestJobs>, job_id: String) -> Result<(), String> {
    let jobs = jobs
        .jobs
        .lock()
        .map_err(|_| "Ingest job registry is unavailable.".to_string())?;
    let Some(cancel_flag) = jobs.get(&job_id) else {
        return Ok(());
    };
    cancel_flag.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn write_ingest_report(
    preset_name: String,
    source_path: String,
    root_path: String,
    variable_values: BTreeMap<String, String>,
    copied_files: Vec<CopiedFile>,
    skipped_files: Vec<SkippedFile>,
    files_copied: usize,
    verified_files: usize,
    verification_failed: usize,
    bytes_copied: u64,
    mhl_path: String,
) -> Result<String, String> {
    let report_path = write_html_report(
        &PathBuf::from(&root_path),
        ReportInput {
            preset_name: &preset_name,
            source_path: &source_path,
            root_path: &root_path,
            variable_values: &variable_values,
            copied_files: &copied_files,
            skipped_files: &skipped_files,
            files_copied,
            verified_files,
            verification_failed,
            bytes_copied,
            mhl_path: &mhl_path,
        },
    )?;

    Ok(report_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn generate_ingest_report(
    app: AppHandle,
    preset_name: String,
    source_path: String,
    root_path: String,
    variable_values: BTreeMap<String, String>,
    copied_files: Vec<CopiedFile>,
    skipped_files: Vec<SkippedFile>,
    files_copied: usize,
    verified_files: usize,
    verification_failed: usize,
    bytes_copied: u64,
    mhl_path: String,
    job_id: Option<String>,
) -> Result<String, String> {
    let app_for_progress = app.clone();
    let emit_job_id = job_id.unwrap_or_default();

    tauri::async_runtime::spawn_blocking(move || {
        let mut copied_files = copied_files;
        let mut emit_progress = |mut progress: IngestProgress| {
            progress.job_id = emit_job_id.clone();
            let _ = app_for_progress.emit("report-progress", progress);
        };

        attach_report_thumbnails(
            &PathBuf::from(&root_path),
            &mut copied_files,
            &source_path,
            None,
            Some(&mut emit_progress),
        )?;

        let report_path = write_html_report(
            &PathBuf::from(&root_path),
            ReportInput {
                preset_name: &preset_name,
                source_path: &source_path,
                root_path: &root_path,
                variable_values: &variable_values,
                copied_files: &copied_files,
                skipped_files: &skipped_files,
                files_copied,
                verified_files,
                verification_failed,
                bytes_copied,
                mhl_path: &mhl_path,
            },
        )?;

        Ok(report_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| format!("Report worker failed: {error}"))?
}
