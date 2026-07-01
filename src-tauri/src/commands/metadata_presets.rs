use crate::core::metadata_preset::{MetadataPreset, MetadataPresetSummary};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[tauri::command]
pub fn list_metadata_presets(app: AppHandle) -> Result<Vec<MetadataPresetSummary>, String> {
    let directory = metadata_preset_directory(&app)?;

    let mut presets = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("metapreset") {
            continue;
        }
        if let Ok(preset) = read_metadata_preset_file(&path) {
            presets.push(MetadataPresetSummary::from(&preset));
        }
    }

    presets.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(presets)
}

#[tauri::command]
pub fn get_metadata_preset(app: AppHandle, id: String) -> Result<Option<MetadataPreset>, String> {
    match find_metadata_file_by_id(&app, &id)? {
        Some(path) => Ok(Some(read_metadata_preset_file(&path)?)),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn save_metadata_preset(
    app: AppHandle,
    preset: MetadataPreset,
) -> Result<MetadataPresetSummary, String> {
    if preset.id.trim().is_empty() {
        return Err("Metadata preset needs an id.".to_string());
    }
    if preset.name.trim().is_empty() {
        return Err("Metadata preset needs a name.".to_string());
    }

    let directory = metadata_preset_directory(&app)?;
    if let Some(existing) = find_metadata_file_by_id(&app, &preset.id)? {
        let _ = fs::remove_file(existing);
    }

    let path = metadata_path_for(&directory, &preset);
    let json = serde_json::to_string_pretty(&preset).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())?;

    Ok(MetadataPresetSummary::from(&preset))
}

#[tauri::command]
pub fn delete_metadata_preset(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(path) = find_metadata_file_by_id(&app, &id)? {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn metadata_preset_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = crate::core::storage::library_root(app)?.join("Metadata Presets");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    migrate_legacy_metadata(app, &directory);
    Ok(directory)
}

// One-time move of metadata presets from the old hidden config dir into the visible
// Documents library, rewritten as one human-named file each.
fn migrate_legacy_metadata(app: &AppHandle, new_dir: &Path) {
    let marker = new_dir.join(".migrated");
    if marker.exists() {
        return;
    }
    if let Ok(old_root) = crate::core::storage::app_data_root(app) {
        let old_dir = old_root.join("MetadataPresets");
        if old_dir.exists() && old_dir != *new_dir {
            if let Ok(entries) = fs::read_dir(&old_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|value| value.to_str()) != Some("metapreset") {
                        continue;
                    }
                    if let Ok(preset) = read_metadata_preset_file(&path) {
                        if let Ok(json) = serde_json::to_string_pretty(&preset) {
                            let _ = fs::write(metadata_path_for(new_dir, &preset), json);
                        }
                    }
                }
            }
        }
    }
    let _ = fs::write(marker, "");
}

fn metadata_path_for(directory: &Path, preset: &MetadataPreset) -> PathBuf {
    let mut base = sanitize_file_stem(preset.name.trim());
    if base.trim_matches('_').is_empty() {
        base = sanitize_file_stem(&preset.id);
    }
    let candidate = directory.join(format!("{base}.metapreset"));
    if let Ok(existing) = read_metadata_preset_file(&candidate) {
        if existing.id != preset.id {
            let suffix: String = preset
                .id
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .take(6)
                .collect();
            return directory.join(format!("{base}_{suffix}.metapreset"));
        }
    }
    candidate
}

fn find_metadata_file_by_id(app: &AppHandle, id: &str) -> Result<Option<PathBuf>, String> {
    let directory = metadata_preset_directory(app)?;
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("metapreset") {
            continue;
        }
        if let Ok(preset) = read_metadata_preset_file(&path) {
            if preset.id == id {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

fn sanitize_file_stem(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' || character == ' ' {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn read_metadata_preset_file(path: &Path) -> Result<MetadataPreset, String> {
    let json = fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_str(&json).map_err(|error| format!("{}: {error}", path.display()))
}
