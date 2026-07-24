use crate::core::condition::folder_condition_matches;
use crate::core::folder_tree::scaffold_project;
use crate::core::mhl::{write_mhl_file, MhlEntry};
use crate::core::preset::{FolderNode, FolderRole, Preset, VariableDefault};
use crate::core::token::{resolve_pattern, TokenContext};
use crate::ingest::scanner::{scan_source, ScanFileKind, ScannedFile};
use crate::ingest::verifier::verify_copy;
use chrono::Local;
use serde::{Deserialize, Serialize};
use rayon::prelude::*;
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const COPY_BUFFER_SIZE: usize = 4 * 1024 * 1024;

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
    /// Number of destinations this run is copying to. `0`/empty for the classic
    /// single-destination path so the pre-C2 UI (which ignores these) keeps working.
    /// Additive + `#[serde(default)]` so events serialized before this field still parse.
    #[serde(default)]
    pub destination_count: u32,
    /// Per-destination progress snapshots (concurrent multi-destination copy). Empty for
    /// the single-destination path; the aggregate fields above stay populated regardless.
    #[serde(default)]
    pub destinations: Vec<DestinationProgress>,
}

/// Live progress for one destination drive within a concurrent multi-destination copy.
/// All integer fields so it can derive `Eq` alongside `IngestProgress`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DestinationProgress {
    /// 0-based index into the caller's destination list.
    pub index: u32,
    /// The destination the user chose (drive/folder root of this copy).
    pub path: String,
    /// Short display label for the destination (drive/volume/folder name).
    pub label: String,
    /// Current phase for this destination (mirrors the single-dest `IngestProgress.phase`).
    pub phase: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub verified_bytes: u64,
    pub verified_files: usize,
    pub failed_files: usize,
    pub bytes_per_second: u64,
    pub remaining_ms: Option<u64>,
    pub free_space_bytes: Option<u64>,
}

/// One `file-verified` payload: emitted once per file per destination as it finishes
/// verifying, giving the UI a live integrity feed. `job_id` is stamped by the command
/// layer (like `IngestProgress.job_id`), so the copier leaves it empty.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileVerified {
    pub job_id: String,
    pub destination_index: u32,
    pub destination_path: String,
    pub source_path: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub verified: bool,
    pub source_hash: String,
    pub destination_hash: String,
    /// Checksum algorithm used for source-vs-destination verification.
    pub algo: String,
}

/// A destination whose copy thread failed (drive pulled, unwritable path, panic). The
/// multi-destination run captures these per-destination and lets the others finish
/// rather than aborting the whole job.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DestinationFailure {
    pub index: u32,
    pub path: String,
    pub error: String,
}

/// Result of a concurrent multi-destination ingest: one `IngestResult` per destination
/// that completed (in destination order) plus any per-destination failures.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MultiIngestResult {
    pub roots: Vec<IngestResult>,
    pub failures: Vec<DestinationFailure>,
}

/// Static per-destination display metadata computed once (path label + free space), so
/// the ~10 Hz aggregate emitter doesn't re-query the OS on every tick.
#[derive(Debug, Clone)]
struct DestinationMeta {
    index: u32,
    path: String,
    label: String,
    free_space_bytes: Option<u64>,
}

/// How a report thumbnail was produced, so the HTML/PDF can style genuine
/// previews vs the intentional per-format placeholder. Additive + `#[serde(default)]`
/// so history/report JSON written before this field still deserializes.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThumbnailKind {
    /// A real image lifted straight out of the file (browser image, raw embedded
    /// preview, or exiftool-extracted preview).
    Embedded,
    /// A companion thumbnail image copied from a sidecar/THMBNL folder.
    Sidecar,
    /// A poster frame grabbed from video via ffmpeg.
    Ffmpeg,
    /// Extraction was attempted but nothing worked — the report renders a styled
    /// per-format card (e.g. "ARW" / "R3D") instead of a blank box.
    Placeholder,
    /// No thumbnail and none attempted (non-media file, or legacy JSON).
    #[default]
    None,
}

/// Tunables for report thumbnail extraction, sourced from `ReportDefaults`.
#[derive(Debug, Clone, Copy)]
pub struct ThumbnailConfig {
    /// Master switch (`ReportDefaults.include_thumbnails`); when false the attach
    /// loop early-returns and every file stays `ThumbnailKind::None`.
    pub include: bool,
    /// Longest edge of the generated JPEG, in pixels.
    pub max_edge: u32,
    /// JPEG quality (1–100) for the re-encoded thumbnail.
    pub jpeg_quality: u8,
}

impl Default for ThumbnailConfig {
    fn default() -> Self {
        Self {
            include: true,
            max_edge: 480,
            jpeg_quality: 80,
        }
    }
}

impl ThumbnailConfig {
    /// Clamp caller-supplied values into safe ranges (a 0-edge or 0-quality would
    /// make the `image` encoder unhappy).
    pub fn sanitized(self) -> Self {
        Self {
            include: self.include,
            max_edge: self.max_edge.clamp(64, 4096),
            jpeg_quality: self.jpeg_quality.clamp(1, 100),
        }
    }
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
    /// Provenance of `thumbnail_path` (or why it's absent). Diagnostic + drives the
    /// report placeholder styling.
    #[serde(default)]
    pub thumbnail_kind: ThumbnailKind,
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

/// Single-destination ingest (public, stable signature — the classic path used by the
/// `run_ingest` command, the retry flow, and every existing test). Delegates to
/// `run_ingest_inner` with no per-file `file_verified` hook.
#[allow(clippy::too_many_arguments)]
pub fn run_ingest(
    preset: &Preset,
    source_path: String,
    variable_values: BTreeMap<String, String>,
    destination_override: Option<String>,
    preserve_sidecars: bool,
    rename_files: bool,
    camera_override: Option<String>,
    included_relative_paths: Option<Vec<String>>,
    use_existing_root: bool,
    cancel_flag: Option<&AtomicBool>,
    progress: Option<&mut dyn FnMut(IngestProgress)>,
) -> Result<IngestResult, String> {
    run_ingest_inner(
        preset,
        source_path,
        variable_values,
        destination_override,
        preserve_sidecars,
        rename_files,
        // Default (flatten) behavior for every classic caller — unchanged.
        false,
        camera_override,
        included_relative_paths,
        use_existing_root,
        cancel_flag,
        progress,
        None,
    )
}

/// Core single-destination ingest. `file_verified` is an OPTIONAL hook fired once per
/// file right after `copy_file_to_folder` records it (carrying the freshly-copied
/// `CopiedFile` and this run's `root_path`); the concurrent multi-destination path uses
/// it to stream a live per-file integrity feed. `None` for every classic caller.
#[allow(clippy::too_many_arguments)]
fn run_ingest_inner(
    preset: &Preset,
    source_path: String,
    variable_values: BTreeMap<String, String>,
    destination_override: Option<String>,
    preserve_sidecars: bool,
    rename_files: bool,
    preserve_structure: bool,
    camera_override: Option<String>,
    included_relative_paths: Option<Vec<String>>,
    use_existing_root: bool,
    cancel_flag: Option<&AtomicBool>,
    mut progress: Option<&mut dyn FnMut(IngestProgress)>,
    mut file_verified: Option<&mut dyn FnMut(&CopiedFile, &Path)>,
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
        let copied = match copy_file_to_folder(
            preset,
            file,
            &folder,
            &variable_values,
            clip_number,
            None,
            rename_files,
            preserve_structure,
            camera_override.as_deref(),
            cancel_flag,
            &mut result,
            Some(&mut transfer_progress),
        ) {
            Ok(copied) => copied,
            Err(error) => {
                // A genuine cancellation still stops the whole run; any other
                // per-file failure (unreadable source, write error) is recorded
                // and the ingest continues with the remaining files.
                check_cancelled(cancel_flag)?;
                push_skip(&mut result, file, &format!("Copy failed: {error}"));
                files_done += 1;
                continue;
            }
        };
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
        // Live per-file hook: the copy just recorded exactly one CopiedFile, so
        // `copied_files.last()` is this file. Used by the multi-destination path to emit
        // a `file-verified` event as each file finishes verifying.
        if let Some(callback) = file_verified.as_deref_mut() {
            if let Some(copied_file) = result.copied_files.last() {
                callback(copied_file, &root_path);
            }
        }
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
            preserve_structure,
            camera_override.as_deref(),
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
        if let Some(callback) = file_verified.as_deref_mut() {
            if let Some(copied_file) = result.copied_files.last() {
                callback(copied_file, &root_path);
            }
        }
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

/// Concurrent multi-destination ingest: copies the same source to N destinations at once,
/// one thread per destination, each REUSING the proven single-destination verified-copy
/// path (`run_ingest_inner`). Per-destination routing/rename/re-ingest-skip/verify and the
/// per-root MHL all stay correct because every destination independently runs the full
/// pipeline against a read-only shared source and its own disjoint output root.
///
/// Tradeoff (accepted for this phase): the source is read once PER destination (N reads),
/// not a single read teed to N writers. A single-read tee is deliberately out of scope —
/// per-destination reuse of the battle-tested path is lower risk and preserves every edge
/// case (per-dest folder routing, re-ingest skip, unique-name resolution, sidecar pairing).
///
/// Progress: each destination thread streams its `IngestProgress` + per-file
/// `file-verified` info over a channel to this (calling) thread, which aggregates them
/// into a combined `IngestProgress` (with `destinations[]`) throttled to ~10 Hz and
/// forwards each `file-verified` immediately. A failing destination is captured and the
/// others finish; a cancel short-circuits to an error like the single-dest path.
#[allow(clippy::too_many_arguments)]
pub fn run_ingest_multi(
    preset: &Preset,
    source_path: String,
    variable_values: BTreeMap<String, String>,
    destination_overrides: Vec<String>,
    preserve_sidecars: bool,
    rename_files: bool,
    preserve_structure: bool,
    camera_override: Option<String>,
    included_relative_paths: Option<Vec<String>>,
    use_existing_root: bool,
    root_name_override: Option<String>,
    file_rename_pattern_override: Option<String>,
    cancel_flag: Option<&AtomicBool>,
    mut per_dest_progress: Option<&mut dyn FnMut(IngestProgress)>,
    mut file_verified: Option<&mut dyn FnMut(FileVerified)>,
) -> Result<MultiIngestResult, String> {
    // Apply per-ingest overrides to a local preset clone (mirrors the single-dest command
    // layer). The caller's preset is left untouched; every destination thread shares this
    // read-only clone by reference.
    let mut preset = preset.clone();
    if let Some(name) = root_name_override
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        preset.root_folder_pattern = name.clone();
    }
    if let Some(pattern) = file_rename_pattern_override
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        preset.file_rename_pattern = pattern.clone();
    }
    let preset = &preset;

    // DEDUP by canonical key, preserving order. Two entries that resolve to the SAME
    // root (a drive picked twice, a trailing-separator variant, or a case variant on
    // Windows) would otherwise spawn two threads writing the same files into the same
    // root: `scaffold_project` derives the root deterministically with no uniquification,
    // and `unique_destination_path` is a non-atomic exists()-then-create — so concurrent
    // writers to one root would clobber each other's bytes mid-copy, let `verify_copy`
    // hash a half-written file (spurious fail OR a false-positive attestation on clobbered
    // bytes), and write the MHL twice (last-writer-wins, possibly not matching disk). We
    // keep only the FIRST of each duplicate group so no two roots are ever the same path.
    let mut seen_destination_keys = std::collections::HashSet::new();
    let destinations: Vec<String> = destination_overrides
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .filter(|value| seen_destination_keys.insert(canonical_destination_key(value)))
        .collect();
    if destinations.is_empty() {
        return Err("Choose at least one destination before ingesting.".to_string());
    }
    let destination_count = destinations.len();

