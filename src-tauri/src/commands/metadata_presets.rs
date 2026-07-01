use crate::core::metadata_preset::{MetadataPreset, MetadataPresetSummary};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

#[tauri::command]
pub fn list_metadata_presets(app: AppHandle) -> Result<Vec<MetadataPresetSummary>, String> {
    let directory = metadata_preset_directory(&app)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let mut presets = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("metapreset") {
            continue;
        }
        let preset = read_metadata_preset_file(&path)?;
        presets.push(MetadataPresetSummary::from(&preset));
    }

    presets.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(presets)
}

#[tauri::command]
pub fn get_metadata_preset(app: AppHandle, id: String) -> Result<Option<MetadataPreset>, String> {
    let path = metadata_preset_path(&app, &id)?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(read_metadata_preset_file(&path)?))
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
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let path = metadata_preset_path(&app, &preset.id)?;
    let json = serde_json::to_string_pretty(&preset).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())?;

    Ok(MetadataPresetSummary::from(&preset))
}

#[tauri::command]
pub fn delete_metadata_preset(app: AppHandle, id: String) -> Result<(), String> {
    let path = metadata_preset_path(&app, &id)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn metadata_preset_directory(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::core::storage::app_data_root(app)?.join("MetadataPresets"))
}

fn metadata_preset_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let safe_id: String = id
        .chars()
        .map(|character| if character.is_alphanumeric() || character == '-' || character == '_' { character } else { '_' })
        .collect();
    Ok(metadata_preset_directory(app)?.join(format!("{safe_id}.metapreset")))
}

fn read_metadata_preset_file(path: &std::path::Path) -> Result<MetadataPreset, String> {
    let json = fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_str(&json).map_err(|error| format!("{}: {error}", path.display()))
}
