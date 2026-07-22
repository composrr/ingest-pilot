//! Previews for files that are still sitting on the card, for the file-selection browser.
//!
//! The post-copy report path ([`super::copier::attach_report_thumbnails`]) can write its
//! assets next to the media it just copied. This path cannot: the source is a camera card —
//! frequently read-only, and never something we should be granting the webview blanket read
//! access to. So every preview here is re-encoded into the app's own cache directory, which
//! is the single directory the asset protocol is scoped to (see `lib.rs` `setup`).
//!
//! The extraction ladder itself is NOT reimplemented — tiers 3–6 are
//! [`super::copier::generate_thumbnail_for_media`], shared verbatim with the report path.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use xxhash_rust::xxh3::xxh3_64;

use super::copier::{
    content_addressed_asset_name, exif_orientation, generate_thumbnail_for_media,
    write_downscaled_jpeg_from_bytes, ThumbnailConfig, ThumbnailKind,
};
use super::scanner::{classify_file, format_modified_time, is_browser_image_extension};

/// One file the browser wants a preview for.
#[derive(Debug, Clone, Deserialize)]
pub struct SourceThumbnailRequest {
    /// Absolute path of the media file, as reported by the scan.
    pub path: String,
    /// Optional pixel source carried over from the scan (`ScannedFile.thumbnail_path`): the
    /// file itself when it's a browser-native image, or the companion THMBNL/PREVIEW JPEG the
    /// camera wrote beside the clip. When set we downscale THAT rather than running the much
    /// more expensive extractor ladder against the media itself.
    ///
    /// Note this is a *hint about where pixels live*, not a URL — it points at the card, which
    /// the webview cannot read. It is always re-encoded into the cache before being returned.
    #[serde(default)]
    pub preview_path: Option<String>,
}

/// The result for one request. `key` echoes the requested path so the UI can map the
/// (unordered, incrementally-arriving) results back onto its tiles.
#[derive(Debug, Clone, Serialize)]
pub struct SourceThumbnail {
    pub key: String,
    /// Absolute path INSIDE the thumbnail cache, or `None` when no tier produced pixels.
    /// Guaranteed to be under the cache dir — the only place the webview may read from.
    pub thumbnail_path: Option<String>,
    pub kind: ThumbnailKind,
}

impl SourceThumbnail {
    /// No preview, and none possible (unreadable/missing file). The UI keeps its placeholder.
    fn none(key: &str) -> Self {
        Self {
            key: key.to_string(),
            thumbnail_path: None,
            kind: ThumbnailKind::None,
        }
    }
}

/// Stable cache key for a source file: `path | size_bytes | modified_at`.
///
/// Deliberately NOT a content hash. Hashing file *contents* to name a thumbnail would mean
/// reading all 4 GB of an R3D just to discover we already had its preview — it would make a
/// cache HIT the most expensive operation in the app, on the exact screen that has to stay
/// responsive while the user scrolls. These three fields come free with the directory entry
/// the scan already stat'ed, and xxh3 here hashes only the short key string, never the media.
///
/// ACCEPTED TRADEOFF: a file rewritten in place to exactly the same byte length, with an mtime
/// that lands in the same one-second tick, serves a stale thumbnail. On offload media — a card
/// written once by a camera and then read — this does not occur in practice. The blast radius
/// is one wrong picture in a picker; it can never cause a wrong copy, because the ingest path
/// hashes real bytes independently of this cache.
pub fn source_cache_key(path: &Path, size_bytes: u64, modified_at: Option<&str>) -> String {
    let raw = format!(
        "{}|{size_bytes}|{}",
        path.to_string_lossy().replace('\\', "/"),
        modified_at.unwrap_or("nomtime"),
    );
    format!("{:016x}", xxh3_64(raw.as_bytes()))
}

/// Ceiling for the source-thumbnail cache. At roughly 40 KB per 512px JPEG this is ~13,000
/// previews — far more than any one session browses, while bounding an editor who works
/// through 50k files a week at something that fits on any disk.
pub const SOURCE_THUMBNAIL_CACHE_MAX_BYTES: u64 = 512 * 1024 * 1024;

