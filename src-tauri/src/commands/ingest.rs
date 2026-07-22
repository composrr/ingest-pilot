use crate::commands::presets::get_preset;
use crate::core::folder_tree::{scaffold_project as scaffold, ScaffoldResult};
use crate::ingest::copier::{
    attach_report_thumbnails, recopy_and_verify, run_ingest as run_ingest_copy, REPORT_ASSET_DIR,
    run_ingest_multi as run_ingest_multi_copy, CopiedFile, FileVerified, IngestProgress,
    IngestResult, MultiIngestResult, SkippedFile, ThumbnailConfig,
};
use crate::core::metadata_preset::MetadataPreset;
use crate::ingest::metadata_manifest::{write_metadata_manifest, FolderMetadataOverride};
use crate::ingest::offload_proof::{write_offload_proof, OffloadProofInput};
use crate::ingest::reel_index::write_reel_index;
use crate::ingest::report::{write_html_report_to, ReportInput};
use crate::ingest::scanner::ScanFileKind;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct IngestJobs {
    jobs: Mutex<BTreeMap<String, Arc<AtomicBool>>>,
}

/// Build the report thumbnail config from saved settings (falling back to defaults if
/// settings can't be read). Shared by the report and offload-proof commands.
fn report_thumbnail_config(app: &AppHandle) -> ThumbnailConfig {
    match crate::commands::settings::get_settings(app.clone()) {
        Ok(settings) => ThumbnailConfig {
            include: settings.report_defaults.include_thumbnails,
            max_edge: settings.report_defaults.thumbnail_max_edge,
            jpeg_quality: settings.report_defaults.thumbnail_jpeg_quality,
        },
        Err(_) => ThumbnailConfig::default(),
    }
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
    camera_override: Option<String>,
    included_relative_paths: Option<Vec<String>>,
    use_existing_root: bool,
    job_id: Option<String>,
    root_name_override: Option<String>,
    file_rename_pattern_override: Option<String>,
) -> Result<IngestResult, String> {
    let mut preset =
        get_preset(app.clone(), preset_id)?.ok_or_else(|| "Preset not found.".to_string())?;
    // A per-ingest project name from the Naming wizard: overrides the preset's root
    // folder pattern for this run only (the preset itself is untouched). Resolved as
    // a pattern, so it may carry tokens or be a plain literal name.
    if let Some(name) = root_name_override
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        preset.root_folder_pattern = name.clone();
    }
    // A per-ingest file-rename pattern from the Ingest screen: overrides the preset's
    // base file_rename_pattern for this run only. Per-folder rename overrides (if any)
    // still take precedence in the copier, exactly as with the preset's own pattern.
    if let Some(pattern) = file_rename_pattern_override
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        preset.file_rename_pattern = pattern.clone();
    }
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
            camera_override,
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

/// Concurrent multi-destination ingest: copies one source to every destination at once
/// (one thread per drive, each reusing the verified-copy path). Mirrors `run_ingest`'s
/// job-registry + cancel wiring, but its emit closures fan out the extended
/// `ingest-progress` (now carrying `destinations[]`) plus a per-file `file-verified`
/// event, and it returns a `MultiIngestResult` (one root per destination + any failures).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn run_ingest_multi(
    app: AppHandle,
    jobs: State<'_, IngestJobs>,
    preset_id: String,
    source_path: String,
    variable_values: BTreeMap<String, String>,
    destination_paths: Vec<String>,
    preserve_sidecars: bool,
    rename_files: bool,
    camera_override: Option<String>,
    included_relative_paths: Option<Vec<String>>,
    use_existing_root: bool,
    job_id: Option<String>,
    root_name_override: Option<String>,
    file_rename_pattern_override: Option<String>,
) -> Result<MultiIngestResult, String> {
    let preset =
        get_preset(app.clone(), preset_id)?.ok_or_else(|| "Preset not found.".to_string())?;

    let cancel_flag = Arc::new(AtomicBool::new(false));
    if let Some(job_id) = job_id.as_ref() {
        jobs.jobs
            .lock()
            .map_err(|_| "Ingest job registry is unavailable.".to_string())?
            .insert(job_id.clone(), cancel_flag.clone());
    }

    let emit_job_id = job_id.clone().unwrap_or_default();
    let cancel_for_copy = cancel_flag.clone();
    let should_emit_progress = job_id.is_some();
    let app_for_progress = app.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let app_progress = app_for_progress.clone();
        let app_verified = app_for_progress.clone();
        let progress_job_id = emit_job_id.clone();
        let verified_job_id = emit_job_id.clone();

        let mut emit_progress = move |mut progress: IngestProgress| {
            progress.job_id = progress_job_id.clone();
            let _ = app_progress.emit("ingest-progress", progress);
        };
        let mut emit_verified = move |mut event: FileVerified| {
            event.job_id = verified_job_id.clone();
            let _ = app_verified.emit("file-verified", event);
        };

        let (progress_callback, verified_callback): (
            Option<&mut dyn FnMut(IngestProgress)>,
            Option<&mut dyn FnMut(FileVerified)>,
        ) = if should_emit_progress {
            (Some(&mut emit_progress), Some(&mut emit_verified))
        } else {
            (None, None)
        };

        run_ingest_multi_copy(
            &preset,
            source_path,
            variable_values,
            destination_paths,
            preserve_sidecars,
            rename_files,
            camera_override,
            included_relative_paths,
            use_existing_root,
            root_name_override,
            file_rename_pattern_override,
            Some(cancel_for_copy.as_ref()),
            progress_callback,
            verified_callback,
        )
    })
    .await
    .map_err(|error| format!("Ingest worker failed: {error}"))?;

    if let Some(job_id) = job_id.as_ref() {
        let _ = jobs.jobs.lock().map(|mut current| current.remove(job_id));
    }

    result
}

