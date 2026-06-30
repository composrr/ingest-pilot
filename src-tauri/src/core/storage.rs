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