/// Delete the oldest thumbnails until the cache fits inside `max_bytes`.
///
/// Nothing else ever removes these files, and no OS will do it for us (see
/// `storage::app_cache_root`), so this is the only ceiling that exists. Eviction order is by
/// mtime, which for this cache means *generation* time: entries are written once and then only
/// ever stat'ed, never rewritten. That makes it least-recently-*created*, not truly LRU — a
/// preview the user looks at daily can still be evicted. That's acceptable: the penalty for a
/// wrong guess is one regenerated thumbnail, which is the same work as generating it the first
/// time. Best-effort throughout; a cache we can't prune is not a reason to fail anything.
pub fn prune_thumbnail_cache(cache_dir: &Path, max_bytes: u64) {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            Some((metadata.modified().ok()?, metadata.len(), entry.path()))
        })
        .collect();

    let mut remaining: u64 = files.iter().map(|(_, size, _)| size).sum();
    if remaining <= max_bytes {
        return;
    }
    files.sort_by_key(|(modified, _, _)| *modified);
    for (_, size, path) in files {
        if remaining <= max_bytes {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            remaining = remaining.saturating_sub(size);
        }
    }
}

fn dotted_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_lowercase()))
        .unwrap_or_default()
}

/// Generate (or serve from cache) one source preview. Never returns an error: a preview that
/// can't be produced is a placeholder tile, never a failure the user has to deal with.
pub fn generate_source_thumbnail(
    request: &SourceThumbnailRequest,
    cache_dir: &Path,
    config: &ThumbnailConfig,
) -> SourceThumbnail {
    let path = PathBuf::from(&request.path);
    let Ok(metadata) = fs::metadata(&path) else {
        return SourceThumbnail::none(&request.path);
    };
    if !metadata.is_file() {
        return SourceThumbnail::none(&request.path);
    }

    let modified_at = metadata.modified().ok().and_then(format_modified_time);
    // Stat'ed here rather than trusted from the caller: the key must describe the bytes on
    // disk right now, not what a possibly-stale scan in the webview believes about them.
    let key = source_cache_key(&path, metadata.len(), modified_at.as_deref());
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();

    let resolved = |written: PathBuf, kind: ThumbnailKind| SourceThumbnail {
        key: request.path.clone(),
        thumbnail_path: Some(written.to_string_lossy().to_string()),
        kind,
    };

    // Tier 2 — a DONATED companion image (the THMBNL/PREVIEW JPEG a camera wrote beside the
    // clip). Handled here rather than in the shared ladder because only this path has the
    // scan's pairing hint; the ladder works from the media file alone.
    //
    // The self-preview case (`preview_path` == the file itself, i.e. a DCIM JPEG) is NOT
    // handled here — it is Tier 1 of the shared ladder, which reaches the same result from
    // `path` alone. Keeping it there is what stops the two callers from drifting apart.
    if let Some(preview_source) = request.preview_path.as_deref().map(PathBuf::from) {
        if preview_source != path && is_browser_image_extension(&dotted_extension(&preview_source))
        {
            let target = cache_dir.join(content_addressed_asset_name(&stem, &key, "jpg"));
            // Check before reading: on a cache hit this avoids pulling the whole donor JPEG
            // off the card again every time the tile scrolls back into view.
            if target.is_file() {
                return resolved(target, ThumbnailKind::Sidecar);
            }
            if let Ok(bytes) = fs::read(&preview_source) {
                let orientation = exif_orientation(&preview_source);
                if let Some(written) = write_downscaled_jpeg_from_bytes(
                    &bytes,
                    cache_dir,
                    &stem,
                    &key,
                    config,
                    orientation,
                ) {
                    return resolved(written, ThumbnailKind::Sidecar);
                }
            }
            // A corrupt/truncated donor falls through to the ladder rather than giving up.
        }
    }

    // Tiers 1 & 3–6 — the shared extractor ladder (browser image → stills-RAW → cinema-RAW →
    // ffmpeg → placeholder). Every tier is internally cache-aware (each checks its
    // content-addressed target first), so a re-request for an already-generated preview costs
    // a stat, not an extraction.
    let kind = classify_file(&path, &dotted_extension(&path));
    let (generated, tier_kind) =
        generate_thumbnail_for_media(&path, kind, cache_dir, &stem, &key, config);
    match generated {
        Some(written) => resolved(written, tier_kind),
        None => SourceThumbnail {
            key: request.path.clone(),
            thumbnail_path: None,
            kind: tier_kind,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_for(path: &str, size: u64, modified: Option<&str>) -> String {
        source_cache_key(Path::new(path), size, modified)
    }

    /// The whole point of the synthetic key: identical (path, size, mtime) must name the same
    /// cache file every run, in every process — otherwise the cache never hits and we
    /// re-extract on every scroll.
    #[test]
    fn cache_key_is_stable_for_identical_inputs() {
        let first = key_for("D:/CARD/A001.R3D", 4_294_967_296, Some("1718000000"));
        let second = key_for("D:/CARD/A001.R3D", 4_294_967_296, Some("1718000000"));
        assert_eq!(first, second);
        assert_eq!(first.len(), 16, "key must be a fixed-width hex digest");
    }

    /// Windows and POSIX separators must not produce different cache entries for one file.
    #[test]
    fn cache_key_normalizes_path_separators() {
        assert_eq!(
            key_for("D:\\CARD\\A001.R3D", 10, Some("1718000000")),
            key_for("D:/CARD/A001.R3D", 10, Some("1718000000")),
        );
    }

    /// Each component must actually participate: a re-shot card that reuses filenames, or an
    /// edited file, has to miss the cache rather than serve the previous frame.
    #[test]
    fn cache_key_changes_with_each_component() {
        let base = key_for("D:/CARD/A001.ARW", 100, Some("1718000000"));
        assert_ne!(base, key_for("D:/CARD/A002.ARW", 100, Some("1718000000")));
        assert_ne!(base, key_for("D:/CARD/A001.ARW", 101, Some("1718000000")));
        assert_ne!(base, key_for("D:/CARD/A001.ARW", 100, Some("1718000001")));
    }

    /// A file with no readable mtime still has to produce a usable, stable key rather than
    /// panicking or collapsing every such file onto one cache entry.
    #[test]
    fn cache_key_tolerates_missing_modified_time() {
        let none = key_for("D:/CARD/A001.ARW", 100, None);
        assert_eq!(none, key_for("D:/CARD/A001.ARW", 100, None));
        assert_ne!(none, key_for("D:/CARD/B001.ARW", 100, None));
    }

    /// `short_source_hash` (which builds the on-disk filename) keeps only alphanumerics, so a
    /// hex digest must survive it intact — a key that sanitized down to "nohash" would collide
    /// every file in the cache onto one name.
    #[test]
    fn cache_key_survives_asset_name_sanitizing() {
        let key = key_for("D:/CARD/A001.ARW", 100, Some("1718000000"));
        assert!(key.chars().all(|c| c.is_ascii_alphanumeric()), "key: {key}");
        let name = content_addressed_asset_name("a001", &key, "jpg");
        assert_eq!(name, format!("a001_{}.jpg", &key[..8]));
    }

    /// A missing file is a placeholder tile, never an error — the picker must keep working
    /// when a card is yanked mid-browse.
    #[test]
    fn missing_file_yields_no_thumbnail() {
        let request = SourceThumbnailRequest {
            path: "D:/definitely/not/here/A001.ARW".to_string(),
            preview_path: None,
        };
        let result = generate_source_thumbnail(
            &request,
            Path::new("./nonexistent-cache"),
            &ThumbnailConfig::default(),
        );
        assert_eq!(result.key, request.path);
        assert!(result.thumbnail_path.is_none());
        assert_eq!(result.kind, ThumbnailKind::None);
    }
}