    // Static per-destination metadata (label + free space) computed once so the throttled
    // aggregate emitter never re-queries the OS on every tick.
    let dest_meta: Vec<DestinationMeta> = destinations
        .iter()
        .enumerate()
        .map(|(index, path)| DestinationMeta {
            index: index as u32,
            path: path.clone(),
            label: destination_label(path),
            free_space_bytes: free_space_bytes(path),
        })
        .collect();

    // Latest per-destination snapshot; only ever touched by the drain loop on THIS thread,
    // so no locking is required.
    let mut latest: Vec<Option<IngestProgress>> = vec![None; destination_count];
    let started_at = std::time::Instant::now();
    // Force the first Progress event through immediately (throttle window already elapsed).
    let mut last_emit = started_at
        .checked_sub(std::time::Duration::from_millis(1_000))
        .unwrap_or(started_at);

    enum MultiEvent {
        Progress {
            index: usize,
            progress: IngestProgress,
        },
        Verified(FileVerified),
    }

    let join_results: Vec<std::thread::Result<Result<IngestResult, String>>> =
        std::thread::scope(|scope| {
            let (tx, rx) = std::sync::mpsc::channel::<MultiEvent>();
            let handles: Vec<_> = destinations
                .iter()
                .enumerate()
                .map(|(index, destination)| {
                    let tx_progress = tx.clone();
                    let tx_verified = tx.clone();
                    let destination = destination.clone();
                    let source_path = source_path.clone();
                    let variable_values = variable_values.clone();
                    let camera_override = camera_override.clone();
                    let included_relative_paths = included_relative_paths.clone();
                    scope.spawn(move || {
                        let mut progress_cb = move |progress: IngestProgress| {
                            let _ = tx_progress.send(MultiEvent::Progress { index, progress });
                        };
                        let mut verified_cb = move |copied: &CopiedFile, root: &Path| {
                            // relative_path = where the file landed within this dest's root.
                            let relative_path = Path::new(&copied.destination_path)
                                .strip_prefix(root)
                                .map(|rel| rel.to_string_lossy().replace('\\', "/"))
                                .unwrap_or_else(|_| copied.destination_path.clone());
                            let _ = tx_verified.send(MultiEvent::Verified(FileVerified {
                                job_id: String::new(),
                                destination_index: index as u32,
                                destination_path: root.to_string_lossy().to_string(),
                                source_path: copied.source_path.clone(),
                                relative_path,
                                size_bytes: copied.size_bytes,
                                verified: copied.verified,
                                source_hash: copied.source_hash.clone(),
                                destination_hash: copied.destination_hash.clone(),
                                algo: "XXH3-128".to_string(),
                            }));
                        };
                        run_ingest_inner(
                            preset,
                            source_path,
                            variable_values,
                            Some(destination),
                            preserve_sidecars,
                            rename_files,
                            preserve_structure,
                            camera_override,
                            included_relative_paths,
                            use_existing_root,
                            cancel_flag,
                            Some(&mut progress_cb),
                            Some(&mut verified_cb),
                        )
                    })
                })
                .collect();
            // Drop our own sender so `rx` closes once every worker's clones drop.
            drop(tx);

            // Drain on THIS thread: aggregate + throttle progress; forward each
            // file-verified immediately (~1/file/dest, no throttle needed).
            for event in rx {
                match event {
                    MultiEvent::Progress { index, progress } => {
                        if let Some(slot) = latest.get_mut(index) {
                            *slot = Some(progress);
                        }
                        let now = std::time::Instant::now();
                        if now.duration_since(last_emit) >= std::time::Duration::from_millis(100) {
                            last_emit = now;
                            if let Some(callback) = per_dest_progress.as_deref_mut() {
                                callback(aggregate_multi_progress(&dest_meta, &latest, started_at));
                            }
                        }
                    }
                    MultiEvent::Verified(payload) => {
                        if let Some(callback) = file_verified.as_deref_mut() {
                            callback(payload);
                        }
                    }
                }
            }

            handles.into_iter().map(|handle| handle.join()).collect()
        });

    // Always emit a final aggregate so the bar reflects the terminal state even if the
    // last per-dest event fell inside the throttle window.
    if let Some(callback) = per_dest_progress.as_deref_mut() {
        callback(aggregate_multi_progress(&dest_meta, &latest, started_at));
    }

    // A cancel short-circuits to an error, matching single-dest `run_ingest`.
    if cancel_flag
        .map(|flag| flag.load(Ordering::SeqCst))
        .unwrap_or(false)
    {
        return Err("Ingest cancelled.".to_string());
    }

    // Split successes/failures in destination order. A panicked thread becomes a failure
    // too, so one bad drive can never take down the whole job.
    let mut roots = Vec::new();
    let mut failures = Vec::new();
    for (index, outcome) in join_results.into_iter().enumerate() {
        let meta = &dest_meta[index];
        match outcome {
            Ok(Ok(result)) => roots.push(result),
            Ok(Err(error)) => failures.push(DestinationFailure {
                index: index as u32,
                path: meta.path.clone(),
                error,
            }),
            Err(_) => failures.push(DestinationFailure {
                index: index as u32,
                path: meta.path.clone(),
                error: "Destination copy thread panicked.".to_string(),
            }),
        }
    }

    Ok(MultiIngestResult { roots, failures })
}

/// Fold the latest per-destination `IngestProgress` snapshots into one combined
/// `IngestProgress` for the `ingest-progress` event: byte/file/verify counters summed
/// across destinations (so the overall bar runs 0→100% as all drives finish), aggregate
/// throughput = sum of per-dest speeds, and the headline phase/current_file taken from the
/// least-progressed (laggard) destination.
fn aggregate_multi_progress(
    dest_meta: &[DestinationMeta],
    latest: &[Option<IngestProgress>],
    started_at: std::time::Instant,
) -> IngestProgress {
    let destination_count = dest_meta.len();
    let mut destinations = Vec::with_capacity(destination_count);
    let mut files_done = 0_usize;
    let mut bytes_done = 0_u64;
    let mut verified_bytes = 0_u64;
    let mut verified_files = 0_usize;
    let mut bytes_per_second = 0_u64;
    // Representative per-destination totals. Every destination copies the SAME selected
    // files, so the denominator is one destination's total × destination_count — NOT the
    // sum of only the destinations that have reported so far. Summing reported totals makes
    // the overall percent jump BACKWARD when a slow drive emits its first event (its 0/N
    // suddenly enlarges the denominator). We take the max reported total as the
    // representative (the very first "Preparing" tick already carries the full total).
    let mut rep_total_files = 0_usize;
    let mut rep_total_bytes = 0_u64;
    // Laggard = smallest (bytes_done, files_done) AMONG REPORTED destinations only. An
    // unreported (None) destination must never win with (0,0) and stall the headline at
    // "Preparing" — including at the forced final emit, where a failed/never-reporting
    // destination would otherwise make the terminal event read "Preparing" while the
    // successful drives are done. Failures are surfaced separately in
    // `MultiIngestResult.failures`.
    let mut laggard: Option<((u64, usize), String, String)> = None;

    for (meta, slot) in dest_meta.iter().zip(latest.iter()) {
        let snapshot = slot.as_ref();
        let d_bytes_done = snapshot.map(|p| p.bytes_done).unwrap_or(0);
        let d_bytes_total = snapshot.map(|p| p.total_bytes).unwrap_or(0);
        let d_verified_bytes = snapshot.map(|p| p.verified_bytes).unwrap_or(0);
        let d_verified_files = snapshot.map(|p| p.verified_files).unwrap_or(0);
        let d_files_done = snapshot.map(|p| p.files_done).unwrap_or(0);
        let d_total_files = snapshot.map(|p| p.total_files).unwrap_or(0);
        let d_bps = snapshot.map(|p| p.bytes_per_second).unwrap_or(0);
        let d_phase = snapshot
            .map(|p| p.phase.clone())
            .unwrap_or_else(|| "Preparing".to_string());
        let d_current = snapshot.map(|p| p.current_file.clone()).unwrap_or_default();
        let d_remaining = snapshot.and_then(|p| p.remaining_ms).map(|ms| ms as u64);

        destinations.push(DestinationProgress {
            index: meta.index,
            path: meta.path.clone(),
            label: meta.label.clone(),
            phase: d_phase.clone(),
            bytes_done: d_bytes_done,
            bytes_total: d_bytes_total,
            verified_bytes: d_verified_bytes,
            verified_files: d_verified_files,
            // Per-dest failed count isn't carried on IngestProgress mid-run; the final
            // per-root IngestResult.verification_failed is the source of truth. Kept 0 here.
            failed_files: 0,
            bytes_per_second: d_bps,
            remaining_ms: d_remaining,
            free_space_bytes: meta.free_space_bytes,
        });

        files_done += d_files_done;
        bytes_done += d_bytes_done;
        verified_bytes += d_verified_bytes;
        verified_files += d_verified_files;
        rep_total_files = rep_total_files.max(d_total_files);
        rep_total_bytes = rep_total_bytes.max(d_bytes_total);

        // Only in-progress destinations contribute to aggregate throughput: a finished
        // drive's stale last-reported bps would inflate the aggregate speed and make
        // remaining_ms optimistic mid-run.
        let is_complete = snapshot.map(|p| p.phase == "Complete").unwrap_or(false);
        if snapshot.is_some() && !is_complete {
            bytes_per_second += d_bps;
        }

        // Laggard only among destinations that have actually reported.
        if snapshot.is_some() {
            let key = (d_bytes_done, d_files_done);
            let is_new_laggard = laggard
                .as_ref()
                .map(|(current, _, _)| key < *current)
                .unwrap_or(true);
            if is_new_laggard {
                laggard = Some((key, d_phase, d_current));
            }
        }
    }

    let total_files = rep_total_files.saturating_mul(destination_count);
    let total_bytes = rep_total_bytes.saturating_mul(destination_count as u64);

    let (phase, current_file) = laggard
        .map(|(_, phase, current)| (phase, current))
        .unwrap_or_else(|| ("Preparing".to_string(), String::new()));

    let elapsed_ms = started_at.elapsed().as_millis();
    let remaining_ms = if bytes_per_second > 0 && total_bytes > bytes_done {
        Some(((total_bytes - bytes_done) as u128 * 1000) / bytes_per_second as u128)
    } else {
        None
    };

    IngestProgress {
        job_id: String::new(),
        phase,
        current_file,
        files_done,
        total_files,
        bytes_done,
        total_bytes,
        verified_bytes,
        verified_files,
        elapsed_ms,
        bytes_per_second,
        remaining_ms,
        destination_count: destination_count as u32,
        destinations,
    }
}

/// Canonical identity key for a destination, used to collapse entries that point at the
/// SAME root before spawning per-destination copy threads. When the path exists we defer
/// to `std::fs::canonicalize` (resolves `.`/`..`, symlinks, trailing separators, and — on
/// case-insensitive Windows volumes — case differences). When it doesn't exist yet we fall
/// back to a normalized string (trailing separators stripped, lower-cased on Windows).
fn canonical_destination_key(path: &str) -> String {
    let key = std::fs::canonicalize(path)
        .ok()
        .map(|resolved| resolved.to_string_lossy().to_string())
        .unwrap_or_else(|| {
            path.trim_end_matches(['/', '\\']).to_string()
        });
    if cfg!(windows) {
        key.to_lowercase()
    } else {
        key
    }
}

/// Short display label for a destination path (drive/volume/folder name). Best-effort:
/// the final path component, falling back to the whole path (e.g. a bare drive root).
fn destination_label(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| path.to_string())
}

