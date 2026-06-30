use crate::core::condition::folder_condition_matches;
use crate::core::folder_tree::scaffold_project;
use crate::core::mhl::{write_mhl_file, MhlEntry};
use crate::core::preset::{FolderNode, FolderRole, Preset, VariableDefault};
use crate::core::token::{resolve_pattern, TokenContext};
use crate::ingest::scanner::{scan_source, ScanFileKind, ScannedFile};
use crate::ingest::verifier::verify_copy;
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const COPY_BUFFER_SIZE: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IngestResult {
    pub root_path: String,
    pub files_copied: usize,
    pub sidecars_copied: usize,
    pub skipped_files: usize,
    pub verified_files: usize,
    pub verification_failed: usize,
    pub bytes_copied: u64,
    pub mhl_path: String,
    pub report_path: String,
    pub copied_files: Vec<CopiedFile>,
    pub skipped: Vec<SkippedFile>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IngestProgress {
    pub job_id: String,
    pub phase: String,
    pub current_file: String,
    pub files_done: usize,
    pub total_files: usize,
    pub bytes_done: u64,
    pub total_bytes: u64,
    pub verified_bytes: u64,
    pub verified_files: usize,
    pub elapsed_ms: u128,
    pub bytes_per_second: u64,
    pub remaining_ms: Option<u128>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CopiedFile {
    pub source_path: String,
    pub destination_path: String,
    pub kind: ScanFileKind,
    pub size_bytes: u64,
    pub thumbnail_path: Option<String>,
    pub source_hash: String,
    pub destination_hash: String,
    pub verified: bool,
    /// Media duration in milliseconds (footage/audio only, when ffmpeg is available).
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkippedFile {
    pub source_path: String,
    pub reason: String,
}

#[derive(Debug, Clone)]
struct ResolvedFolder {
    id: String,
    name: String,
    path: PathBuf,
    role: Option<FolderRole>,
    is_footage_destination: bool,
}

#[derive(Debug, Clone)]
struct CopiedRoute {
    folder: ResolvedFolder,
    output_stem: String,
}

pub fn run_ingest(
    preset: &Preset,
    source_path: String,
    variable_values: BTreeMap<String, String>,
    destination_override: Option<String>,
    preserve_sidecars: bool,
    rename_files: bool,
    included_relative_paths: Option<Vec<String>>,
    use_existing_root: bool,
    cancel_flag: Option<&AtomicBool>,
    mut progress: Option<&mut dyn FnMut(IngestProgress)>,
) -> Result<IngestResult, String> {
    check_cancelled(cancel_flag)?;
    let scaffold = if use_existing_root {
        existing_root_scaffold(preset, destination_override.clone())?
    } else {
        scaffold_project(
            preset,
            variable_values.clone(),
            destination_override.clone(),
        )?
    };
    check_cancelled(cancel_flag)?;
    let root_path = PathBuf::from(&scaffold.root_path);
    let variable_values = values_with_defaults(preset, variable_values)?;
    let folders = resolve_folders(preset, &variable_values, &root_path)?;
    let scan = scan_source(&source_path)?;
    check_cancelled(cancel_flag)?;
    let started_at = std::time::Instant::now();
    let included_relative_paths =
        included_relative_paths.map(|paths| paths.into_iter().collect::<BTreeSet<_>>());
    let total = progress_total(
        &scan.files,
        preserve_sidecars,
        included_relative_paths.as_ref(),
    );
    emit_progress(
        &mut progress,
        "Preparing",
        "",
        0,
        total.files,
        0,
        total.bytes,
        0,
        0,
        started_at,
    );

    let mut result = IngestResult {
        root_path: scaffold.root_path,
        files_copied: 0,
        sidecars_copied: 0,
        skipped_files: 0,
        verified_files: 0,
        verification_failed: 0,
        bytes_copied: 0,
        mhl_path: String::new(),
        report_path: String::new(),
        copied_files: Vec::new(),
        skipped: Vec::new(),
    };
    let mut media_routes = BTreeMap::<String, CopiedRoute>::new();
    let mut clip_number = 1_u32;
    let mut files_done = 0_usize;
    let mut bytes_done = 0_u64;
    let mut verified_bytes = 0_u64;
    let mut verified_files = 0_usize;

    for file in scan
        .files
        .iter()
        .filter(|file| !matches!(file.kind, ScanFileKind::Sidecar))
    {
        check_cancelled(cancel_flag)?;
        if !is_file_selected(file, included_relative_paths.as_ref()) {
            push_skip(&mut result, file, "Not selected for this ingest.");
            continue;
        }
        if should_skip(file.kind) {
            push_skip(&mut result, file, skip_reason(file.kind));
            continue;
        }

        let folder = route_folder(preset, &folders, file.kind, &file.extension, &root_path);

        let base_bytes_done = bytes_done;
        let base_verified_bytes = verified_bytes;
        let base_verified_files = verified_files;
        let file_size = file.size_bytes;
        let relative_path = file.relative_path.clone();
        let mut transfer_progress = |phase: &str, current_file_bytes: u64| {
            emit_progress(
                &mut progress,
                phase,
                &relative_path,
                files_done,
                total.files,
                base_bytes_done + current_file_bytes.min(file_size),
                total.bytes,
                base_verified_bytes,
                base_verified_files,
                started_at,
            );
        };
        let prev_verified_files = result.verified_files;
        let copied = copy_file_to_folder(
            preset,
            file,
            &folder,
            &variable_values,
            clip_number,
            None,
            rename_files,
            cancel_flag,
            &mut result,
            Some(&mut transfer_progress),
        )?;
        files_done += 1;
        bytes_done += file.size_bytes;
        if result.verified_files > prev_verified_files {
            verified_bytes += file.size_bytes;
        }
        verified_files = result.verified_files;
        emit_progress(
            &mut progress,
            "Copying",
            &file.relative_path,
            files_done,
            total.files,
            bytes_done,
            total.bytes,
            verified_bytes,
            verified_files,
            started_at,
        );
        media_routes.insert(file.relative_path.clone(), copied);
        clip_number += 1;
    }

    for file in scan
        .files
        .iter()
        .filter(|file| matches!(file.kind, ScanFileKind::Sidecar))
    {
        check_cancelled(cancel_flag)?;
        if !preserve_sidecars {
            push_skip(&mut result, file, "Sidecar deletion is enabled.");
            continue;
        }

        let Some(parent_path) = file.sidecar_for.as_ref() else {
            push_skip(
                &mut result,
                file,
                "No matching media file for this sidecar.",
            );
            continue;
        };
        let Some(parent_route) = media_routes.get(parent_path) else {
            push_skip(&mut result, file, "Matching media file was not copied.");
            continue;
        };

        let base_bytes_done = bytes_done;
        let base_verified_bytes = verified_bytes;
        let base_verified_files = verified_files;
        let file_size = file.size_bytes;
        let relative_path = file.relative_path.clone();
        let mut transfer_progress = |phase: &str, current_file_bytes: u64| {
            emit_progress(
                &mut progress,
                phase,
                &relative_path,
                files_done,
                total.files,
                base_bytes_done + current_file_bytes.min(file_size),
                total.bytes,
                base_verified_bytes,
                base_verified_files,
                started_at,
            );
        };
        let prev_verified_files = result.verified_files;
        copy_file_to_folder(
            preset,
            file,
            &parent_route.folder,
            &variable_values,
            clip_number,
            Some(&parent_route.output_stem),
            rename_files,
            cancel_flag,
            &mut result,
            Some(&mut transfer_progress),
        )?;
        files_done += 1;
        bytes_done += file.size_bytes;
        if result.verified_files > prev_verified_files {
            verified_bytes += file.size_bytes;
        }
        verified_files = result.verified_files;
        emit_progress(
            &mut progress,
            "Copying sidecars",
            &file.relative_path,
            files_done,
            total.files,
            bytes_done,
            total.bytes,
            verified_bytes,
            verified_files,
            started_at,
        );
        result.sidecars_copied += 1;
    }

    check_cancelled(cancel_flag)?;
    emit_progress(
        &mut progress,
        "Writing verification record",
        "",
        files_done,
        total.files,
        bytes_done,
        total.bytes,
        verified_bytes,
        verified_files,
        started_at,
    );
    let mhl_path = write_mhl_file(&root_path, &mhl_entries(&root_path, &result.copied_files)?)?;
    result.mhl_path = mhl_path.to_string_lossy().to_string();
    emit_progress(
        &mut progress,
        "Complete",
        "",
        files_done,
        total.files,
        total.bytes,
        total.bytes,
        verified_bytes,
        verified_files,
        started_at,
    );

    Ok(result)
}

#[derive(Debug, Clone, Copy)]
struct ProgressTotal {
    files: usize,
    bytes: u64,
}

fn progress_total(
    files: &[ScannedFile],
    preserve_sidecars: bool,
    included_relative_paths: Option<&BTreeSet<String>>,
) -> ProgressTotal {
    let selected_media = files
        .iter()
        .filter(|file| !matches!(file.kind, ScanFileKind::Sidecar))
        .filter(|file| !should_skip(file.kind))
        .filter(|file| is_file_selected(file, included_relative_paths))
        .collect::<Vec<_>>();
    let selected_media_paths = selected_media
        .iter()
        .map(|file| file.relative_path.as_str())
        .collect::<BTreeSet<_>>();

    let mut total = ProgressTotal {
        files: selected_media.len(),
        bytes: selected_media.iter().map(|file| file.size_bytes).sum(),
    };

    if preserve_sidecars {
        for file in files
            .iter()
            .filter(|file| matches!(file.kind, ScanFileKind::Sidecar))
        {
            if file
                .sidecar_for
                .as_deref()
                .map(|parent| selected_media_paths.contains(parent))
                .unwrap_or(false)
            {
                total.files += 1;
                total.bytes += file.size_bytes;
            }
        }
    }

    total
}

fn is_report_thumbnail_progress_candidate(kind: ScanFileKind) -> bool {
    matches!(kind, ScanFileKind::Footage | ScanFileKind::Photo)
}

fn existing_root_scaffold(
    preset: &Preset,
    destination_override: Option<String>,
) -> Result<crate::core::folder_tree::ScaffoldResult, String> {
    let root_path = destination_override
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| preset.destinations.primary.clone());

    if root_path.trim().is_empty() {
        return Err("Choose an existing project folder before ingesting.".to_string());
    }

    let root_path = PathBuf::from(root_path);
    if root_path.exists() && !root_path.is_dir() {
        return Err(format!("{} is not a folder.", root_path.display()));
    }
    fs::create_dir_all(&root_path).map_err(|error| format!("{}: {error}", root_path.display()))?;

    Ok(crate::core::folder_tree::ScaffoldResult {
        root_path: root_path.to_string_lossy().to_string(),
        folders_created: 0,
        files_copied: 0,
        created_paths: Vec::new(),
    })
}

#[allow(clippy::too_many_arguments)]
fn emit_progress(
    progress: &mut Option<&mut dyn FnMut(IngestProgress)>,
    phase: &str,
    current_file: &str,
    files_done: usize,
    total_files: usize,
    bytes_done: u64,
    total_bytes: u64,
    verified_bytes: u64,
    verified_files: usize,
    started_at: std::time::Instant,
) {
    if let Some(progress) = progress.as_deref_mut() {
        let elapsed_ms = started_at.elapsed().as_millis();
        let bytes_per_second = if elapsed_ms > 0 {
            ((bytes_done as u128 * 1000) / elapsed_ms) as u64
        } else {
            0
        };
        let remaining_ms = if bytes_per_second > 0 && total_bytes > bytes_done {
            Some(((total_bytes - bytes_done) as u128 * 1000) / bytes_per_second as u128)
        } else {
            None
        };
        progress(IngestProgress {
            job_id: String::new(),
            phase: phase.to_string(),
            current_file: current_file.to_string(),
            files_done,
            total_files,
            bytes_done,
            total_bytes,
            verified_bytes,
            verified_files,
            elapsed_ms,
            bytes_per_second,
            remaining_ms,
        });
    }
}

fn is_file_selected(
    file: &ScannedFile,
    included_relative_paths: Option<&BTreeSet<String>>,
) -> bool {
    included_relative_paths
        .map(|paths| paths.contains(&file.relative_path))
        .unwrap_or(true)
}

fn should_skip(kind: ScanFileKind) -> bool {
    matches!(kind, ScanFileKind::Ignored | ScanFileKind::Unknown)
}

fn skip_reason(kind: ScanFileKind) -> &'static str {
    match kind {
        ScanFileKind::Ignored => "System/cache file ignored by default.",
        ScanFileKind::Unknown => "Unknown file type is not routed yet.",
        _ => "File was skipped.",
    }
}

fn push_skip(result: &mut IngestResult, file: &ScannedFile, reason: &str) {
    result.skipped_files += 1;
    result.skipped.push(SkippedFile {
        source_path: file.path.clone(),
        reason: reason.to_string(),
    });
}

fn copy_file_to_folder(
    preset: &Preset,
    file: &ScannedFile,
    folder: &ResolvedFolder,
    variable_values: &BTreeMap<String, String>,
    clip_number: u32,
    forced_stem: Option<&String>,
    rename_files: bool,
    cancel_flag: Option<&AtomicBool>,
    result: &mut IngestResult,
    mut transfer_progress: Option<&mut dyn FnMut(&str, u64)>,
) -> Result<CopiedRoute, String> {
    check_cancelled(cancel_flag)?;
    fs::create_dir_all(&folder.path)
        .map_err(|error| format!("{}: {error}", folder.path.display()))?;

    let target_name = match forced_stem {
        Some(stem) => format!("{stem}{}", file.extension),
        None if !rename_files => file.file_name.clone(),
        None => {
            let pattern = preset
                .per_folder_rename_overrides
                .get(&folder.id)
                .filter(|value| !value.trim().is_empty())
                .map(String::as_str)
                .unwrap_or_else(|| {
                    if preset.file_rename_pattern.trim().is_empty() {
                        "{original_name}{ext}"
                    } else {
                        &preset.file_rename_pattern
                    }
                });
            let resolved = resolve_pattern(
                pattern,
                &TokenContext {
                    preset_name: Some(preset.name.clone()),
                    variable_values: variable_values.clone(),
                    camera: Some(camera_hint(file)),
                    clip_number: Some(clip_number),
                    clip_number_padding: Some(preset.clip_number_padding),
                    original_name: Some(file.stem.clone()),
                    capture_date: Some(Local::now().format("%Y%m%d").to_string()),
                    extension: Some(file.extension.clone()),
                    folder_name: Some(folder.name.clone()),
                    ..TokenContext::default()
                },
            )?;
            ensure_file_extension(&resolved, &file.extension)
        }
    };

    let destination_path = unique_destination_path(&folder.path, &target_name);
    check_cancelled(cancel_flag)?;
    {
        let mut copy_progress = |bytes_copied: u64| {
            if let Some(progress) = transfer_progress.as_deref_mut() {
                progress("Copying", bytes_copied);
            }
        };
        copy_path_with_progress(
            Path::new(&file.path),
            &destination_path,
            cancel_flag,
            Some(&mut copy_progress),
        )?;
    }
    check_cancelled(cancel_flag)?;
    if let Some(progress) = transfer_progress.as_deref_mut() {
        progress("Verifying", file.size_bytes);
    }
    let verification = match verify_copy(Path::new(&file.path), &destination_path)? {
        verification if verification.verified => verification,
        _ => {
            check_cancelled(cancel_flag)?;
            let mut retry_progress = |bytes_copied: u64| {
                if let Some(progress) = transfer_progress.as_deref_mut() {
                    progress("Retrying copy", bytes_copied);
                }
            };
            copy_path_with_progress(
                Path::new(&file.path),
                &destination_path,
                cancel_flag,
                Some(&mut retry_progress),
            )?;
            if let Some(progress) = transfer_progress.as_deref_mut() {
                progress("Verifying retry", file.size_bytes);
            }
            verify_copy(Path::new(&file.path), &destination_path)?
        }
    };
    check_cancelled(cancel_flag)?;

    result.files_copied += 1;
    if verification.verified {
        result.verified_files += 1;
    } else {
        result.verification_failed += 1;
    }
    result.bytes_copied += file.size_bytes;
    result.copied_files.push(CopiedFile {
        source_path: file.path.clone(),
        destination_path: destination_path.to_string_lossy().to_string(),
        kind: file.kind,
        size_bytes: file.size_bytes,
        thumbnail_path: None,
        source_hash: verification.source_hash,
        destination_hash: verification.destination_hash,
        verified: verification.verified,
        duration_ms: if matches!(file.kind, ScanFileKind::Footage | ScanFileKind::Audio) {
            probe_duration_ms(&destination_path)
        } else {
            None
        },
    });

    Ok(CopiedRoute {
        folder: folder.clone(),
        output_stem: destination_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or(&file.stem)
            .to_string(),
    })
}

/// Re-copy a single source file to an exact destination path and re-verify it.
/// Used by the "retry failed" action to repair a destination copy whose hash
/// did not match, without re-running the whole ingest.
pub fn recopy_and_verify(
    source_path: &str,
    destination_path: &str,
    kind: ScanFileKind,
    size_bytes: u64,
) -> Result<CopiedFile, String> {
    let source = Path::new(source_path);
    let destination = Path::new(destination_path);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    copy_path_with_progress(source, destination, None, None)?;
    let verification = verify_copy(source, destination)?;
    Ok(CopiedFile {
        source_path: source_path.to_string(),
        destination_path: destination_path.to_string(),
        kind,
        size_bytes,
        thumbnail_path: None,
        source_hash: verification.source_hash,
        destination_hash: verification.destination_hash,
        verified: verification.verified,
        duration_ms: if matches!(kind, ScanFileKind::Footage | ScanFileKind::Audio) {
            probe_duration_ms(destination)
        } else {
            None
        },
    })
}

fn copy_path_with_progress(
    source_path: &Path,
    destination_path: &Path,
    cancel_flag: Option<&AtomicBool>,
    mut progress: Option<&mut dyn FnMut(u64)>,
) -> Result<(), String> {
    let mut source =
        fs::File::open(source_path).map_err(|error| format!("{}: {error}", source_path.display()))?;
    let mut destination = fs::File::create(destination_path)
        .map_err(|error| format!("{}: {error}", destination_path.display()))?;
    let mut buffer = vec![0_u8; COPY_BUFFER_SIZE];
    let mut bytes_copied = 0_u64;

    if let Some(progress) = progress.as_deref_mut() {
        progress(bytes_copied);
    }

    loop {
        check_cancelled(cancel_flag)?;
        let bytes_read = source
            .read(&mut buffer)
            .map_err(|error| format!("{}: {error}", source_path.display()))?;
        if bytes_read == 0 {
            break;
        }
        destination
            .write_all(&buffer[..bytes_read])
            .map_err(|error| format!("{}: {error}", destination_path.display()))?;
        bytes_copied += bytes_read as u64;
        if let Some(progress) = progress.as_deref_mut() {
            progress(bytes_copied);
        }
    }

    destination
        .flush()
        .map_err(|error| format!("{}: {error}", destination_path.display()))?;
    Ok(())
}

fn unique_destination_path(folder_path: &Path, target_name: &str) -> PathBuf {
    let candidate = folder_path.join(target_name);
    if !candidate.exists() {
        return candidate;
    }

    let path = Path::new(target_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(target_name);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();

    for index in 2.. {
        let candidate = folder_path.join(format!("{stem}_{index}{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    unreachable!("duplicate filename search is unbounded");
}

fn route_folder(
    preset: &Preset,
    folders: &[ResolvedFolder],
    kind: ScanFileKind,
    extension: &str,
    root_path: &Path,
) -> ResolvedFolder {
    if let Some(folder_id) = preset.file_type_routing_overrides.get(extension) {
        if let Some(folder) = folders.iter().find(|folder| folder.id == *folder_id) {
            return folder.clone();
        }
    }

    let target_role = match kind {
        ScanFileKind::Audio => Some(FolderRole::Audio),
        ScanFileKind::Photo => Some(FolderRole::Photos),
        ScanFileKind::Document => Some(FolderRole::Documents),
        ScanFileKind::Footage => Some(FolderRole::Footage),
        _ => None,
    };

    if let Some(role) = target_role {
        if let Some(folder) = folders.iter().rev().find(|folder| {
            folder.role == Some(role.clone())
                || (role == FolderRole::Footage && folder.is_footage_destination)
        }) {
            return folder.clone();
        }
    }

    // Nothing matched by override or role. Prefer an explicit footage
    // destination, then the first folder in the tree. If the preset defines no
    // folders at all, fall back to the project root so media still lands
    // somewhere instead of being skipped.
    folders
        .iter()
        .rev()
        .find(|folder| folder.is_footage_destination)
        .cloned()
        .or_else(|| folders.first().cloned())
        .unwrap_or_else(|| root_destination_folder(root_path))
}

const ROOT_DESTINATION_ID: &str = "__ingest_root__";

/// A synthetic destination pointing at the project root, used when a preset
/// defines no folders. Media is copied directly into the created root folder
/// rather than skipped with "No matching target folder."
fn root_destination_folder(root_path: &Path) -> ResolvedFolder {
    ResolvedFolder {
        id: ROOT_DESTINATION_ID.to_string(),
        name: root_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: root_path.to_path_buf(),
        role: None,
        is_footage_destination: true,
    }
}

fn ensure_file_extension(file_name: &str, extension: &str) -> String {
    if extension.is_empty() {
        return file_name.to_string();
    }

    if file_name
        .to_lowercase()
        .ends_with(&extension.to_lowercase())
    {
        file_name.to_string()
    } else {
        format!("{file_name}{extension}")
    }
}

fn check_cancelled(cancel_flag: Option<&AtomicBool>) -> Result<(), String> {
    if cancel_flag
        .map(|flag| flag.load(Ordering::SeqCst))
        .unwrap_or(false)
    {
        return Err("Ingest cancelled.".to_string());
    }

    Ok(())
}

fn mhl_entries(root_path: &Path, copied_files: &[CopiedFile]) -> Result<Vec<MhlEntry>, String> {
    copied_files
        .iter()
        .map(|file| {
            let destination_path = PathBuf::from(&file.destination_path);
            let relative_path = destination_path
                .strip_prefix(root_path)
                .map_err(|_| {
                    format!(
                        "{} is outside ingest root {}",
                        destination_path.display(),
                        root_path.display()
                    )
                })?
                .to_string_lossy()
                .replace('\\', "/");
            Ok(MhlEntry {
                relative_path,
                size_bytes: file.size_bytes,
                hash: file.destination_hash.clone(),
                verified: file.verified,
            })
        })
        .collect()
}

pub fn attach_report_thumbnails(
    root_path: &Path,
    copied_files: &mut [CopiedFile],
    source_path: &str,
    cancel_flag: Option<&AtomicBool>,
    mut progress: Option<&mut dyn FnMut(IngestProgress)>,
) -> Result<(), String> {
    let started_at = std::time::Instant::now();
    let total = copied_files
        .iter()
        .filter(|file| is_report_thumbnail_progress_candidate(file.kind))
        .count();
    let asset_dir = root_path.join("IngestPilot_Report_Assets").join("thumbs");
    let thumbnail_source_files = report_thumbnail_sources(source_path);
    let thumbnail_sources = thumbnail_source_files.iter().collect::<Vec<_>>();
    let mut used_thumbnail_sources = BTreeSet::<String>::new();
    let mut done = 0_usize;

    emit_progress(
        &mut progress,
        "Preparing report thumbnails",
        "",
        0,
        total,
        0,
        total as u64,
        0,
        0,
        started_at,
    );

    for file in copied_files {
        check_cancelled(cancel_flag)?;
        if is_report_thumbnail_progress_candidate(file.kind) {
            done += 1;
            let current_file = file.destination_path.clone();
            attach_report_thumbnail_for_file(
                root_path,
                &asset_dir,
                &thumbnail_sources,
                &mut used_thumbnail_sources,
                file,
                cancel_flag,
            )?;
            emit_progress(
                &mut progress,
                "Generating report thumbnails",
                &current_file,
                done,
                total,
                done as u64,
                total as u64,
                done as u64,
                done,
                started_at,
            );
        } else {
            attach_report_thumbnail_for_file(
                root_path,
                &asset_dir,
                &thumbnail_sources,
                &mut used_thumbnail_sources,
                file,
                cancel_flag,
            )?;
        }
    }

    emit_progress(
        &mut progress,
        "Report thumbnails complete",
        "",
        total,
        total,
        total as u64,
        total as u64,
        total as u64,
        total,
        started_at,
    );

    Ok(())
}

fn report_thumbnail_sources(source_path: &str) -> Vec<ScannedFile> {
    source_path
        .split(';')
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .filter_map(|path| scan_source(path).ok())
        .flat_map(|scan| {
            scan.files
                .into_iter()
                .filter(is_report_thumbnail_candidate)
                .collect::<Vec<_>>()
        })
        .collect()
}

fn attach_report_thumbnail_for_file(
    root_path: &Path,
    asset_dir: &Path,
    thumbnail_sources: &[&ScannedFile],
    used_thumbnail_sources: &mut BTreeSet<String>,
    file: &mut CopiedFile,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(), String> {
    check_cancelled(cancel_flag)?;
    let destination_path = PathBuf::from(&file.destination_path);
    let extension = destination_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_lowercase()))
        .unwrap_or_default();

    if is_browser_image_extension(&extension) {
        file.thumbnail_path = Some(relative_to_root(root_path, &destination_path)?);
        return Ok(());
    }

    if !matches!(file.kind, ScanFileKind::Footage | ScanFileKind::Photo) {
        return Ok(());
    }

    let stem = Path::new(&file.source_path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if let Some(thumbnail_source) =
        matching_thumbnail_source(file, thumbnail_sources, used_thumbnail_sources)
    {
        fs::create_dir_all(asset_dir)
            .map_err(|error| format!("{}: {error}", asset_dir.display()))?;
        used_thumbnail_sources.insert(thumbnail_source.path.clone());
        let thumbnail_source_path = PathBuf::from(&thumbnail_source.path);
        let thumbnail_extension = thumbnail_source_path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{}", value.to_lowercase()))
            .unwrap_or_else(|| ".jpg".to_string());
        let thumbnail_target = unique_destination_path(
            asset_dir,
            &format!("{}{}", sanitize_asset_name(&stem), thumbnail_extension),
        );
        fs::copy(&thumbnail_source_path, &thumbnail_target).map_err(|error| {
            format!(
                "{} -> {}: {error}",
                thumbnail_source_path.display(),
                thumbnail_target.display()
            )
        })?;
        file.thumbnail_path = Some(relative_to_root(root_path, &thumbnail_target)?);
        return Ok(());
    }

    if matches!(file.kind, ScanFileKind::Footage) {
        if let Some(generated_thumbnail) =
            generate_ffmpeg_thumbnail(&destination_path, asset_dir, &stem)
        {
            file.thumbnail_path = Some(relative_to_root(root_path, &generated_thumbnail)?);
        }
    }

    Ok(())
}

fn generate_ffmpeg_thumbnail(
    video_path: &Path,
    asset_dir: &Path,
    source_stem: &str,
) -> Option<PathBuf> {
    let ffmpeg = ffmpeg_path()?;
    fs::create_dir_all(asset_dir).ok()?;
    for timestamp in ["00:00:02", "00:00:00.5", "00:00:00"] {
        let thumbnail_target = unique_destination_path(
            asset_dir,
            &format!("{}_ffmpeg.jpg", sanitize_asset_name(source_stem)),
        );
        let mut command = Command::new(&ffmpeg);
        hide_subprocess_window(&mut command);
        let output = command
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-ss",
                timestamp,
                "-i",
            ])
            .arg(video_path)
            .args(["-frames:v", "1", "-vf", "scale=360:-2"])
            .arg(&thumbnail_target)
            .output()
            .ok()?;

        if output.status.success() && thumbnail_target.exists() {
            return Some(thumbnail_target);
        }
        let _ = fs::remove_file(&thumbnail_target);
    }

    None
}

/// Best-effort media duration via `ffmpeg -i` (parses the "Duration:" line from
/// stderr). Returns None when ffmpeg is unavailable or the file has no duration.
fn probe_duration_ms(path: &Path) -> Option<u64> {
    let ffmpeg = ffmpeg_path()?;
    let mut command = Command::new(&ffmpeg);
    hide_subprocess_window(&mut command);
    let output = command
        .args(["-hide_banner", "-nostdin", "-i"])
        .arg(path)
        .output()
        .ok()?;
    // ffmpeg with no output file exits non-zero but still prints Duration to stderr.
    parse_ffmpeg_duration_ms(&String::from_utf8_lossy(&output.stderr))
}

fn parse_ffmpeg_duration_ms(text: &str) -> Option<u64> {
    let idx = text.find("Duration:")?;
    let after = &text[idx + "Duration:".len()..];
    let clip = after.split(',').next()?.trim();
    if clip.starts_with("N/A") {
        return None;
    }
    let mut parts = clip.split(':');
    let hours: f64 = parts.next()?.trim().parse().ok()?;
    let minutes: f64 = parts.next()?.trim().parse().ok()?;
    let seconds: f64 = parts.next()?.trim().parse().ok()?;
    let total = hours * 3600.0 + minutes * 60.0 + seconds;
    if total <= 0.0 {
        return None;
    }
    Some((total * 1000.0) as u64)
}

fn ffmpeg_path() -> Option<PathBuf> {
    if let Ok(path) = env::var("INGEST_PILOT_FFMPEG") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }

    for root in ffmpeg_search_roots() {
        for candidate in [
            root.join("ffmpeg.exe"),
            root.join("ffmpeg"),
            root.join("resources").join("ffmpeg.exe"),
            root.join("resources").join("ffmpeg"),
            root.join("node_modules")
                .join("ffmpeg-static")
                .join("ffmpeg.exe"),
            root.join("node_modules")
                .join("ffmpeg-static")
                .join("ffmpeg"),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    if command_is_available("ffmpeg") {
        Some(PathBuf::from("ffmpeg"))
    } else {
        None
    }
}

fn ffmpeg_search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(current_dir) = env::current_dir() {
        roots.extend(current_dir.ancestors().map(Path::to_path_buf));
    }
    if let Ok(current_exe) = env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            roots.extend(parent.ancestors().map(Path::to_path_buf));
        }
    }
    roots
}

fn command_is_available(command: &str) -> bool {
    let mut command = Command::new(command);
    hide_subprocess_window(&mut command);
    command
        .args(["-hide_banner", "-version"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn hide_subprocess_window(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn matching_thumbnail_source<'a>(
    copied_file: &CopiedFile,
    thumbnail_sources: &[&'a ScannedFile],
    used_thumbnail_sources: &BTreeSet<String>,
) -> Option<&'a ScannedFile> {
    let source_stem = Path::new(&copied_file.source_path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    let normalized_source = normalized_match_stem(&source_stem);
    let source_digits = digits_only(&source_stem);

    thumbnail_sources
        .iter()
        .copied()
        .filter(|candidate| !used_thumbnail_sources.contains(&candidate.path))
        .find(|candidate| {
            let candidate_stem = candidate.stem.to_lowercase();
            if candidate_stem == source_stem {
                return true;
            }

            let normalized_candidate = normalized_match_stem(&candidate_stem);
            if !normalized_source.is_empty()
                && !normalized_candidate.is_empty()
                && (normalized_candidate.contains(&normalized_source)
                    || normalized_source.contains(&normalized_candidate))
            {
                return true;
            }

            let candidate_digits = digits_only(&candidate_stem);
            !source_digits.is_empty()
                && !candidate_digits.is_empty()
                && (candidate_digits == source_digits
                    || candidate_digits.ends_with(&source_digits)
                    || source_digits.ends_with(&candidate_digits))
        })
        .or_else(|| {
            thumbnail_sources
                .iter()
                .copied()
                .find(|candidate| !used_thumbnail_sources.contains(&candidate.path))
        })
}

fn is_report_thumbnail_candidate(file: &ScannedFile) -> bool {
    matches!(file.kind, ScanFileKind::Ignored | ScanFileKind::Photo)
        && is_browser_image_extension(&file.extension)
        && file
            .relative_path
            .to_lowercase()
            .split(['/', '\\'])
            .any(|part| {
                matches!(
                    part,
                    "thumbnail"
                        | "thumbnails"
                        | "thumb"
                        | "thumbs"
                        | "thmbnl"
                        | ".thumbnails"
                        | "preview"
                        | "previews"
                )
            })
}

fn is_browser_image_extension(extension: &str) -> bool {
    matches!(extension, ".jpg" | ".jpeg" | ".png" | ".gif" | ".webp")
}

fn normalized_match_stem(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(|character| character.to_lowercase())
        .collect()
}

fn digits_only(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_digit())
        .collect()
}

fn relative_to_root(root_path: &Path, path: &Path) -> Result<String, String> {
    Ok(path
        .strip_prefix(root_path)
        .map_err(|_| format!("{} is outside {}", path.display(), root_path.display()))?
        .to_string_lossy()
        .replace('\\', "/"))
}

fn sanitize_asset_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "thumbnail".to_string()
    } else {
        sanitized
    }
}

fn resolve_folders(
    preset: &Preset,
    variable_values: &BTreeMap<String, String>,
    root_path: &Path,
) -> Result<Vec<ResolvedFolder>, String> {
    let mut folders = Vec::new();
    for folder in &preset.folder_tree {
        resolve_folder(folder, root_path, preset, variable_values, &mut folders)?;
    }
    Ok(folders)
}

fn resolve_folder(
    folder: &FolderNode,
    parent_path: &Path,
    preset: &Preset,
    variable_values: &BTreeMap<String, String>,
    folders: &mut Vec<ResolvedFolder>,
) -> Result<(), String> {
    if !folder_condition_matches(&folder.condition, variable_values) {
        return Ok(());
    }

    for expanded_values in expand_values_for_folder_pattern(&folder.name_pattern, variable_values) {
        let folder_name = resolve_pattern(
            &folder.name_pattern,
            &TokenContext {
                preset_name: Some(preset.name.clone()),
                variable_values: expanded_values.clone(),
                clip_number_padding: Some(preset.clip_number_padding),
                ..TokenContext::default()
            },
        )?;
        let folder_path = parent_path.join(&folder_name);
        folders.push(ResolvedFolder {
            id: folder.id.clone(),
            name: folder_name,
            path: folder_path.clone(),
            role: folder.role.clone(),
            is_footage_destination: folder.is_footage_destination,
        });

        for child in &folder.children {
            resolve_folder(child, &folder_path, preset, &expanded_values, folders)?;
        }
    }

    Ok(())
}

fn values_with_defaults(
    preset: &Preset,
    mut variable_values: BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    for variable in &preset.variables {
        let has_value = variable_values
            .get(&variable.id)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        if !has_value {
            if let Some(default) = &variable.default {
                variable_values.insert(variable.id.clone(), default_to_string(default));
            }
        }

        let has_value = variable_values
            .get(&variable.id)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        if variable.required && !has_value {
            return Err(format!("{} is required.", variable.name));
        }
    }

    Ok(variable_values)
}

fn default_to_string(default: &VariableDefault) -> String {
    match default {
        VariableDefault::Text(value) => value.clone(),
        VariableDefault::Bool(value) => value.to_string(),
    }
}

fn expand_values_for_folder_pattern(
    pattern: &str,
    variable_values: &BTreeMap<String, String>,
) -> Vec<BTreeMap<String, String>> {
    let mut expanded = vec![variable_values.clone()];

    for token in tokens_in_pattern(pattern) {
        let Some(value) = variable_values.get(&token) else {
            continue;
        };
        let parts = comma_separated_values(value);
        if parts.len() <= 1 {
            continue;
        }

        expanded = expanded
            .into_iter()
            .flat_map(|values| {
                let token = token.clone();
                parts.iter().map(move |part| {
                    let mut next = values.clone();
                    next.insert(token.clone(), part.clone());
                    next
                })
            })
            .collect();
    }

    expanded
}

fn comma_separated_values(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn tokens_in_pattern(pattern: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut rest = pattern;

    while let Some(start) = rest.find('{') {
        let after_start = &rest[start + 1..];
        let Some(end) = after_start.find('}') else {
            break;
        };
        let token = after_start[..end].trim();
        if !token.is_empty() && !tokens.iter().any(|candidate| candidate == token) {
            tokens.push(token.to_string());
        }
        rest = &after_start[end + 1..];
    }

    tokens
}

fn camera_hint(file: &ScannedFile) -> String {
    if let Some(prefix) = camera_prefix_from_stem(&file.stem) {
        return prefix;
    }

    Path::new(&file.relative_path)
        .ancestors()
        .filter_map(|path| path.file_name().and_then(|value| value.to_str()))
        .find(|value| !is_generic_camera_folder(value))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("CAM")
        .to_string()
}

fn camera_prefix_from_stem(stem: &str) -> Option<String> {
    let prefix = stem
        .split(['_', '-', ' '])
        .next()
        .unwrap_or_default()
        .trim();
    let has_letter = prefix
        .chars()
        .any(|character| character.is_ascii_alphabetic());
    let has_digit = prefix.chars().any(|character| character.is_ascii_digit());

    if prefix.len() >= 2 && has_letter && has_digit {
        Some(prefix.to_string())
    } else {
        None
    }
}

fn is_generic_camera_folder(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "clip"
            | "clips"
            | "stream"
            | "private"
            | "m4root"
            | "avchd"
            | "bdmv"
            | "dcim"
            | "mp_root"
            | "xdroot"
            | "contents"
            | "bpav"
            | "100media"
            | "101media"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::preset::{PresetDestinations, PresetVariable, VariableType};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_ffmpeg_duration_line() {
        let sample = "  Duration: 00:02:03.50, start: 0.000000, bitrate: 1234 kb/s";
        assert_eq!(parse_ffmpeg_duration_ms(sample), Some(123_500));
        assert_eq!(parse_ffmpeg_duration_ms("Duration: N/A, bitrate: N/A"), None);
        assert_eq!(parse_ffmpeg_duration_ms("no duration here"), None);
    }

    #[test]
    fn copies_routed_media_and_paired_sidecars() {
        let workspace = unique_temp_dir("ingest_pilot_copy_test");
        let source = workspace.join("source");
        let destination = workspace.join("output");
        fs::create_dir_all(&source).expect("source dir");
        fs::write(source.join("A.MP4"), vec![0; 10]).expect("media");
        fs::write(source.join("A.XML"), vec![0; 3]).expect("sidecar");
        fs::write(source.join("README"), vec![0; 2]).expect("unknown");

        let preset = Preset {
            schema_version: 1,
            id: "preset_test".to_string(),
            name: "Story".to_string(),
            description: None,
            icon: None,
            color: None,
            variables: vec![PresetVariable {
                id: "story_name".to_string(),
                name: "Story Name".to_string(),
                variable_type: VariableType::ShortText,
                required: true,
                default: None,
                options: vec![],
            }],
            root_folder_pattern: "{story_name}".to_string(),
            folder_tree: vec![FolderNode {
                id: "folder_footage".to_string(),
                name_pattern: "Footage".to_string(),
                is_footage_destination: true,
                children: vec![],
                template_files: vec![],
                condition: None,
                role: Some(FolderRole::Footage),
            }],
            file_rename_pattern: "{original_name}_{clip#}{ext}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: destination.to_string_lossy().to_string(),
                secondaries: vec![],
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            target_bps: 0,
            created_at: "2026-04-24T00:00:00Z".to_string(),
            updated_at: "2026-04-24T00:00:00Z".to_string(),
        };

        let result = run_ingest(
            &preset,
            source.to_string_lossy().to_string(),
            BTreeMap::from([("story_name".to_string(), "Baptism".to_string())]),
            None,
            true,
            true,
            None,
            false,
            None,
            None,
        )
        .expect("ingest succeeds");

        let root = PathBuf::from(&result.root_path);
        assert!(root.join("Footage").join("A_001.mp4").exists());
        assert!(root.join("Footage").join("A_001.xml").exists());
        assert_eq!(result.files_copied, 2);
        assert_eq!(result.verified_files, 2);
        assert_eq!(result.verification_failed, 0);
        assert!(result.copied_files.iter().all(|file| file.verified));
        assert_eq!(result.sidecars_copied, 1);
        assert_eq!(result.skipped_files, 1);
        assert!(PathBuf::from(&result.mhl_path).exists());
        assert!(result.report_path.is_empty());

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn copies_into_root_when_preset_has_no_folders() {
        let workspace = unique_temp_dir("ingest_pilot_empty_tree_test");
        let source = workspace.join("source");
        let destination = workspace.join("output");
        fs::create_dir_all(&source).expect("source dir");
        fs::write(source.join("A.MP4"), vec![0; 10]).expect("media");

        let preset = Preset {
            schema_version: 1,
            id: "preset_empty".to_string(),
            name: "Loose".to_string(),
            description: None,
            icon: None,
            color: None,
            variables: vec![PresetVariable {
                id: "story_name".to_string(),
                name: "Story Name".to_string(),
                variable_type: VariableType::ShortText,
                required: true,
                default: None,
                options: vec![],
            }],
            root_folder_pattern: "{story_name}".to_string(),
            // No folders defined at all — media should land in the root.
            folder_tree: vec![],
            file_rename_pattern: "{original_name}_{clip#}{ext}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: destination.to_string_lossy().to_string(),
                secondaries: vec![],
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            target_bps: 0,
            created_at: "2026-04-24T00:00:00Z".to_string(),
            updated_at: "2026-04-24T00:00:00Z".to_string(),
        };

        let result = run_ingest(
            &preset,
            source.to_string_lossy().to_string(),
            BTreeMap::from([("story_name".to_string(), "Baptism".to_string())]),
            None,
            true,
            true,
            None,
            false,
            None,
            None,
        )
        .expect("ingest succeeds");

        let root = PathBuf::from(&result.root_path);
        // Lands directly in the created root folder, not skipped.
        assert!(root.join("A_001.mp4").exists());
        assert_eq!(result.files_copied, 1);
        assert_eq!(result.skipped_files, 0);
        assert!(result.skipped.is_empty());

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn keeps_extension_when_rename_pattern_omits_ext() {
        assert_eq!(
            ensure_file_extension("Footage_CAM_001", ".mp4"),
            "Footage_CAM_001.mp4"
        );
        assert_eq!(
            ensure_file_extension("Footage_CAM_001.MP4", ".mp4"),
            "Footage_CAM_001.MP4"
        );
    }

    #[test]
    fn camera_hint_prefers_fx_style_filename_prefix_over_clip_folder() {
        let file = ScannedFile {
            path: "P:/PRIVATE/M4ROOT/CLIP/FX3_6713.MP4".to_string(),
            relative_path: "PRIVATE/M4ROOT/CLIP/FX3_6713.MP4".to_string(),
            file_name: "FX3_6713.MP4".to_string(),
            stem: "FX3_6713".to_string(),
            extension: ".mp4".to_string(),
            size_bytes: 10,
            modified_at: None,
            kind: ScanFileKind::Footage,
            sidecar_for: None,
            thumbnail_path: None,
        };

        assert_eq!(camera_hint(&file), "FX3");
    }

    #[test]
    fn routes_footage_to_expanded_child_target() {
        let workspace = unique_temp_dir("ingest_pilot_route_test");
        let source = workspace.join("source");
        let destination = workspace.join("output");
        fs::create_dir_all(&source).expect("source dir");
        fs::write(source.join("A.MP4"), vec![1; 10]).expect("media");

        let preset = Preset {
            schema_version: 1,
            id: "preset_test".to_string(),
            name: "Story".to_string(),
            description: None,
            icon: None,
            color: None,
            variables: vec![PresetVariable {
                id: "campus".to_string(),
                name: "Campus".to_string(),
                variable_type: VariableType::Dropdown,
                required: true,
                default: None,
                options: vec!["KLR".to_string(), "MCK".to_string()],
            }],
            root_folder_pattern: "Project".to_string(),
            folder_tree: vec![FolderNode {
                id: "folder_footage".to_string(),
                name_pattern: "Footage".to_string(),
                is_footage_destination: true,
                children: vec![FolderNode {
                    id: "folder_campus".to_string(),
                    name_pattern: "{campus}".to_string(),
                    is_footage_destination: true,
                    children: vec![],
                    template_files: vec![],
                    condition: None,
                    role: Some(FolderRole::Footage),
                }],
                template_files: vec![],
                condition: None,
                role: Some(FolderRole::Footage),
            }],
            file_rename_pattern: "{folder_name}_{clip#}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: destination.to_string_lossy().to_string(),
                secondaries: vec![],
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            target_bps: 0,
            created_at: "2026-04-24T00:00:00Z".to_string(),
            updated_at: "2026-04-24T00:00:00Z".to_string(),
        };

        let result = run_ingest(
            &preset,
            source.to_string_lossy().to_string(),
            BTreeMap::from([("campus".to_string(), "KLR".to_string())]),
            None,
            true,
            true,
            None,
            false,
            None,
            None,
        )
        .expect("ingest succeeds");

        assert!(PathBuf::from(&result.root_path)
            .join("Footage")
            .join("KLR")
            .join("KLR_001.mp4")
            .exists());
        assert!(!PathBuf::from(&result.root_path)
            .join("Footage")
            .join("Footage_001.mp4")
            .exists());

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn copies_only_selected_media_files() {
        let workspace = unique_temp_dir("ingest_pilot_selected_copy_test");
        let source = workspace.join("source");
        let destination = workspace.join("output");
        fs::create_dir_all(&source).expect("source dir");
        fs::write(source.join("A.MP4"), vec![1; 10]).expect("media a");
        fs::write(source.join("B.MP4"), vec![2; 10]).expect("media b");

        let preset = Preset {
            schema_version: 1,
            id: "preset_test".to_string(),
            name: "Story".to_string(),
            description: None,
            icon: None,
            color: None,
            variables: vec![],
            root_folder_pattern: "Project".to_string(),
            folder_tree: vec![FolderNode {
                id: "folder_footage".to_string(),
                name_pattern: "Footage".to_string(),
                is_footage_destination: true,
                children: vec![],
                template_files: vec![],
                condition: None,
                role: Some(FolderRole::Footage),
            }],
            file_rename_pattern: "{original_name}{ext}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: destination.to_string_lossy().to_string(),
                secondaries: vec![],
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            target_bps: 0,
            created_at: "2026-04-24T00:00:00Z".to_string(),
            updated_at: "2026-04-24T00:00:00Z".to_string(),
        };

        let result = run_ingest(
            &preset,
            source.to_string_lossy().to_string(),
            BTreeMap::new(),
            None,
            true,
            true,
            Some(vec!["A.MP4".to_string()]),
            false,
            None,
            None,
        )
        .expect("ingest succeeds");

        let root = PathBuf::from(&result.root_path);
        assert!(root.join("Footage").join("A.mp4").exists());
        assert!(!root.join("Footage").join("B.mp4").exists());
        assert_eq!(result.files_copied, 1);
        assert!(result
            .skipped
            .iter()
            .any(|file| file.source_path.ends_with("B.MP4")
                && file.reason == "Not selected for this ingest."));

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn can_ingest_into_existing_project_root() {
        let workspace = unique_temp_dir("ingest_pilot_existing_root_test");
        let source = workspace.join("source");
        let existing_root = workspace.join("ExistingProject");
        fs::create_dir_all(&source).expect("source dir");
        fs::create_dir_all(existing_root.join("Footage")).expect("existing project dir");
        fs::write(source.join("A.MP4"), vec![1; 10]).expect("media");

        let preset = Preset {
            schema_version: 1,
            id: "preset_test".to_string(),
            name: "Story".to_string(),
            description: None,
            icon: None,
            color: None,
            variables: vec![],
            root_folder_pattern: "ShouldNotBeCreated".to_string(),
            folder_tree: vec![FolderNode {
                id: "folder_footage".to_string(),
                name_pattern: "Footage".to_string(),
                is_footage_destination: true,
                children: vec![],
                template_files: vec![],
                condition: None,
                role: Some(FolderRole::Footage),
            }],
            file_rename_pattern: "{original_name}{ext}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: String::new(),
                secondaries: vec![],
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            target_bps: 0,
            created_at: "2026-04-24T00:00:00Z".to_string(),
            updated_at: "2026-04-24T00:00:00Z".to_string(),
        };

        let result = run_ingest(
            &preset,
            source.to_string_lossy().to_string(),
            BTreeMap::new(),
            Some(existing_root.to_string_lossy().to_string()),
            true,
            true,
            None,
            true,
            None,
            None,
        )
        .expect("ingest succeeds");

        assert_eq!(PathBuf::from(&result.root_path), existing_root);
        assert!(PathBuf::from(&result.root_path)
            .join("Footage")
            .join("A.mp4")
            .exists());
        assert!(!workspace
            .join("ExistingProject")
            .join("ShouldNotBeCreated")
            .exists());

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn attaches_matching_camera_thumbnail_to_report() {
        let workspace = unique_temp_dir("ingest_pilot_thumbnail_report_test");
        let source = workspace.join("source");
        let destination = workspace.join("output");
        fs::create_dir_all(source.join("DCIM").join("100MEDIA")).expect("media dir");
        fs::create_dir_all(source.join("DCIM").join("THUMBNAIL")).expect("thumb dir");
        fs::write(
            source.join("DCIM").join("100MEDIA").join("A.MP4"),
            vec![1; 10],
        )
        .expect("media");
        fs::write(
            source.join("DCIM").join("THUMBNAIL").join("A.JPG"),
            vec![2; 10],
        )
        .expect("thumb");

        let preset = Preset {
            schema_version: 1,
            id: "preset_test".to_string(),
            name: "Story".to_string(),
            description: None,
            icon: None,
            color: None,
            variables: vec![],
            root_folder_pattern: "Project".to_string(),
            folder_tree: vec![FolderNode {
                id: "folder_footage".to_string(),
                name_pattern: "Footage".to_string(),
                is_footage_destination: true,
                children: vec![],
                template_files: vec![],
                condition: None,
                role: Some(FolderRole::Footage),
            }],
            file_rename_pattern: "{original_name}{ext}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: destination.to_string_lossy().to_string(),
                secondaries: vec![],
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            target_bps: 0,
            created_at: "2026-04-24T00:00:00Z".to_string(),
            updated_at: "2026-04-24T00:00:00Z".to_string(),
        };

        let mut result = run_ingest(
            &preset,
            source.to_string_lossy().to_string(),
            BTreeMap::new(),
            None,
            true,
            true,
            None,
            false,
            None,
            None,
        )
        .expect("ingest succeeds");

        attach_report_thumbnails(
            &PathBuf::from(&result.root_path),
            &mut result.copied_files,
            &source.to_string_lossy(),
            None,
            None,
        )
        .expect("thumbnails attach");
        let thumbnail_path = result.copied_files[0]
            .thumbnail_path
            .as_ref()
            .expect("thumbnail path");
        assert!(PathBuf::from(&result.root_path)
            .join(thumbnail_path)
            .exists());

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn attaches_thmbnl_thumbnail_by_clip_digits() {
        let workspace = unique_temp_dir("ingest_pilot_thmbnl_report_test");
        let source = workspace.join("source");
        let destination = workspace.join("output");
        fs::create_dir_all(source.join("PRIVATE").join("M4ROOT").join("CLIP")).expect("media dir");
        fs::create_dir_all(source.join("PRIVATE").join("M4ROOT").join("THMBNL"))
            .expect("thumb dir");
        fs::write(
            source
                .join("PRIVATE")
                .join("M4ROOT")
                .join("CLIP")
                .join("FX3_6713.MP4"),
            vec![1; 10],
        )
        .expect("media");
        fs::write(
            source
                .join("PRIVATE")
                .join("M4ROOT")
                .join("THMBNL")
                .join("C6713.JPG"),
            vec![2; 10],
        )
        .expect("thumb");

        let preset = Preset {
            schema_version: 1,
            id: "preset_test".to_string(),
            name: "Story".to_string(),
            description: None,
            icon: None,
            color: None,
            variables: vec![],
            root_folder_pattern: "Project".to_string(),
            folder_tree: vec![FolderNode {
                id: "folder_footage".to_string(),
                name_pattern: "Footage".to_string(),
                is_footage_destination: true,
                children: vec![],
                template_files: vec![],
                condition: None,
                role: Some(FolderRole::Footage),
            }],
            file_rename_pattern: "{original_name}{ext}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: destination.to_string_lossy().to_string(),
                secondaries: vec![],
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            target_bps: 0,
            created_at: "2026-04-24T00:00:00Z".to_string(),
            updated_at: "2026-04-24T00:00:00Z".to_string(),
        };

        let mut result = run_ingest(
            &preset,
            source.to_string_lossy().to_string(),
            BTreeMap::new(),
            None,
            true,
            true,
            None,
            false,
            None,
            None,
        )
        .expect("ingest succeeds");

        attach_report_thumbnails(
            &PathBuf::from(&result.root_path),
            &mut result.copied_files,
            &source.to_string_lossy(),
            None,
            None,
        )
        .expect("thumbnails attach");
        let thumbnail_path = result.copied_files[0]
            .thumbnail_path
            .as_ref()
            .expect("thumbnail path");
        assert!(PathBuf::from(&result.root_path)
            .join(thumbnail_path)
            .exists());

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn generates_report_thumbnail_with_ffmpeg_when_available() {
        let Some(ffmpeg) = ffmpeg_path() else {
            return;
        };
        let workspace = unique_temp_dir("ingest_pilot_ffmpeg_thumbnail_test");
        let video_path = workspace.join("A001.mp4");
        let asset_dir = workspace.join("thumbs");
        fs::create_dir_all(&workspace).expect("workspace");

        let status = Command::new(ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=1:size=160x90:rate=1",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&video_path)
            .status()
            .expect("ffmpeg can run");
        assert!(status.success());

        let thumbnail = generate_ffmpeg_thumbnail(&video_path, &asset_dir, "A001")
            .expect("thumbnail generated");
        assert!(thumbnail.exists());
        assert!(thumbnail
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .contains("_ffmpeg"));

        let _ = fs::remove_dir_all(workspace);
    }

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_millis();
        std::env::temp_dir().join(format!("{prefix}_{suffix}"))
    }
}
