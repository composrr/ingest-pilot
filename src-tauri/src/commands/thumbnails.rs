use rayon::prelude::*;
use tauri::AppHandle;

use crate::core::storage::source_thumbnail_cache_dir;
use crate::ingest::copier::{ThumbnailConfig, ThumbnailKind};
use crate::ingest::source_thumbs::{
    generate_source_thumbnail, prune_thumbnail_cache, SourceThumbnail, SourceThumbnailRequest,
    SOURCE_THUMBNAIL_CACHE_MAX_BYTES,
};

/// Source previews are grid tiles, not report assets: 512px is already generous at the
/// largest tile size, and keeping them small is what lets a card of 2,000 stills stay
/// scrollable. Independent of the user's report thumbnail settings on purpose — someone
/// exporting 2048px report stills should not thereby make their file picker crawl.
const SOURCE_THUMBNAIL_MAX_EDGE: u32 = 512;
const SOURCE_THUMBNAIL_QUALITY: u8 = 78;

/// Generate previews for files still on the card, for the file-selection browser.
///
/// LAZY AND INCREMENTAL BY CONTRACT: this is deliberately not part of `scan_source` (already
/// the bottleneck on a full card). The UI calls it per batch of tiles that actually scrolled
/// into view, so a 2,000-file card costs only the previews the user looked at.
///
/// Results are returned keyed by request path. A file that fails, panics mid-decode, or has no
/// extractable preview comes back with `thumbnail_path: None` — a thumbnail failure never fails
/// the batch, and never fails an ingest.
///
/// NOTE: intentionally emits no progress event. A batch is one screenful of tiles and resolves
/// in well under a second; the UI shows per-tile pending state instead, which is the thing a
/// user can actually act on. An earlier revision emitted one IPC event per file that nothing
/// ever listened to.
#[tauri::command]
pub async fn generate_source_thumbnails(
    app: AppHandle,
    requests: Vec<SourceThumbnailRequest>,
) -> Result<Vec<SourceThumbnail>, String> {
    if requests.is_empty() {
        return Ok(Vec::new());
    }
    // Resolved (and created) before the worker so a broken cache dir is a real error the
    // caller sees once, rather than N silently empty tiles.
    let cache_dir = source_thumbnail_cache_dir(&app)?;
    let config = ThumbnailConfig {
        include: true,
        max_edge: SOURCE_THUMBNAIL_MAX_EDGE,
        jpeg_quality: SOURCE_THUMBNAIL_QUALITY,
    }
    .sanitized();

    tauri::async_runtime::spawn_blocking(move || {
        // One request's worth of work, with the panic containment the rawler/image decode
        // chain demands: a malformed file on the card must degrade to a placeholder tile, not
        // unwind the batch (or, in a rayon worker, abort the pool).
        let one = |request: &SourceThumbnailRequest| -> SourceThumbnail {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                generate_source_thumbnail(request, &cache_dir, &config)
            }))
            .unwrap_or_else(|_| SourceThumbnail {
                key: request.path.clone(),
                thumbnail_path: None,
                kind: ThumbnailKind::Placeholder,
            })
        };

        // Bounded pool, as in `attach_report_thumbnails`: extraction shells out to
        // exiftool/ffmpeg and reads off the card, so unbounded parallelism just thrashes the
        // disk and the process table. Lower floor than the report pass because this runs
        // interactively, alongside whatever the user is doing.
        let threads = std::thread::available_parallelism()
            .map(|value| value.get())
            .unwrap_or(4)
            .clamp(2, 8);

        let results: Vec<SourceThumbnail> =
            match rayon::ThreadPoolBuilder::new().num_threads(threads).build() {
                Ok(pool) => pool.install(|| requests.par_iter().map(one).collect()),
                // Pool construction failed (rare) — serial fallback, same containment.
                Err(_) => requests.iter().map(one).collect(),
            };

        // Nothing else bounds this cache, so bound it here. Cheap next to the extraction work
        // that just ran (one readdir against N ffmpeg/rawler invocations), and doing it after
        // each batch means the ceiling holds during a long browse, not just at startup.
        prune_thumbnail_cache(&cache_dir, SOURCE_THUMBNAIL_CACHE_MAX_BYTES);

        results
    })
    .await
    .map_err(|error| error.to_string())
}