/// Best-effort free bytes available on the volume backing `path`. Windows-first (mirrors
/// `commands::system`); returns None on other platforms or on any query failure.
#[cfg(windows)]
fn free_space_bytes(path: &str) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let target = Path::new(path);
    // A not-yet-created destination folder: query the nearest existing ancestor volume.
    let query = target
        .ancestors()
        .find(|ancestor| ancestor.exists())
        .unwrap_or(target);
    let mut wide: Vec<u16> = query
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut available_bytes = 0_u64;
    let mut total_bytes = 0_u64;
    let mut total_free_bytes = 0_u64;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_mut_ptr(),
            &mut available_bytes,
            &mut total_bytes,
            &mut total_free_bytes,
        )
    };
    if ok == 0 {
        None
    } else {
        Some(available_bytes)
    }
}

#[cfg(not(windows))]
fn free_space_bytes(_path: &str) -> Option<u64> {
    None
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
            // Single-destination path: no per-destination breakdown. The multi path
            // fills these in `aggregate_multi_progress`.
            destination_count: 0,
            destinations: Vec::new(),
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
    preserve_structure: bool,
    camera_override: Option<&str>,
    cancel_flag: Option<&AtomicBool>,
    result: &mut IngestResult,
    mut transfer_progress: Option<&mut dyn FnMut(&str, u64)>,
) -> Result<CopiedRoute, String> {
    check_cancelled(cancel_flag)?;
    // Structure-preserving copy (DIT passthrough): the file lands under the destination
    // folder at the SAME relative parent it had on the source card, so
    // `DCIM/100EOS/IMG_0001.CR3` becomes `<dest>/DCIM/100EOS/IMG_0001.CR3` and card
    // structure (RED .RDM/.RDC, Sony XDROOT, two same-named DCIM folders) is kept intact.
    // The DEFAULT path (`preserve_structure == false`) is unchanged: every routed file is
    // flattened straight into `folder.path`.
    let dest_dir = if preserve_structure {
        structure_preserving_dir(&folder.path, &file.relative_path)
    } else {
        folder.path.clone()
    };
    fs::create_dir_all(&dest_dir)
        .map_err(|error| format!("{}: {error}", dest_dir.display()))?;

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
                    camera: Some(
                        camera_override
                            .map(|alias| alias.to_string())
                            .filter(|alias| !alias.trim().is_empty())
                            .unwrap_or_else(|| camera_hint(file)),
                    ),
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

    // Resilient re-ingest: if this exact destination file already exists and verifies
    // bit-identical to the source, skip the copy (no duplicate) and record it as done.
    // This makes a re-run after an interruption pick up only the remaining files.
    let intended_path = dest_dir.join(&target_name);
    if intended_path.exists() {
        if let Ok(existing) = verify_copy(Path::new(&file.path), &intended_path) {
            if existing.verified {
                result.files_copied += 1;
                result.verified_files += 1;
                result.bytes_copied += file.size_bytes;
                let output_stem = intended_path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or(&file.stem)
                    .to_string();
                result.copied_files.push(CopiedFile {
                    source_path: file.path.clone(),
                    destination_path: intended_path.to_string_lossy().to_string(),
                    kind: file.kind,
                    size_bytes: file.size_bytes,
                    thumbnail_path: None,
                    source_hash: existing.source_hash,
                    destination_hash: existing.destination_hash,
                    verified: true,
                    duration_ms: if matches!(file.kind, ScanFileKind::Footage | ScanFileKind::Audio) {
                        probe_duration_ms(&intended_path)
                    } else {
                        None
                    },
                    thumbnail_kind: ThumbnailKind::None,
                });
                return Ok(CopiedRoute {
                    folder: folder.clone(),
                    output_stem,
                });
            }
        }
    }

    // In structure-preserving mode the relative path is the file's identity, so a file
    // already sitting at the intended path that did NOT verify identical above is a real
    // collision — something is wrong (two different files claiming one card path). Hard-error
    // instead of the flatten path's silent `_2` rename, which would mask it. The default
    // (flatten) path keeps `unique_destination_path`'s uniquification unchanged.
    let destination_path = if preserve_structure {
        if intended_path.exists() {
            return Err(format!(
                "Structure-preserving copy collision: {} already exists and does not match the source.",
                intended_path.display()
            ));
        }
        intended_path.clone()
    } else {
        unique_destination_path(&dest_dir, &target_name)
    };
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
        thumbnail_kind: ThumbnailKind::None,
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
        thumbnail_kind: ThumbnailKind::None,
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

/// Structure-preserving destination directory for a file, GUARANTEED to stay inside
/// `base`. Only `Component::Normal` segments of the file's relative parent are kept — a
/// drive prefix, root (`/` or `\`), `..`, or `.` is dropped. This contains a malformed
/// `relative_path`: the scanner normally yields a clean relative path, but its
/// `strip_prefix(root).unwrap_or(path)` fallback (e.g. a `\\?\` extended-length root vs a
/// plain child, or a casing/canonicalization divergence) can yield an ABSOLUTE path — and
/// on Windows `base.join(<absolute>)` discards `base` and would write outside the chosen
/// destination. Filtering to Normal components makes that escape impossible.
fn structure_preserving_dir(base: &Path, relative_path: &str) -> PathBuf {
    let mut dir = base.to_path_buf();
    if let Some(parent) = Path::new(relative_path).parent() {
        for component in parent.components() {
            if let std::path::Component::Normal(segment) = component {
                dir.push(segment);
            }
        }
    }
    dir
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

/// The one directory, under a destination root, that report assets are written into.
///
/// Owned by this module because this module is what creates it. `lib.rs` grants the asset
/// scope against this same constant, so the directory the webview may read can never drift
/// from the directory the writer actually uses.
pub const REPORT_ASSET_DIR: &str = "IngestPilot_Report_Assets";

pub fn attach_report_thumbnails(
    root_path: &Path,
    copied_files: &mut [CopiedFile],
    source_path: &str,
    config: ThumbnailConfig,
    cancel_flag: Option<&AtomicBool>,
    mut progress: Option<&mut dyn FnMut(IngestProgress)>,
) -> Result<(), String> {
    let config = config.sanitized();
    // Honor the `include_thumbnails` report setting: skip all extraction and leave
    // every file `ThumbnailKind::None`.
    if !config.include {
        return Ok(());
    }

    let started_at = std::time::Instant::now();
    let total = copied_files
        .iter()
        .filter(|file| is_report_thumbnail_progress_candidate(file.kind))
        .count();
    let asset_dir = root_path.join(REPORT_ASSET_DIR).join("thumbs");
    let thumbnail_source_files = report_thumbnail_sources(source_path);
    let thumbnail_sources = thumbnail_source_files.iter().collect::<Vec<_>>();

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

    // `max_emitted` guards the multi-sender channel in pass 2 from delivering `done`
    // values out of order: we never emit a files_done that would move the bar backward.
    let mut max_emitted = 0_usize;

    // ---- Pass 1: cheap tiers, SERIAL, in copied_files order -------------------------
    // Browser-image passthrough + companion-sidecar match/reserve/copy. Running this
    // single-threaded makes the loose "first unused source" fallback in
    // `matching_thumbnail_source` deterministic (independent of worker scheduling) and
    // lets pass 2 stay completely lock-free (no shared dedup set).
    let mut used_thumbnail_sources = BTreeSet::<String>::new();
    let mut done = 0_usize;
    for file in copied_files.iter_mut() {
        if check_cancelled(cancel_flag).is_err() {
            return Ok(());
        }
        let is_candidate = is_report_thumbnail_progress_candidate(file.kind);
        // Contain any panic so one bad file can never unwind the batch (which would deny
        // the user their HTML report). Thumbnails are strictly best-effort.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = attach_cheap_thumbnail_tier(
                root_path,
                &asset_dir,
                &thumbnail_sources,
                &mut used_thumbnail_sources,
                file,
            );
        }));
        // A candidate resolved here is done; pass 2 skips it, so count it now. Candidates
        // left unresolved are counted by pass 2.
        if is_candidate && file.thumbnail_path.is_some() {
            done += 1;
            if done > max_emitted {
                max_emitted = done;
                emit_progress(
                    &mut progress,
                    "Generating report thumbnails",
                    &file.destination_path,
                    done,
                    total,
                    done as u64,
                    total as u64,
                    done as u64,
                    done,
                    started_at,
                );
            }
        }
    }

    // ---- Pass 2: expensive generator tiers, PARALLEL (lock-free) --------------------
    // rawler/exiftool/ffmpeg/placeholder for every file still lacking a thumbnail. These
    // touch no shared state. Extraction shells out to exiftool/ffmpeg and reads the card,
    // so a *bounded* pool keeps subprocess/disk pressure in check. Workers push one tick
    // per finished media file down a channel; the main thread drains it and re-emits the
    // unchanged `report-progress` event so the UI is unaffected.
    let done_counter = AtomicUsize::new(done);
    let threads = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(4)
        .clamp(4, 8);

    match rayon::ThreadPoolBuilder::new().num_threads(threads).build() {
        Ok(pool) => {
            std::thread::scope(|scope| -> Result<(), String> {
                let (tx, rx) = std::sync::mpsc::channel::<(String, usize)>();
                let asset_dir = &asset_dir;
                let counter = &done_counter;
                let config = &config;
                let files: &mut [CopiedFile] = copied_files;
                let worker = scope.spawn(move || {
                    pool.install(|| {
                        files.par_iter_mut().for_each_with(tx, |tx, file| {
                            if check_cancelled(cancel_flag).is_err() {
                                return;
                            }
                            let is_candidate =
                                is_report_thumbnail_progress_candidate(file.kind);
                            let was_unresolved = file.thumbnail_path.is_none();
                            // Contain panics from the image/rawler decode+encode chain so
                            // one bad file can never abort the parallel batch.
                            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                                || {
                                    let _ = attach_generator_thumbnail_tier(
                                        root_path,
                                        asset_dir,
                                        file,
                                        config,
                                        cancel_flag,
                                    );
                                },
                            ));
                            // Count only candidates this pass owns (entered without a
                            // thumbnail); the cheap pass already counted the rest.
                            if is_candidate && was_unresolved {
                                let done = counter.fetch_add(1, Ordering::Relaxed) + 1;
                                let _ = tx.send((file.destination_path.clone(), done));
                            }
                        });
                    });
                });
                for (current_file, done) in rx {
                    if done > max_emitted {
                        max_emitted = done;
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
                    }
                }
                worker
                    .join()
                    .map_err(|_| "Report thumbnail worker panicked.".to_string())
            })?;
        }
        Err(_) => {
            // Pool construction failed (rare) — fall back to a serial generator pass.
            for file in copied_files.iter_mut() {
                if check_cancelled(cancel_flag).is_err() {
                    break;
                }
                let is_candidate = is_report_thumbnail_progress_candidate(file.kind);
                let was_unresolved = file.thumbnail_path.is_none();
                let current_file = file.destination_path.clone();
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let _ = attach_generator_thumbnail_tier(
                        root_path,
                        &asset_dir,
                        file,
                        &config,
                        cancel_flag,
                    );
                }));
                if is_candidate && was_unresolved {
                    let done = done_counter.fetch_add(1, Ordering::Relaxed) + 1;
                    if done > max_emitted {
                        max_emitted = done;
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
                    }
                }
            }
        }
    }

    // Always finish on a complete tick so the bar reads 100% even if the last channel
    // message arrived out of order (or was skipped by the max_emitted guard).
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