#[derive(Debug, Clone, Deserialize)]
pub struct RetryFailedItem {
    pub source_path: String,
    pub destination_path: String,
    pub kind: ScanFileKind,
    pub size_bytes: u64,
}

/// Re-copy and re-verify only the given failed files (one per destination copy).
/// Returns the updated CopiedFile entries so the UI can refresh its verification view.
#[tauri::command]
pub async fn retry_failed_copies(items: Vec<RetryFailedItem>) -> Result<Vec<CopiedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut results = Vec::with_capacity(items.len());
        for item in items {
            results.push(recopy_and_verify(
                &item.source_path,
                &item.destination_path,
                item.kind,
                item.size_bytes,
            )?);
        }
        Ok(results)
    })
    .await
    .map_err(|error| format!("Retry worker failed: {error}"))?
}

/// Build a printable PDF offload integrity proof at the project root.
#[tauri::command]
pub async fn generate_offload_proof(
    app: AppHandle,
    root_path: String,
    preset_name: String,
    source_paths: Vec<String>,
    destination_paths: Vec<String>,
    copied_files: Vec<CopiedFile>,
    files_copied: usize,
    verified_files: usize,
    verification_failed: usize,
    bytes_copied: u64,
    operator: String,
    generated_at: String,
    output_dir: Option<String>,
) -> Result<String, String> {
    let thumbnail_config = report_thumbnail_config(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let mut copied_files = copied_files;
        // Ensure thumbnails exist so the PDF can embed them. Idempotent with the HTML
        // report pass: assets are content-addressed and already-resolved files are
        // skipped, so this is cheap when the report ran first. Never fatal.
        let _ = attach_report_thumbnails(
            &PathBuf::from(&root_path),
            &mut copied_files,
            &source_paths.join(";"),
            thumbnail_config,
            None,
            None,
        );
        let path = write_offload_proof(OffloadProofInput {
            root_path: &root_path,
            output_dir: output_dir.as_deref(),
            preset_name: &preset_name,
            source_paths: &source_paths,
            destination_paths: &destination_paths,
            copied_files: &copied_files,
            files_copied,
            verified_files,
            verification_failed,
            bytes_copied,
            operator: &operator,
            generated_at: &generated_at,
        })?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| format!("Offload proof worker failed: {error}"))?
}

/// Write a per-clip reel index (CSV or JSON) to the project root.
#[tauri::command]
pub async fn export_reel_index(
    root_path: String,
    copied_files: Vec<CopiedFile>,
    format: String,
    output_dir: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = write_reel_index(&root_path, output_dir.as_deref(), &copied_files, format != "json")?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| format!("Reel index worker failed: {error}"))?
}

/// Write a metadata manifest CSV (one row per clip, shoot-wide values) to the
/// project root for bulk import into iconik.
#[tauri::command]
pub async fn export_metadata_manifest(
    root_path: String,
    copied_files: Vec<CopiedFile>,
    preset: MetadataPreset,
    values: BTreeMap<String, String>,
    folder_overrides: Option<Vec<FolderMetadataOverride>>,
    output_dir: Option<String>,
) -> Result<String, String> {
    let folder_overrides = folder_overrides.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let path = write_metadata_manifest(
            &root_path,
            output_dir.as_deref(),
            &copied_files,
            &preset,
            &values,
            &folder_overrides,
        )?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| format!("Metadata manifest worker failed: {error}"))?
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
    duration_ms: Option<u64>,
    output_dir: Option<String>,
) -> Result<String, String> {
    let report_path = write_html_report_to(
        &PathBuf::from(&root_path),
        output_dir.as_deref().map(std::path::Path::new),
        ReportInput {
            preset_name: &preset_name,
            source_path: &source_path,
            root_path: &root_path,
            destination_paths: &[],
            variable_values: &variable_values,
            copied_files: &copied_files,
            skipped_files: &skipped_files,
            files_copied,
            verified_files,
            verification_failed,
            bytes_copied,
            mhl_path: &mhl_path,
            duration_ms,
        },
    )?;

    Ok(report_path.to_string_lossy().to_string())
}

