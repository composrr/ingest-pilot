use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Root directory for the app's own data (settings, presets, history).
///
/// Uses the per-app config directory (`~/Library/Application Support/<id>` on
/// macOS, `%APPDATA%\<id>` on Windows, `~/.config/<id>` on Linux). This is
/// deliberately NOT `~/Documents`: on macOS the Documents folder is privacy
/// protected, so storing app data there made the system prompt for access on
/// nearly every read/write. The config dir is not gated, so the prompts go away.
///
/// On first use it migrates any data from the legacy `~/Documents/IngestPilot`
/// location so existing presets/settings/history carry over.
pub fn app_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;

    if !root.exists() {
        migrate_legacy_documents(app, &root);
    }
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

/// Root for REGENERABLE data — currently the source-thumbnail cache.
///
/// Sibling of [`app_data_root`], and deliberately a different base directory: that one uses
/// `app_config_dir`, which is the right home for things whose loss is data loss (settings,
/// presets, history) and which sync tools and backups are expected to preserve. Thumbnails are
/// none of those — they are a pure function of the media on the card and can be rebuilt on
/// demand — so they belong here. Never store anything in this tree that can't be recomputed.
///
/// DO NOT assume the OS cleans this up. That is roughly true on macOS (`~/Library/Caches` is
/// eligible for eviction) and simply FALSE on Windows, where `%LOCALAPPDATA%\<id>\cache` is an
/// ordinary folder that nothing ever touches — and Windows is the primary platform here. The
/// only ceiling that exists is the one we enforce ourselves:
/// `ingest::source_thumbs::prune_thumbnail_cache`, run after each thumbnail batch. Anything
/// new that lands in this tree needs its own bound.
pub fn app_cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

/// Where `generate_source_thumbnails` writes previews of files still sitting on the card.
///
/// This is the ONE directory the webview is granted read access to at startup
/// (`lib.rs` → `asset_protocol_scope().allow_directory`), which is why source previews live
/// here rather than beside the media: the card is read-only, may not be writable, and
/// allowlisting it would hand the webview the user's whole volume.
pub fn source_thumbnail_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app_cache_root(app)?.join("source-thumbs");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

/// Visible, user-facing library root: `~/Documents/Ingest Pilot`. Holds the shareable
/// preset files (one file per preset, in subfolders) so they can be seen in Finder and
/// synced across machines with a git repo. Distinct from `app_data_root`, which keeps
/// machine-specific settings/history in the hidden per-app config dir.
pub fn library_root(app: &AppHandle) -> Result<PathBuf, String> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|error| error.to_string())?;
    let root = documents.join("Ingest Pilot");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root)
}

/// Copies the old `~/Documents/IngestPilot` tree into the new root if it exists
/// and the new root has not been created yet. Best-effort: failures are ignored
/// so a migration hiccup never blocks the app from starting fresh.
fn migrate_legacy_documents(app: &AppHandle, new_root: &Path) {
    let Ok(documents) = app.path().document_dir() else {
        return;
    };
    let legacy = documents.join("IngestPilot");
    if !legacy.exists() {
        return;
    }
    let _ = copy_dir_recursive(&legacy, new_root);
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}