fn source_stem_lower(file: &CopiedFile) -> String {
    Path::new(&file.source_path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase()
}

/// Pass-1 tiers (SERIAL, deterministic): browser-image passthrough + companion sidecar.
/// `used_thumbnail_sources` is a plain set because this only runs single-threaded, which
/// also makes the loose fallback in `matching_thumbnail_source` stable run-to-run.
fn attach_cheap_thumbnail_tier(
    root_path: &Path,
    asset_dir: &Path,
    thumbnail_sources: &[&ScannedFile],
    used_thumbnail_sources: &mut BTreeSet<String>,
    file: &mut CopiedFile,
) -> Result<(), String> {
    // Idempotent: if an earlier pass (e.g. the HTML report before the PDF proof)
    // already resolved a thumbnail for this file, keep it.
    if file.thumbnail_path.is_some() {
        return Ok(());
    }
    let destination_path = PathBuf::from(&file.destination_path);
    // In a merged multi-destination report this runs once per root, but copied_files
    // span every destination. Only thumbnail the copies that live under this root —
    // copies on other destinations are handled when their own root is processed, and
    // the grouped renderer reuses whichever copy in the clip group got a thumbnail.
    if !destination_path.starts_with(root_path) {
        return Ok(());
    }
    // NOTE: browser-native images used to be resolved here, in this serial pass, by pointing
    // `thumbnail_path` straight at the copied media file. That was wrong twice over — it put
    // the only un-scoped path in the whole system into the report (see the Tier 1 note in
    // `generate_thumbnail_for_media`), and it decoded nothing, so a 500-photo card's report
    // loaded 500 full-res stills to draw 116px tiles. It now runs as Tier 1 of the shared
    // ladder in the PARALLEL pass, which is also where a 24MP decode belongs.

    // The companion sidecar tier (and the generator tiers) only make sense for visual media;
    // leave documents/audio/unknown untouched (and don't let them consume companion
    // thumbnails via the loose fallback matcher).
    if !matches!(file.kind, ScanFileKind::Footage | ScanFileKind::Photo) {
        return Ok(());
    }

    // Tier 2 — companion sidecar thumbnail (a THMBNL/PRVW-folder image next to the clip).
    if let Some(source) =
        matching_thumbnail_source(file, thumbnail_sources, used_thumbnail_sources)
    {
        let source_path = source.path.clone();
        used_thumbnail_sources.insert(source_path.clone());
        fs::create_dir_all(asset_dir)
            .map_err(|error| format!("{}: {error}", asset_dir.display()))?;
        let thumbnail_source_path = PathBuf::from(&source_path);
        let thumbnail_extension = thumbnail_source_path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_lowercase())
            .unwrap_or_else(|| "jpg".to_string());
        let thumbnail_target = asset_dir.join(content_addressed_asset_name(
            &source_stem_lower(file),
            &file.source_hash,
            &thumbnail_extension,
        ));
        fs::copy(&thumbnail_source_path, &thumbnail_target).map_err(|error| {
            format!(
                "{} -> {}: {error}",
                thumbnail_source_path.display(),
                thumbnail_target.display()
            )
        })?;
        file.thumbnail_path = Some(relative_to_root(root_path, &thumbnail_target)?);
        file.thumbnail_kind = ThumbnailKind::Sidecar;
    }
    Ok(())
}

/// The generator ladder, over a plain `&Path` — the single source of truth for tiers 3–6.
///
/// Deliberately free of `CopiedFile`: the post-copy report path runs it against the
/// *destination* file keyed by a real content hash, and the source-browser path
/// (`ingest::source_thumbs`) runs it against a file still on the *card* keyed by a synthetic
/// path+size+mtime key. Both must route extensions identically — an .ARW that resolves in the
/// report but not the selector is exactly the class of drift this factoring exists to prevent.
///
/// Returns the generated path (when a tier produced one) plus the `ThumbnailKind` to record.
/// The kind is meaningful even when the path is `None`: `Placeholder` tells the renderer to
/// draw an intentional per-format card rather than a blank box.
pub(crate) fn generate_thumbnail_for_media(
    media_path: &Path,
    kind: ScanFileKind,
    asset_dir: &Path,
    source_stem: &str,
    source_hash: &str,
    config: &ThumbnailConfig,
) -> (Option<PathBuf>, ThumbnailKind) {
    let extension = media_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_lowercase()))
        .unwrap_or_default();

    // Tier 1 — browser-native image. The webview could decode this file as-is, but we still
    // re-encode a downscaled copy into `asset_dir` rather than pointing at the original:
    //
    //   * SCOPE. `asset_dir` is the only place the asset protocol is ever granted. Pointing
    //     `thumbnail_path` at the media itself produced a URL the webview refuses to load, so
    //     every still on a DCIM card rendered as a grey placeholder — the most common card
    //     there is. The fix is NOT to grant the media directory: that would hand the webview
    //     the user's footage and defeat the whole model. The fix is to make this tier behave
    //     like every other tier and write where they write.
    //   * WEIGHT. The HTML report draws 116px tiles. A 500-photo card was making it load 500
    //     full-res 24MP JPEGs to do that.
    //
    // Kind stays `Embedded`: the pixels are the file's own, which is what that label means.
    if is_browser_image_extension(&extension) {
        let target = asset_dir.join(content_addressed_asset_name(source_stem, source_hash, "jpg"));
        // Checked before the read so the second pass (HTML report → PDF proof) doesn't pull
        // the whole still off disk again just to rediscover it already has the thumbnail.
        if target.is_file() {
            return (Some(target), ThumbnailKind::Embedded);
        }
        // Orientation is baked into the pixels here for the same reason as every other tier:
        // the re-encode drops the EXIF block, so nothing downstream would ever rotate it.
        let orientation = exif_orientation(media_path);
        if let Some(generated) = fs::read(media_path).ok().and_then(|bytes| {
            write_downscaled_jpeg_from_bytes(
                &bytes,
                asset_dir,
                source_stem,
                source_hash,
                config,
                orientation,
            )
        }) {
            return (Some(generated), ThumbnailKind::Embedded);
        }
        // A truncated/corrupt image: no tier below can help with a .jpg either.
        return (None, ThumbnailKind::Placeholder);
    }

    // Tier 3 — stills-RAW embedded preview (pure Rust, cross-platform). The key fix for
    // Sony A7IV .ARW and other camera raws. On failure we drop straight to the
    // placeholder — ffmpeg can't help with raw stills.
    if is_stills_raw_extension(&extension) {
        return match generate_raw_embedded_thumbnail(
            media_path,
            asset_dir,
            source_stem,
            source_hash,
            config,
        ) {
            Some(generated) => (Some(generated), ThumbnailKind::Embedded),
            None => (None, ThumbnailKind::Placeholder),
        };
    }

    // Tier 4 — cinema-RAW (RED .R3D, Blackmagic .BRAW, …) via exiftool's embedded
    // preview. Stock ffmpeg can't demux these, so we skip it entirely.
    if is_cinema_raw_extension(&extension) {
        return match generate_exiftool_thumbnail(
            media_path,
            asset_dir,
            source_stem,
            source_hash,
            config,
        ) {
            Some(generated) => (Some(generated), ThumbnailKind::Embedded),
            None => (None, ThumbnailKind::Placeholder),
        };
    }

    // Tier 5 — standard video poster frame via ffmpeg.
    if matches!(kind, ScanFileKind::Footage) {
        if let Some(generated) =
            generate_ffmpeg_thumbnail(media_path, asset_dir, source_stem, source_hash, config)
        {
            return (Some(generated), ThumbnailKind::Ffmpeg);
        }
    }

    // Tier 6 — nothing worked (e.g. a .heic/.tif still, an exotic codec, or missing
    // ffmpeg/exiftool).
    (None, ThumbnailKind::Placeholder)
}

/// Pass-2 tiers (PARALLEL, lock-free): a thin `CopiedFile` dispatcher over
/// [`generate_thumbnail_for_media`]. Only does work for files still lacking a thumbnail;
/// touches no shared state, so it is safe to run concurrently across `copied_files`.
fn attach_generator_thumbnail_tier(
    root_path: &Path,
    asset_dir: &Path,
    file: &mut CopiedFile,
    config: &ThumbnailConfig,
    cancel_flag: Option<&AtomicBool>,
) -> Result<(), String> {
    check_cancelled(cancel_flag)?;
    // Skip files already resolved by pass 1 (browser/sidecar) or a prior report pass.
    if file.thumbnail_path.is_some() {
        return Ok(());
    }
    let destination_path = PathBuf::from(&file.destination_path);
    if !destination_path.starts_with(root_path) {
        return Ok(());
    }
    if !matches!(file.kind, ScanFileKind::Footage | ScanFileKind::Photo) {
        return Ok(());
    }

    let (generated, kind) = generate_thumbnail_for_media(
        &destination_path,
        file.kind,
        asset_dir,
        &source_stem_lower(file),
        &file.source_hash,
        config,
    );
    if let Some(generated) = generated {
        // Report thumbnails are referenced relative to their ingest root so the written
        // HTML stays portable; the source-browser caller keeps the absolute path instead.
        file.thumbnail_path = Some(relative_to_root(root_path, &generated)?);
    }
    file.thumbnail_kind = kind;
    Ok(())
}

fn generate_ffmpeg_thumbnail(
    video_path: &Path,
    asset_dir: &Path,
    source_stem: &str,
    source_hash: &str,
    config: &ThumbnailConfig,
) -> Option<PathBuf> {
    let ffmpeg = ffmpeg_path()?;
    fs::create_dir_all(asset_dir).ok()?;
    // Content-addressed name (stem + first hash bytes) so parallel workers never race
    // on a shared "next free path", and a re-run reuses the already-generated frame.
    let thumbnail_target = asset_dir.join(format!(
        "{}_{}_ffmpeg.jpg",
        sanitize_asset_name(source_stem),
        short_source_hash(source_hash),
    ));
    if thumbnail_target.exists() {
        return Some(thumbnail_target);
    }
    let scale = format!("scale='min({0},iw)':-2", config.max_edge.max(64));
    for timestamp in ["00:00:02", "00:00:00.5", "00:00:00"] {
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
            .args(["-frames:v", "1", "-vf", &scale, "-qscale:v", "3"])
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

/// First 8 alphanumeric chars of the source hash (or `nohash`), used to
/// content-address generated thumbnail assets.
fn short_source_hash(source_hash: &str) -> String {
    let short: String = source_hash
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(8)
        .collect();
    if short.is_empty() {
        "nohash".to_string()
    } else {
        short
    }
}

/// `<sanitized-stem>_<hash8>.<ext>` — deterministic per (file, content) so the
/// attach loop is race-free under parallelism and idempotent across report/PDF passes.
pub(crate) fn content_addressed_asset_name(stem: &str, source_hash: &str, extension: &str) -> String {
    format!(
        "{}_{}.{}",
        sanitize_asset_name(stem),
        short_source_hash(source_hash),
        extension
    )
}

fn is_stills_raw_extension(extension: &str) -> bool {
    matches!(
        extension,
        ".arw" | ".dng" | ".cr2" | ".cr3" | ".nef" | ".rw2" | ".orf" | ".raw"
    )
}

fn is_cinema_raw_extension(extension: &str) -> bool {
    matches!(extension, ".r3d" | ".braw" | ".crm" | ".cine")
}

/// Read the EXIF `Orientation` tag (1–8) from a file's primary IFD.
///
/// Returns `None` when the file has no readable EXIF, no orientation tag, or an
/// out-of-range value — every caller treats `None` as orientation 1 (no transform),
/// so an unreadable sidecar can never rotate a thumbnail the wrong way.
pub(crate) fn exif_orientation(path: &Path) -> Option<u16> {
    let file = fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(&file);
    let exif = exif::Reader::new().read_from_container(&mut reader).ok()?;
    exif_orientation_value(&exif)
}

/// Same as [`exif_orientation`], but for an in-memory image (e.g. the JPEG exiftool
/// hands back on stdout, which usually carries its own EXIF block).
fn exif_orientation_from_bytes(bytes: &[u8]) -> Option<u16> {
    let mut cursor = std::io::Cursor::new(bytes);
    let exif = exif::Reader::new().read_from_container(&mut cursor).ok()?;
    exif_orientation_value(&exif)
}

fn exif_orientation_value(exif: &exif::Exif) -> Option<u16> {
    let value = exif
        .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|field| field.value.get_uint(0))?;
    // Only 1–8 are meaningful; anything else is corrupt and means "leave it alone".
    (1..=8).contains(&value).then_some(value as u16)
}

/// Bake an EXIF orientation into the pixels so the image reads upright without the tag.
///
/// We must do this because the thumbnail writer re-encodes a bare JPEG and drops the
/// original EXIF block — nothing downstream would ever rotate the image otherwise.
/// `None` (and the no-op value 1) pass the image through untouched.
fn apply_exif_orientation(
    image: image::DynamicImage,
    orientation: Option<u16>,
) -> image::DynamicImage {
    match orientation.unwrap_or(1) {
        2 => image.fliph(),
        3 => image.rotate180(),
        4 => image.flipv(),
        5 => image.rotate90().fliph(),
        6 => image.rotate90(),
        7 => image.rotate270().fliph(),
        8 => image.rotate270(),
        // 1, plus any value we rejected above: already upright.
        _ => image,
    }
}

/// Decode arbitrary already-embedded JPEG/PNG bytes, bake in `orientation`, and
/// re-encode a downscaled JPEG thumbnail into the asset dir. Returns the written path.
///
/// Orientation is applied here — before the downscale in
/// `write_downscaled_jpeg_from_dynamic` — so the fit-to-box happens against the
/// upright aspect ratio.
pub(crate) fn write_downscaled_jpeg_from_bytes(
    bytes: &[u8],
    asset_dir: &Path,
    source_stem: &str,
    source_hash: &str,
    config: &ThumbnailConfig,
    orientation: Option<u16>,
) -> Option<PathBuf> {
    let image = image::load_from_memory(bytes).ok()?;
    let image = apply_exif_orientation(image, orientation);
    write_downscaled_jpeg_from_dynamic(image, asset_dir, source_stem, source_hash, config)
}

/// Downscale a decoded image to `config.max_edge` (long edge) and write it as a
/// quality-`config.jpeg_quality` JPEG into the asset dir. Content-addressed name.
fn write_downscaled_jpeg_from_dynamic(
    image: image::DynamicImage,
    asset_dir: &Path,
    source_stem: &str,
    source_hash: &str,
    config: &ThumbnailConfig,
) -> Option<PathBuf> {
    use image::GenericImageView;

    fs::create_dir_all(asset_dir).ok()?;
    let target = asset_dir.join(content_addressed_asset_name(source_stem, source_hash, "jpg"));
    if target.exists() {
        return Some(target);
    }
    let max = config.max_edge.max(64);
    let (width, height) = image.dimensions();
    let resized = if width > max || height > max {
        // `thumbnail` fits within a max×max box preserving aspect ratio (fast filter).
        image.thumbnail(max, max)
    } else {
        image
    };
    let rgb = resized.to_rgb8();
    let (rgb_width, rgb_height) = (rgb.width(), rgb.height());
    let mut buffer = Vec::new();
    {
        let mut encoder =
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, config.jpeg_quality);
        encoder
            .encode(
                rgb.as_raw(),
                rgb_width,
                rgb_height,
                image::ExtendedColorType::Rgb8,
            )
            .ok()?;
    }
    // Encode fully into memory then write once, so a failure can't leave a truncated
    // JPEG that a later idempotent pass would treat as a valid cached thumbnail.
    let temp = target.with_extension("jpg.part");
    fs::write(&temp, &buffer).ok()?;
    if fs::rename(&temp, &target).is_err() {
        let _ = fs::remove_file(&temp);
        return None;
    }
    Some(target)
}