/// What `generate_ingest_report` hands back.
///
/// `copied_files` is the point: `attach_report_thumbnails` resolves `thumbnail_path` on its
/// own local copy of the list, so before this struct existed the generated thumbnails were
/// reachable only from the written HTML — the in-app completion grid, which filters on
/// `thumbnail_path`, therefore matched zero files and silently rendered nothing, no matter
/// what the asset protocol was doing. Returning the enriched list is what actually lights it up.
#[derive(Debug, Clone, Serialize)]
pub struct GeneratedReport {
    pub report_path: String,
    pub copied_files: Vec<CopiedFile>,
}

#[tauri::command]
pub async fn generate_ingest_report(
    app: AppHandle,
    preset_name: String,
    source_path: String,
    root_path: String,
    destination_roots: Vec<String>,
    variable_values: BTreeMap<String, String>,
    copied_files: Vec<CopiedFile>,
    skipped_files: Vec<SkippedFile>,
    files_copied: usize,
    verified_files: usize,
    verification_failed: usize,
    bytes_copied: u64,
    mhl_path: String,
    job_id: Option<String>,
    duration_ms: Option<u64>,
    output_dir: Option<String>,
) -> Result<GeneratedReport, String> {
    let app_for_progress = app.clone();
    let emit_job_id = job_id.unwrap_or_default();
    let thumbnail_config = report_thumbnail_config(&app);

    let generated = tauri::async_runtime::spawn_blocking(
        move || -> Result<(GeneratedReport, Vec<String>), String> {
        let mut copied_files = copied_files;
        let mut emit_progress = |mut progress: IngestProgress| {
            progress.job_id = emit_job_id.clone();
            let _ = app_for_progress.emit("report-progress", progress);
        };

        // Best-effort: thumbnails are optional, so never let their generation (an Err or
        // a contained panic surfaced as Err) block writing the HTML report the user needs.
        let _ = attach_report_thumbnails(
            &PathBuf::from(&root_path),
            &mut copied_files,
            &source_path,
            thumbnail_config,
            None,
            Some(&mut emit_progress),
        );

        // One combined report (lists every destination + each file's copy per destination).
        let report_path = write_html_report_to(
            &PathBuf::from(&root_path),
            output_dir.as_deref().map(std::path::Path::new),
            ReportInput {
                preset_name: &preset_name,
                source_path: &source_path,
                root_path: &root_path,
                destination_paths: &destination_roots,
                variable_values: &variable_values,
                copied_files: &copied_files,
                skipped_files: &skipped_files,
                files_copied,
                verified_files,
                verification_failed,
                bytes_copied,
                mhl_path: &mhl_path,
                duration_ms,
            },
        )?;

        // Mirror the combined report + its thumbnail assets into every other destination root,
        // so each drive carries the full record of where the media was written.
        let report_file = PathBuf::from(&report_path);
        let assets_dir = PathBuf::from(&root_path).join(REPORT_ASSET_DIR);
        // Roots whose asset dir this run actually WROTE. Accumulated from the write results
        // rather than from the caller's `destination_roots`, so a root we failed to mirror to
        // (unplugged drive, permission denied) is never handed to the asset scope.
        let mut written_asset_roots: Vec<String> = Vec::new();
        if assets_dir.is_dir() {
            written_asset_roots.push(root_path.clone());
        }
        for other in &destination_roots {
            if other == &root_path {
                continue;
            }
            let other_root = PathBuf::from(other);
            if let Some(name) = report_file.file_name() {
                let _ = std::fs::copy(&report_file, other_root.join(name));
            }
            if assets_dir.is_dir()
                && copy_dir_recursive(&assets_dir, &other_root.join(REPORT_ASSET_DIR)).is_ok()
            {
                written_asset_roots.push(other.clone());
            }
        }

        Ok((
            GeneratedReport {
                report_path: report_path.to_string_lossy().to_string(),
                copied_files,
            },
            written_asset_roots,
        ))
        },
    )
    .await
    .map_err(|error| format!("Report worker failed: {error}"))?;

    // Let the webview read the thumbnails we just wrote — and only those. Scoped to the roots
    // the write loop reported success for, so a failed mirror never widens the scope.
    // See `crate::allow_report_asset_dir` for what this grant does and does not guarantee.
    let (report, written_asset_roots) = generated?;
    for root in &written_asset_roots {
        crate::allow_report_asset_dir(&app, std::path::Path::new(root));
    }

    Ok(report)
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &target)?;
        } else {
            std::fs::copy(&path, &target)?;
        }
    }
    Ok(())
}