/// Stills-RAW (.arw/.dng/.cr2/…): extract the embedded JPEG preview with `rawler`
/// (pure Rust — no bundled binaries, works on every platform) and downscale it. We
/// deliberately do NOT full-demosaic; the embedded preview is what shooters expect.
fn generate_raw_embedded_thumbnail(
    raw_path: &Path,
    asset_dir: &Path,
    source_stem: &str,
    source_hash: &str,
    config: &ThumbnailConfig,
) -> Option<PathBuf> {
    let target = asset_dir.join(content_addressed_asset_name(source_stem, source_hash, "jpg"));
    if target.exists() {
        return Some(target);
    }
    let preview = extract_raw_preview_image(raw_path)?;
    // Cameras store the embedded preview in SENSOR orientation and record the rotation
    // in the EXIF `Orientation` tag; re-encoding below drops that tag, so bake it into
    // the pixels here. This covers BOTH `extract_raw_preview_image` paths (rawler and
    // the kamadak THUMBNAIL-IFD fallback) — neither returns a pre-rotated image, so
    // there is no double-rotation. Applied BEFORE the downscale so `thumbnail(max, max)`
    // fits against the upright aspect ratio and a portrait frame stays portrait rather
    // than being letterboxed into a landscape box.
    let preview = apply_exif_orientation(preview, exif_orientation(raw_path));
    write_downscaled_jpeg_from_dynamic(preview, asset_dir, source_stem, source_hash, config)
}

fn extract_raw_preview_image(raw_path: &Path) -> Option<image::DynamicImage> {
    if let Some(preview) = rawler_preview_image(raw_path) {
        return Some(preview);
    }
    // Fallback: slice the embedded thumbnail IFD out of the TIFF-based raw ourselves.
    kamadak_embedded_thumbnail(raw_path)
}

/// Ask rawler for the embedded preview (falling back to its smaller thumbnail).
/// Wrapped in `catch_unwind` because some malformed files can panic inside a decoder,
/// and a panic in a rayon worker would otherwise abort the whole attach loop.
fn rawler_preview_image(raw_path: &Path) -> Option<image::DynamicImage> {
    use rawler::decoders::RawDecodeParams;
    use rawler::rawsource::RawSource;

    let raw_path = raw_path.to_path_buf();
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let source = RawSource::new(&raw_path).ok()?;
        let decoder = rawler::get_decoder(&source).ok()?;
        let params = RawDecodeParams::default();
        if let Ok(Some(image)) = decoder.preview_image(&source, &params) {
            return Some(image);
        }
        if let Ok(Some(image)) = decoder.thumbnail_image(&source, &params) {
            return Some(image);
        }
        None
    }))
    .ok()
    .flatten()
}

/// Best-effort EXIF fallback: read the THUMBNAIL IFD's JPEG offset/length and slice
/// the embedded JPEG straight out of the (TIFF-based) raw file.
fn kamadak_embedded_thumbnail(raw_path: &Path) -> Option<image::DynamicImage> {
    use exif::{In, Reader, Tag};

    let file = fs::File::open(raw_path).ok()?;
    let mut reader = std::io::BufReader::new(&file);
    let exif = Reader::new().read_from_container(&mut reader).ok()?;
    let offset = exif
        .get_field(Tag::JPEGInterchangeFormat, In::THUMBNAIL)
        .and_then(|field| field.value.get_uint(0))? as usize;
    let length = exif
        .get_field(Tag::JPEGInterchangeFormatLength, In::THUMBNAIL)
        .and_then(|field| field.value.get_uint(0))? as usize;
    if length == 0 {
        return None;
    }
    let bytes = fs::read(raw_path).ok()?;
    let end = offset.checked_add(length)?;
    let slice = bytes.get(offset..end)?;
    // Sanity-check the JPEG SOI marker before handing it to the decoder.
    if slice.first() != Some(&0xFF) || slice.get(1) != Some(&0xD8) {
        return None;
    }
    image::load_from_memory(slice).ok()
}

/// Cinema-RAW (.r3d/.braw/.crm/.cine): shell out to exiftool for the embedded preview.
/// If exiftool isn't bundled/on PATH this returns None and the caller falls through to
/// the placeholder tier (never an error).
fn generate_exiftool_thumbnail(
    raw_path: &Path,
    asset_dir: &Path,
    source_stem: &str,
    source_hash: &str,
    config: &ThumbnailConfig,
) -> Option<PathBuf> {
    let target = asset_dir.join(content_addressed_asset_name(source_stem, source_hash, "jpg"));
    if target.exists() {
        return Some(target);
    }
    let exiftool = exiftool_path()?;
    fs::create_dir_all(asset_dir).ok()?;
    for tag in ["-PreviewImage", "-JpgFromRaw", "-ThumbnailImage"] {
        let mut command = Command::new(&exiftool);
        hide_subprocess_window(&mut command);
        let output = match command.args(["-b", tag]).arg(raw_path).output() {
            Ok(output) => output,
            Err(_) => return None,
        };
        if output.status.success() && !output.stdout.is_empty() {
            // The extracted preview often carries its own EXIF block. That tag describes
            // the preview we actually decoded, so it wins; only when the payload is a
            // bare JPEG do we fall back to the container's orientation.
            let orientation =
                exif_orientation_from_bytes(&output.stdout).or_else(|| exif_orientation(raw_path));
            if let Some(path) = write_downscaled_jpeg_from_bytes(
                &output.stdout,
                asset_dir,
                source_stem,
                source_hash,
                config,
                orientation,
            ) {
                return Some(path);
            }
        }
    }
    None
}

/// Discover exiftool, mirroring `ffmpeg_path()`: `INGEST_PILOT_EXIFTOOL` env → the
/// bundled resource dir → PATH. Returns None (not an error) when not found.
fn exiftool_path() -> Option<PathBuf> {
    if let Ok(path) = env::var("INGEST_PILOT_EXIFTOOL") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }

    for root in ffmpeg_search_roots() {
        for candidate in [
            root.join("exiftool.exe"),
            root.join("exiftool"),
            root.join("resources")
                .join("tools")
                .join("exiftool")
                .join("exiftool.exe"),
            root.join("resources")
                .join("tools")
                .join("exiftool")
                .join("exiftool"),
            root.join("resources").join("exiftool.exe"),
            root.join("resources").join("exiftool"),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    if exiftool_is_available("exiftool") {
        Some(PathBuf::from("exiftool"))
    } else {
        None
    }
}

fn exiftool_is_available(command: &str) -> bool {
    let mut command = Command::new(command);
    hide_subprocess_window(&mut command);
    command
        .arg("-ver")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
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

/// Camera label derived from a source file path (used by the reel index, which
/// only has the path, not the scanned-file record).
pub fn camera_label_for_path(source_path: &str) -> String {
    let path = Path::new(source_path);
    if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
        if let Some(prefix) = camera_prefix_from_stem(stem) {
            return prefix;
        }
    }
    path.ancestors()
        .skip(1)
        .filter_map(|ancestor| ancestor.file_name().and_then(|value| value.to_str()))
        .find(|value| !is_generic_camera_folder(value) && !value.trim().is_empty())
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

    /// A 4×2 landscape image with a red marker top-left and a green one top-right, so
    /// every transform below is distinguishable from every other (a symmetric image
    /// could not tell a flip from a rotation).
    fn orientation_test_image() -> image::DynamicImage {
        let mut buffer = image::RgbImage::from_pixel(4, 2, image::Rgb([0, 0, 0]));
        buffer.put_pixel(0, 0, image::Rgb([255, 0, 0]));
        buffer.put_pixel(3, 0, image::Rgb([0, 255, 0]));
        image::DynamicImage::ImageRgb8(buffer)
    }

    #[test]
    fn rotates_portrait_preview_for_exif_orientation_six() {
        use image::GenericImageView;

        // 6 is what a camera writes for a portrait frame shot on a landscape sensor —
        // the exact case behind the "portrait .ARW renders landscape" bug.
        let rotated = apply_exif_orientation(orientation_test_image(), Some(6));

        // The landscape 4×2 sensor preview must come out portrait 2×4.
        assert_eq!(rotated.dimensions(), (2, 4));
        // Rotating clockwise sends (x, y) -> (height - 1 - y, x): the top-left red
        // marker lands top-right, and the top-right green marker lands bottom-right.
        assert_eq!(rotated.get_pixel(1, 0).0, [255, 0, 0, 255]);
        assert_eq!(rotated.get_pixel(1, 3).0, [0, 255, 0, 255]);
    }

    #[test]
    fn leaves_image_untouched_for_orientation_one_or_none() {
        use image::GenericImageView;

        let original = orientation_test_image();
        // `None` is the "no readable EXIF" path and must behave exactly like 1.
        for orientation in [None, Some(1)] {
            let result = apply_exif_orientation(original.clone(), orientation);
            assert_eq!(result.dimensions(), (4, 2));
            assert_eq!(result.as_bytes(), original.as_bytes());
        }
    }

    #[test]
    fn maps_each_exif_orientation_to_its_transform() {
        use image::GenericImageView;

        // (tag, expected dimensions, where the top-left red marker must land)
        let cases = [
            (1, (4, 2), (0, 0)), // identity
            (2, (4, 2), (3, 0)), // horizontal flip
            (3, (4, 2), (3, 1)), // 180
            (4, (4, 2), (0, 1)), // vertical flip
            (5, (2, 4), (0, 0)), // transpose  (rotate90 + fliph)
            (6, (2, 4), (1, 0)), // rotate 90 CW
            (7, (2, 4), (1, 3)), // transverse (rotate270 + fliph)
            (8, (2, 4), (0, 3)), // rotate 270 CW
        ];

        for (tag, dimensions, (red_x, red_y)) in cases {
            let result = apply_exif_orientation(orientation_test_image(), Some(tag));
            assert_eq!(result.dimensions(), dimensions, "dimensions for tag {tag}");
            assert_eq!(
                result.get_pixel(red_x, red_y).0,
                [255, 0, 0, 255],
                "red marker position for tag {tag}"
            );
        }

        // Only 5–8 transpose the frame; a portrait result must never come from 1–4.
        for tag in [1, 2, 3, 4] {
            let result = apply_exif_orientation(orientation_test_image(), Some(tag));
            assert_eq!(result.dimensions(), (4, 2), "tag {tag} must not transpose");
        }
    }

    #[test]
    fn treats_out_of_range_orientation_as_no_op() {
        use image::GenericImageView;

        // Corrupt tags must degrade to "leave it alone", never to a wrong rotation.
        for orientation in [Some(0), Some(9), Some(65535)] {
            let result = apply_exif_orientation(orientation_test_image(), orientation);
            assert_eq!(result.dimensions(), (4, 2));
            assert_eq!(result.get_pixel(0, 0).0, [255, 0, 0, 255]);
        }
    }

    #[test]
    fn reads_no_orientation_from_missing_or_non_exif_files() {
        let workspace = unique_temp_dir("ingest_pilot_orientation_test");
        fs::create_dir_all(&workspace).expect("workspace");

        // Absent file, and a file that is not an image at all: both must be None so the
        // caller falls back to "no transform" instead of failing the thumbnail.
        assert_eq!(exif_orientation(&workspace.join("nope.arw")), None);
        let junk = workspace.join("junk.arw");
        fs::write(&junk, b"not an image").expect("junk file");
        assert_eq!(exif_orientation(&junk), None);
        assert_eq!(exif_orientation_from_bytes(b"not an image"), None);

        fs::remove_dir_all(&workspace).ok();
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
                metadata_preset_id: None,
            }],
            file_rename_pattern: "{original_name}_{clip#}{ext}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: destination.to_string_lossy().to_string(),
                secondaries: vec![],
                sub_path_pattern: String::new(),
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            metadata_preset_id: None,
            metadata_values: BTreeMap::new(),
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
                sub_path_pattern: String::new(),
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            metadata_preset_id: None,
            metadata_values: BTreeMap::new(),
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

    /// Minimal empty-tree preset used by the DIT passthrough tests: no scaffolding, no
    /// rename pattern that changes names, copied straight into an existing root.
    fn passthrough_test_preset(destination: &Path) -> Preset {
        Preset {
            schema_version: 1,
            id: "__dit_passthrough_test__".to_string(),
            name: "Passthrough".to_string(),
            description: None,
            icon: None,
            color: None,
            variables: vec![],
            root_folder_pattern: String::new(),
            folder_tree: vec![],
            file_rename_pattern: "{original_name}{ext}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: destination.to_string_lossy().to_string(),
                secondaries: vec![],
                sub_path_pattern: String::new(),
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: false,
            metadata_preset_id: None,
            metadata_values: BTreeMap::new(),
            created_at: "2026-04-24T00:00:00Z".to_string(),
            updated_at: "2026-04-24T00:00:00Z".to_string(),
        }
    }

    /// Containment guard: a malformed `relative_path` (absolute, drive-prefixed, or with
    /// `..`) must NEVER let the structure-preserving copy escape the destination base.
    #[test]
    fn structure_preserving_dir_stays_inside_base() {
        let base = Path::new("/dest/root");

        // Normal nested path keeps its parent, inside base.
        assert_eq!(
            structure_preserving_dir(base, "DCIM/100EOS/IMG.CR3"),
            base.join("DCIM").join("100EOS")
        );

        // Absolute POSIX path: the leading root is dropped, tail stays inside base.
        let posix_abs = structure_preserving_dir(base, "/evil/x.mp4");
        assert!(posix_abs.starts_with(base), "posix absolute escaped: {posix_abs:?}");

        // Windows drive-absolute path: prefix + root dropped, never a new drive root.
        let win_abs = structure_preserving_dir(base, "C:\\evil\\x.mp4");
        assert!(win_abs.starts_with(base), "windows absolute escaped: {win_abs:?}");

        // Parent traversal: `..` segments are dropped, so it can't climb out of base.
        let up = structure_preserving_dir(base, "../../x.mp4");
        assert!(up.starts_with(base), "parent traversal escaped: {up:?}");
        assert_eq!(up, base.to_path_buf());
    }

    /// (a) With preserve_structure, a nested source path keeps its relative parent under
    /// the destination root: DCIM/100EOS/IMG_0001.CR3 -> <dest>/DCIM/100EOS/IMG_0001.CR3.
    #[test]
    fn preserve_structure_keeps_relative_parent() {
        let workspace = unique_temp_dir("ingest_pilot_preserve_parent");
        let source = workspace.join("source");
        let destination = workspace.join("dest");
        fs::create_dir_all(source.join("DCIM").join("100EOS")).expect("source tree");
        fs::write(source.join("DCIM").join("100EOS").join("IMG_0001.CR3"), vec![1; 32])
            .expect("media");

        let preset = passthrough_test_preset(&destination);
        let result = run_ingest_multi(
            &preset,
            source.to_string_lossy().to_string(),
            BTreeMap::new(),
            vec![destination.to_string_lossy().to_string()],
            true,
            false,
            true, // preserve_structure
            None,
            None,
            true, // use_existing_root
            None,
            None,
            None,
            None,
            None,
        )
        .expect("passthrough succeeds");

        assert_eq!(result.roots.len(), 1);
        assert!(result.failures.is_empty());
        assert!(destination
            .join("DCIM")
            .join("100EOS")
            .join("IMG_0001.CR3")
            .exists());
        assert_eq!(result.roots[0].files_copied, 1);
        assert_eq!(result.roots[0].verified_files, 1);

        let _ = fs::remove_dir_all(workspace);
    }

    /// (b) Two files with the SAME basename in different subfolders both land correctly
    /// under preserve_structure — the old flatten path would have renamed one to `_2`.
    #[test]
    fn preserve_structure_same_basename_different_folders() {
        let workspace = unique_temp_dir("ingest_pilot_preserve_collide");
        let source = workspace.join("source");
        let destination = workspace.join("dest");
        fs::create_dir_all(source.join("DCIM").join("100EOS")).expect("dir a");
        fs::create_dir_all(source.join("DCIM").join("101EOS")).expect("dir b");
        fs::write(source.join("DCIM").join("100EOS").join("IMG_0001.CR3"), vec![1; 16])
            .expect("a");
        fs::write(source.join("DCIM").join("101EOS").join("IMG_0001.CR3"), vec![2; 24])
            .expect("b");

        let preset = passthrough_test_preset(&destination);
        let result = run_ingest_multi(
            &preset,
            source.to_string_lossy().to_string(),
            BTreeMap::new(),
            vec![destination.to_string_lossy().to_string()],
            true,
            false,
            true, // preserve_structure
            None,
            None,
            true,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("passthrough succeeds");

        assert!(result.failures.is_empty());
        let a = destination.join("DCIM").join("100EOS").join("IMG_0001.CR3");
        let b = destination.join("DCIM").join("101EOS").join("IMG_0001.CR3");
        assert!(a.exists(), "first card path must land verbatim");
        assert!(b.exists(), "second card path must land verbatim");
        // No `_2` rename anywhere: both kept their identity.
        assert!(!destination
            .join("DCIM")
            .join("100EOS")
            .join("IMG_0001_2.CR3")
            .exists());
        assert_eq!(fs::read(&a).expect("a bytes").len(), 16);
        assert_eq!(fs::read(&b).expect("b bytes").len(), 24);
        assert_eq!(result.roots[0].files_copied, 2);

        let _ = fs::remove_dir_all(workspace);
    }

    /// (c) The DEFAULT (preserve_structure = false) path still flattens exactly as before:
    /// two same-basename files collapse into the root and the second gets the `_2` suffix.
    #[test]
    fn default_path_still_flattens() {
        let workspace = unique_temp_dir("ingest_pilot_default_flatten");
        let source = workspace.join("source");
        let destination = workspace.join("dest");
        fs::create_dir_all(source.join("DCIM").join("100EOS")).expect("dir a");
        fs::create_dir_all(source.join("DCIM").join("101EOS")).expect("dir b");
        fs::write(source.join("DCIM").join("100EOS").join("IMG_0001.CR3"), vec![1; 16])
            .expect("a");
        fs::write(source.join("DCIM").join("101EOS").join("IMG_0001.CR3"), vec![2; 24])
            .expect("b");

        let preset = passthrough_test_preset(&destination);
        let result = run_ingest_multi(
            &preset,
            source.to_string_lossy().to_string(),
            BTreeMap::new(),
            vec![destination.to_string_lossy().to_string()],
            true,
            false,
            false, // DEFAULT: flatten
            None,
            None,
            true,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("ingest succeeds");

        assert!(result.failures.is_empty());
        // Both land directly in the root; the second is uniquified to `_2`, and no nested
        // DCIM tree is reproduced.
        assert!(destination.join("IMG_0001.CR3").exists());
        assert!(destination.join("IMG_0001_2.CR3").exists());
        assert!(!destination.join("DCIM").exists());
        assert_eq!(result.roots[0].files_copied, 2);

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn re_ingest_skips_already_copied_verified_files() {
        let workspace = unique_temp_dir("ingest_pilot_resume_test");
        let source = workspace.join("source");
        let destination = workspace.join("output");
        fs::create_dir_all(&source).expect("source dir");
        fs::write(source.join("A.MP4"), vec![7; 64]).expect("media");

        let preset = Preset {
            schema_version: 1,
            id: "preset_resume".to_string(),
            name: "Loose".to_string(),
            description: None,
            icon: None,
            color: None,
            variables: vec![],
            root_folder_pattern: "Proj".to_string(),
            folder_tree: vec![],
            file_rename_pattern: "{original_name}{ext}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: destination.to_string_lossy().to_string(),
                secondaries: vec![],
                sub_path_pattern: String::new(),
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            metadata_preset_id: None,
            metadata_values: BTreeMap::new(),
            created_at: "2026-04-24T00:00:00Z".to_string(),
            updated_at: "2026-04-24T00:00:00Z".to_string(),
        };

        let first = run_ingest(
            &preset,
            source.to_string_lossy().to_string(),
            BTreeMap::new(),
            None,
            true,
            true,
            None,
            None,
            false,
            None,
            None,
        )
        .expect("first ingest");
        let root = PathBuf::from(&first.root_path);

        // Re-run into the same existing root: the file already verifies bit-identical,
        // so it is skipped (no duplicate) rather than re-copied with a suffix.
        let second = run_ingest(
            &preset,
            source.to_string_lossy().to_string(),
            BTreeMap::new(),
            Some(first.root_path.clone()),
            true,
            true,
            None,
            None,
            true,
            None,
            None,
        )
        .expect("second ingest");

        assert_eq!(second.files_copied, 1);
        assert_eq!(second.verified_files, 1);
        let a_files = fs::read_dir(&root)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with('A'))
            .count();
        assert_eq!(a_files, 1, "re-ingest should skip the already-copied file, not duplicate it");

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
                    metadata_preset_id: None,
                }],
                template_files: vec![],
                condition: None,
                role: Some(FolderRole::Footage),
                metadata_preset_id: None,
            }],
            file_rename_pattern: "{folder_name}_{clip#}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: destination.to_string_lossy().to_string(),
                secondaries: vec![],
                sub_path_pattern: String::new(),
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            metadata_preset_id: None,
            metadata_values: BTreeMap::new(),
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
                metadata_preset_id: None,
            }],
            file_rename_pattern: "{original_name}{ext}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: destination.to_string_lossy().to_string(),
                secondaries: vec![],
                sub_path_pattern: String::new(),
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            metadata_preset_id: None,
            metadata_values: BTreeMap::new(),
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
            None,
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
                metadata_preset_id: None,
            }],
            file_rename_pattern: "{original_name}{ext}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: String::new(),
                secondaries: vec![],
                sub_path_pattern: String::new(),
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            metadata_preset_id: None,
            metadata_values: BTreeMap::new(),
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

    /// Minimal preset that copies stills into a Photos/ folder — enough to exercise the
    /// thumbnail tiers without dragging in naming/variable machinery.
    fn photo_test_preset(destination: &Path) -> Preset {
        Preset {
            schema_version: 1,
            id: "preset_photo_test".to_string(),
            name: "Stills".to_string(),
            description: None,
            icon: None,
            color: None,
            variables: vec![],
            root_folder_pattern: "Project".to_string(),
            folder_tree: vec![FolderNode {
                id: "folder_photos".to_string(),
                name_pattern: "Photos".to_string(),
                is_footage_destination: false,
                children: vec![],
                template_files: vec![],
                condition: None,
                role: Some(FolderRole::Photos),
                metadata_preset_id: None,
            }],
            file_rename_pattern: "{original_name}{ext}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: destination.to_string_lossy().to_string(),
                secondaries: vec![],
                sub_path_pattern: String::new(),
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: false,
            metadata_preset_id: None,
            metadata_values: BTreeMap::new(),
            created_at: "2026-04-24T00:00:00Z".to_string(),
            updated_at: "2026-04-24T00:00:00Z".to_string(),
        }
    }

    /// Encode a real, decodable JPEG — `image::load_from_memory` has to accept it, so the
    /// byte-stub fixtures the other tests use won't do for the browser-image tier.
    fn write_test_jpeg(path: &Path, width: u32, height: u32) {
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        let pixels = image::RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        image::DynamicImage::ImageRgb8(pixels)
            .save_with_format(path, image::ImageFormat::Jpeg)
            .expect("write jpeg");
    }

    /// REGRESSION — this is the bug that shipped. A card of DCIM JPEGs is the single most
    /// common offload there is, and Tier 1 used to resolve `thumbnail_path` to the copied
    /// MEDIA file. The asset protocol only ever grants `<root>/IngestPilot_Report_Assets`, so
    /// every one of those stills rendered as a grey placeholder in the completion grid while
    /// R3D/ARW/MP4 (which write into the asset dir) worked fine. The written HTML report uses
    /// relative file:// URLs and was unaffected, so checking the report never revealed it.
    ///
    /// The invariant, stated once: EVERY `thumbnail_path` lives under the asset dir. Never the
    /// media, never the card.
    #[test]
    fn browser_image_thumbnail_is_generated_into_the_asset_dir() {
        let workspace = unique_temp_dir("ingest_pilot_browser_image_asset_dir_test");
        let source = workspace.join("source");
        let destination = workspace.join("output");
        // 900px on the long edge, so a 480px-max thumbnail must be a genuinely smaller
        // re-encode rather than a copy of the original.
        write_test_jpeg(&source.join("DCIM").join("100CANON").join("IMG_0001.JPG"), 900, 600);

        let preset = photo_test_preset(&destination);
        let mut result = run_ingest(
            &preset,
            source.to_string_lossy().to_string(),
            BTreeMap::new(),
            None,
            true,
            false,
            None,
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
            ThumbnailConfig::default(),
            None,
            None,
        )
        .expect("thumbnails attach");

        let copied = result
            .copied_files
            .iter()
            .find(|file| file.destination_path.to_lowercase().ends_with(".jpg"))
            .expect("jpg copied");
        let thumbnail_path = copied.thumbnail_path.as_ref().expect("thumbnail path");

        // The load-bearing assertion: inside the granted asset dir.
        assert!(
            thumbnail_path.replace('\\', "/").starts_with(REPORT_ASSET_DIR),
            "thumbnail must live under {REPORT_ASSET_DIR}, got {thumbnail_path}"
        );
        let resolved = PathBuf::from(&result.root_path).join(thumbnail_path);
        assert!(resolved.is_file(), "thumbnail must exist: {}", resolved.display());
        // ...and must NOT be the media file itself, however it is spelled.
        assert_ne!(
            resolved.canonicalize().ok(),
            PathBuf::from(&copied.destination_path).canonicalize().ok(),
            "thumbnail must not point at the copied media"
        );
        assert_eq!(copied.thumbnail_kind, ThumbnailKind::Embedded);
        // A downscale actually happened: the re-encode is smaller than the 900x600 original.
        let original_bytes = fs::metadata(&copied.destination_path).expect("media meta").len();
        let thumbnail_bytes = fs::metadata(&resolved).expect("thumb meta").len();
        assert!(
            thumbnail_bytes < original_bytes,
            "thumbnail ({thumbnail_bytes}B) should be smaller than the still ({original_bytes}B)"
        );

        let _ = fs::remove_dir_all(workspace);
    }

    /// The cache has no other ceiling — nothing else deletes these files and no OS cleans the
    /// Windows cache dir — so the pruner is the only thing standing between a working editor
    /// and an unbounded folder.
    #[test]
    fn prune_thumbnail_cache_evicts_oldest_until_under_cap() {
        use crate::ingest::source_thumbs::prune_thumbnail_cache;
        use std::time::Duration;

        let cache = unique_temp_dir("ingest_pilot_prune_test");
        fs::create_dir_all(&cache).expect("cache dir");
        // Written oldest-first with a real gap between them: eviction order is by mtime, and a
        // same-tick timestamp would make the assertion meaningless.
        for name in ["old.jpg", "mid.jpg", "new.jpg"] {
            fs::write(cache.join(name), vec![0; 1000]).expect("write");
            std::thread::sleep(Duration::from_millis(20));
        }

        // Cap at 2 files' worth: the oldest must go, the newest must stay.
        prune_thumbnail_cache(&cache, 2000);
        assert!(!cache.join("old.jpg").exists(), "oldest must be evicted");
        assert!(cache.join("new.jpg").exists(), "newest must survive");
        let remaining: u64 = fs::read_dir(&cache)
            .expect("readdir")
            .filter_map(|entry| entry.ok()?.metadata().ok())
            .map(|metadata| metadata.len())
            .sum();
        assert!(remaining <= 2000, "cache must fit the cap, got {remaining}B");

        // Under the cap: nothing is touched.
        prune_thumbnail_cache(&cache, u64::MAX);
        assert!(cache.join("new.jpg").exists());
        // A missing cache dir is a no-op, never a panic.
        prune_thumbnail_cache(&cache.join("nope"), 0);

        let _ = fs::remove_dir_all(cache);
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
                metadata_preset_id: None,
            }],
            file_rename_pattern: "{original_name}{ext}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: destination.to_string_lossy().to_string(),
                secondaries: vec![],
                sub_path_pattern: String::new(),
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            metadata_preset_id: None,
            metadata_values: BTreeMap::new(),
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
            ThumbnailConfig::default(),
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
                metadata_preset_id: None,
            }],
            file_rename_pattern: "{original_name}{ext}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: destination.to_string_lossy().to_string(),
                secondaries: vec![],
                sub_path_pattern: String::new(),
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            metadata_preset_id: None,
            metadata_values: BTreeMap::new(),
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
            ThumbnailConfig::default(),
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

    /// The tier ladder must route by extension identically no matter which caller ran it —
    /// this is the whole reason `generate_thumbnail_for_media` was factored out of the
    /// `CopiedFile` wrapper. Extraction itself can't succeed here (the fixtures are empty
    /// stubs, and ffmpeg/exiftool may not be installed), but ROUTING is observable: only the
    /// tier a given extension lands in decides whether the result is `Placeholder` or `None`,
    /// and a raw extension must never be handed to ffmpeg.
    #[test]
    fn tier_dispatch_routes_extensions_by_kind() {
        let workspace = unique_temp_dir("ingest_pilot_tier_dispatch_test");
        let asset_dir = workspace.join("thumbs");
        fs::create_dir_all(&workspace).expect("workspace");

        // A stills-RAW and a cinema-RAW that no decoder can read still resolve through their
        // own tier and land on Placeholder — never falling through to the video tier.
        for (name, kind) in [
            ("A001.ARW", ScanFileKind::Photo),
            ("A001.DNG", ScanFileKind::Photo),
            ("A001.R3D", ScanFileKind::Footage),
            ("A001.BRAW", ScanFileKind::Footage),
        ] {
            let path = workspace.join(name);
            fs::write(&path, b"not really a raw file").expect("stub");
            let (generated, thumbnail_kind) = generate_thumbnail_for_media(
                &path,
                kind,
                &asset_dir,
                "a001",
                "abc12345",
                &ThumbnailConfig::default(),
            );
            assert!(generated.is_none(), "{name} must not produce pixels from a stub");
            assert_eq!(
                thumbnail_kind,
                ThumbnailKind::Placeholder,
                "{name} must resolve through its raw tier to a placeholder"
            );
        }

        // A non-media still (.heic) is neither raw nor Footage: it skips every generator tier.
        let heic = workspace.join("A001.HEIC");
        fs::write(&heic, b"stub").expect("stub");
        let (generated, thumbnail_kind) = generate_thumbnail_for_media(
            &heic,
            ScanFileKind::Photo,
            &asset_dir,
            "a001",
            "abc12345",
            &ThumbnailConfig::default(),
        );
        assert!(generated.is_none());
        assert_eq!(thumbnail_kind, ThumbnailKind::Placeholder);

        let _ = fs::remove_dir_all(workspace);
    }

    /// Extension routing is case-insensitive: a card writes `.ARW`, the matcher lists `.arw`.
    #[test]
    fn tier_dispatch_is_case_insensitive() {
        assert!(is_stills_raw_extension(".arw"));
        assert!(is_cinema_raw_extension(".r3d"));

        let workspace = unique_temp_dir("ingest_pilot_tier_case_test");
        fs::create_dir_all(&workspace).expect("workspace");
        // Upper-case on disk must still reach the stills-RAW tier (Placeholder), not the
        // do-nothing default — proving `generate_thumbnail_for_media` lowercases before matching.
        let path = workspace.join("A001.ARW");
        fs::write(&path, b"stub").expect("stub");
        let (_, thumbnail_kind) = generate_thumbnail_for_media(
            &path,
            ScanFileKind::Photo,
            &workspace.join("thumbs"),
            "a001",
            "abc12345",
            &ThumbnailConfig::default(),
        );
        assert_eq!(thumbnail_kind, ThumbnailKind::Placeholder);

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

        let thumbnail = generate_ffmpeg_thumbnail(
            &video_path,
            &asset_dir,
            "A001",
            "abc12345def",
            &ThumbnailConfig::default(),
        )
        .expect("thumbnail generated");
        assert!(thumbnail.exists());
        assert!(thumbnail
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .contains("_ffmpeg"));

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn routes_extensions_to_expected_thumbnail_tiers() {
        // Stills-RAW (Sony A7IV etc.) go to the pure-Rust rawler tier.
        assert!(is_stills_raw_extension(".arw"));
        assert!(is_stills_raw_extension(".dng"));
        assert!(is_stills_raw_extension(".cr3"));
        assert!(is_stills_raw_extension(".nef"));
        // Cinema-RAW (RED / Blackmagic) go to the exiftool tier, never ffmpeg.
        assert!(is_cinema_raw_extension(".r3d"));
        assert!(is_cinema_raw_extension(".braw"));
        // The two sets are disjoint and don't claim standard formats.
        assert!(!is_stills_raw_extension(".r3d"));
        assert!(!is_cinema_raw_extension(".arw"));
        assert!(!is_stills_raw_extension(".mp4"));
        assert!(!is_cinema_raw_extension(".mp4"));
        assert!(!is_stills_raw_extension(".jpg"));
    }

    #[test]
    fn content_addressed_asset_names_are_deterministic_and_sanitized() {
        let a = content_addressed_asset_name("A7C_1234", "9f8e7d6c5b4a3021", "jpg");
        let b = content_addressed_asset_name("A7C_1234", "9f8e7d6c5b4a3021", "jpg");
        assert_eq!(a, b, "same file + content => same asset name (race-free)");
        assert_eq!(a, "A7C_1234_9f8e7d6c.jpg");
        // Path-hostile characters in the stem are scrubbed.
        assert_eq!(
            content_addressed_asset_name("a/b:c*", "00", "jpg"),
            "a_b_c__00.jpg"
        );
        // An empty hash still yields a stable, valid name.
        assert_eq!(
            content_addressed_asset_name("clip", "", "jpg"),
            "clip_nohash.jpg"
        );
    }

    /// A minimal preset with no variables and an empty folder tree (media lands directly
    /// in the root), used by the multi-destination tests.
    fn loose_preset(id: &str, primary: &str) -> Preset {
        Preset {
            schema_version: 1,
            id: id.to_string(),
            name: "Multi".to_string(),
            description: None,
            icon: None,
            color: None,
            variables: vec![],
            root_folder_pattern: "Proj".to_string(),
            folder_tree: vec![],
            file_rename_pattern: "{original_name}{ext}".to_string(),
            clip_number_padding: 3,
            per_folder_rename_overrides: BTreeMap::new(),
            destinations: PresetDestinations {
                primary: primary.to_string(),
                secondaries: vec![],
                sub_path_pattern: String::new(),
            },
            file_type_routing_overrides: BTreeMap::new(),
            preserve_xml_sidecars: true,
            rename_files_default: true,
            metadata_preset_id: None,
            metadata_values: BTreeMap::new(),
            created_at: "2026-04-24T00:00:00Z".to_string(),
            updated_at: "2026-04-24T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn run_ingest_multi_copies_to_all_destinations() {
        let workspace = unique_temp_dir("ingest_pilot_multi_all_test");
        let source = workspace.join("source");
        fs::create_dir_all(&source).expect("source dir");
        fs::write(source.join("A.MP4"), vec![1; 32]).expect("media a");
        fs::write(source.join("B.MP4"), vec![2; 48]).expect("media b");

        // Three existing destination roots; copies land directly in each (empty tree).
        let dests: Vec<PathBuf> = (0..3).map(|i| workspace.join(format!("dest{i}"))).collect();
        for dest in &dests {
            fs::create_dir_all(dest).expect("dest dir");
        }
        let destination_overrides: Vec<String> = dests
            .iter()
            .map(|dest| dest.to_string_lossy().to_string())
            .collect();

        let preset = loose_preset("preset_multi", &destination_overrides[0]);

        let result = run_ingest_multi(
            &preset,
            source.to_string_lossy().to_string(),
            BTreeMap::new(),
            destination_overrides.clone(),
            true,
            true,
            false,
            None,
            None,
            true, // use existing roots (each dest IS the root)
            None,
            None,
            None,
            None,
            None,
        )
        .expect("multi ingest succeeds");

        assert_eq!(result.roots.len(), 3, "one IngestResult per destination");
        assert!(result.failures.is_empty(), "no destination should fail");

        for dest in &dests {
            assert!(dest.join("A.mp4").exists(), "A copied to {}", dest.display());
            assert!(dest.join("B.mp4").exists(), "B copied to {}", dest.display());
        }
        for root in &result.roots {
            assert_eq!(root.files_copied, 2, "each root copies both media files");
            assert_eq!(root.verified_files, 2, "each root verifies both files");
            assert_eq!(root.verification_failed, 0);
            assert!(PathBuf::from(&root.mhl_path).exists(), "each root writes its MHL");
        }

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn run_ingest_multi_dedups_destinations_pointing_at_the_same_root() {
        let workspace = unique_temp_dir("ingest_pilot_multi_dedup_test");
        let source = workspace.join("source");
        fs::create_dir_all(&source).expect("source dir");
        fs::write(source.join("A.MP4"), vec![7; 40]).expect("media");

        let dest = workspace.join("dest");
        fs::create_dir_all(&dest).expect("dest dir");
        let dest_str = dest.to_string_lossy().to_string();

        // Same root reached three ways: exact duplicate, trailing-separator variant, and
        // (on Windows) a case variant. All must collapse to a SINGLE root/copy — never two
        // threads clobbering the same file.
        let mut destination_overrides = vec![
            dest_str.clone(),
            format!("{dest_str}{}", std::path::MAIN_SEPARATOR),
            dest_str.clone(),
        ];
        #[cfg(windows)]
        destination_overrides.push(dest_str.to_uppercase());

        let preset = loose_preset("preset_multi_dedup", &dest_str);

        let result = run_ingest_multi(
            &preset,
            source.to_string_lossy().to_string(),
            BTreeMap::new(),
            destination_overrides,
            true,
            true,
            false,
            None,
            None,
            true,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("multi ingest succeeds");

        assert_eq!(
            result.roots.len(),
            1,
            "duplicate destinations collapse to a single root"
        );
        assert!(result.failures.is_empty());
        assert_eq!(result.roots[0].files_copied, 1);
        // Exactly one copy of A on disk (no clobbered sibling/duplicate).
        let a_copies = fs::read_dir(&dest)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .starts_with('a')
            })
            .count();
        assert_eq!(a_copies, 1, "one destination => one copy, not two");

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn run_ingest_multi_failing_destination_does_not_abort_others() {
        let workspace = unique_temp_dir("ingest_pilot_multi_fail_test");
        let source = workspace.join("source");
        fs::create_dir_all(&source).expect("source dir");
        fs::write(source.join("A.MP4"), vec![9; 24]).expect("media");

        let good1 = workspace.join("good1");
        let good2 = workspace.join("good2");
        fs::create_dir_all(&good1).expect("good1");
        fs::create_dir_all(&good2).expect("good2");
        // A regular FILE used as a "destination": `existing_root_scaffold` rejects it
        // ("... is not a folder."), so this destination's thread errors while the two
        // real folders still complete.
        let bad = workspace.join("bad_dest_is_a_file");
        fs::write(&bad, vec![0; 4]).expect("bad dest file");

        let destination_overrides = vec![
            good1.to_string_lossy().to_string(),
            bad.to_string_lossy().to_string(),
            good2.to_string_lossy().to_string(),
        ];
        let preset = loose_preset("preset_multi_fail", &destination_overrides[0]);

        let result = run_ingest_multi(
            &preset,
            source.to_string_lossy().to_string(),
            BTreeMap::new(),
            destination_overrides,
            true,
            true,
            false,
            None,
            None,
            true,
            None,
            None,
            None,
            None,
            None,
        )
        .expect("multi ingest returns a result even with one bad drive");

        assert_eq!(result.roots.len(), 2, "the two good drives complete");
        assert_eq!(result.failures.len(), 1, "the bad drive is captured as a failure");
        assert_eq!(result.failures[0].index, 1, "failure keeps its destination index");
        assert_eq!(
            result.failures[0].path,
            bad.to_string_lossy().to_string(),
            "failure carries the offending destination path"
        );
        assert!(good1.join("A.mp4").exists());
        assert!(good2.join("A.mp4").exists());

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn run_ingest_multi_streams_per_destination_progress_and_verified_feed() {
        let workspace = unique_temp_dir("ingest_pilot_multi_feed_test");
        let source = workspace.join("source");
        fs::create_dir_all(&source).expect("source dir");
        fs::write(source.join("A.MP4"), vec![3; 16]).expect("media a");
        fs::write(source.join("B.MP4"), vec![4; 16]).expect("media b");

        let dests: Vec<PathBuf> = (0..2).map(|i| workspace.join(format!("dest{i}"))).collect();
        for dest in &dests {
            fs::create_dir_all(dest).expect("dest dir");
        }
        let destination_overrides: Vec<String> = dests
            .iter()
            .map(|dest| dest.to_string_lossy().to_string())
            .collect();
        let preset = loose_preset("preset_multi_feed", &destination_overrides[0]);

        let mut progress_events: Vec<IngestProgress> = Vec::new();
        let mut verified_events: Vec<FileVerified> = Vec::new();
        {
            let mut on_progress = |progress: IngestProgress| progress_events.push(progress);
            let mut on_verified = |event: FileVerified| verified_events.push(event);
            let result = run_ingest_multi(
                &preset,
                source.to_string_lossy().to_string(),
                BTreeMap::new(),
                destination_overrides,
                true,
                true,
                false,
                None,
                None,
                true,
                None,
                None,
                None,
                Some(&mut on_progress),
                Some(&mut on_verified),
            )
            .expect("multi ingest succeeds");
            assert_eq!(result.roots.len(), 2);
        }

        // One file-verified per file per destination (2 files x 2 dests), each stamped
        // with the checksum algo and verified true.
        assert_eq!(
            verified_events.len(),
            4,
            "one file-verified per file per destination"
        );
        assert!(verified_events.iter().all(|event| event.algo == "XXH3-128"));
        assert!(verified_events.iter().all(|event| event.verified));
        assert!(verified_events
            .iter()
            .any(|event| event.destination_index == 0));
        assert!(verified_events
            .iter()
            .any(|event| event.destination_index == 1));

        // At least one aggregate progress event carried the per-destination breakdown.
        assert!(
            progress_events
                .iter()
                .any(|progress| progress.destination_count == 2 && progress.destinations.len() == 2),
            "aggregate progress exposes both destinations"
        );
        // The terminal aggregate sums per-destination counters (2 files x 2 dests).
        let final_progress = progress_events.last().expect("a final aggregate event");
        assert_eq!(final_progress.files_done, 4);
        assert_eq!(final_progress.verified_files, 4);

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn run_ingest_multi_cancel_short_circuits() {
        let workspace = unique_temp_dir("ingest_pilot_multi_cancel_test");
        let source = workspace.join("source");
        fs::create_dir_all(&source).expect("source dir");
        fs::write(source.join("A.MP4"), vec![5; 16]).expect("media");

        let dests: Vec<PathBuf> = (0..2).map(|i| workspace.join(format!("dest{i}"))).collect();
        for dest in &dests {
            fs::create_dir_all(dest).expect("dest dir");
        }
        let destination_overrides: Vec<String> = dests
            .iter()
            .map(|dest| dest.to_string_lossy().to_string())
            .collect();
        let preset = loose_preset("preset_multi_cancel", &destination_overrides[0]);

        // Pre-cancelled: every destination thread observes the shared flag and bails out.
        let cancel = AtomicBool::new(true);
        let result = run_ingest_multi(
            &preset,
            source.to_string_lossy().to_string(),
            BTreeMap::new(),
            destination_overrides,
            true,
            true,
            false,
            None,
            None,
            true,
            None,
            None,
            Some(&cancel),
            None,
            None,
        );

        assert!(result.is_err(), "a cancelled multi ingest returns an error");
        assert!(result.unwrap_err().to_lowercase().contains("cancel"));

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
