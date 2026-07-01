use crate::core::preset::{FolderNode, Preset, PresetSummary};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

#[tauri::command]
pub fn list_presets(app: AppHandle) -> Result<Vec<PresetSummary>, String> {
    let directory = preset_directory(&app)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;

    let mut presets = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("preset") {
            continue;
        }

        let preset = read_preset_file(&path)?;
        presets.push(PresetSummary::from(&preset));
    }

    presets.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(presets)
}

#[tauri::command]
pub fn get_preset(app: AppHandle, id: String) -> Result<Option<Preset>, String> {
    match find_preset_file_by_id(&app, &id)? {
        Some(path) => Ok(Some(read_preset_file(&path)?)),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn save_preset(app: AppHandle, preset: Preset) -> Result<PresetSummary, String> {
    validate_preset(&preset)?;

    let directory = preset_directory(&app)?;
    // Remove any existing file for this preset first, so a rename doesn't leave a stale
    // file behind under the old name.
    if let Some(existing) = find_preset_file_by_id(&app, &preset.id)? {
        let _ = fs::remove_file(existing);
    }

    let path = preset_path_for(&directory, &preset);
    let json = serde_json::to_string_pretty(&preset).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())?;

    Ok(PresetSummary::from(&preset))
}

#[tauri::command]
pub fn delete_preset(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(path) = find_preset_file_by_id(&app, &id)? {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn import_preset(app: AppHandle, file_path: String) -> Result<PresetSummary, String> {
    let mut preset = read_preset_file(Path::new(&file_path))?;
    preset = make_unique_preset(&app, preset)?;
    save_preset(app, preset)
}

#[tauri::command]
pub fn export_preset(app: AppHandle, id: String, target_path: String) -> Result<(), String> {
    let source =
        find_preset_file_by_id(&app, &id)?.ok_or_else(|| format!("Preset '{id}' does not exist."))?;
    fs::copy(source, target_path).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn duplicate_preset(app: AppHandle, id: String) -> Result<PresetSummary, String> {
    let path =
        find_preset_file_by_id(&app, &id)?.ok_or_else(|| format!("Preset '{id}' does not exist."))?;
    let preset = read_preset_file(&path)?;
    let duplicate = make_unique_preset(&app, preset)?;
    save_preset(app, duplicate)
}

#[tauri::command]
pub fn import_folder_tree(folder_path: String) -> Result<Vec<FolderNode>, String> {
    let root = Path::new(&folder_path);
    if !root.exists() {
        return Err(format!("Folder '{}' does not exist.", root.display()));
    }
    if !root.is_dir() {
        return Err(format!("'{}' is not a folder.", root.display()));
    }

    let mut ids = HashSet::new();
    let root_node = folder_node_from_path(root, &mut ids)?;
    Ok(vec![root_node])
}

#[derive(Debug, Serialize)]
pub struct DroppedTemplateItems {
    pub folders: Vec<FolderNode>,
    pub files: Vec<String>,
}

#[tauri::command]
pub fn inspect_template_drop(paths: Vec<String>) -> Result<DroppedTemplateItems, String> {
    let mut ids = HashSet::new();
    let mut folders = Vec::new();
    let mut files = Vec::new();

    for path in paths {
        let path_buf = PathBuf::from(&path);
        if !path_buf.exists() {
            return Err(format!(
                "Dropped path '{}' does not exist.",
                path_buf.display()
            ));
        }

        if path_buf.is_dir() {
            folders.push(folder_node_from_path(&path_buf, &mut ids)?);
        } else if path_buf.is_file() {
            files.push(path);
        }
    }

    Ok(DroppedTemplateItems { folders, files })
}

fn preset_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = crate::core::storage::library_root(app)?.join("Presets");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    migrate_legacy_presets(app, &directory);
    Ok(directory)
}

// One-time move of presets from the old hidden per-app config dir into the visible
// Documents library, rewritten as one human-named file each. Marked done so it runs once.
fn migrate_legacy_presets(app: &AppHandle, new_dir: &Path) {
    let marker = new_dir.join(".migrated");
    if marker.exists() {
        return;
    }
    if let Ok(old_root) = crate::core::storage::app_data_root(app) {
        let old_dir = old_root.join("Presets");
        if old_dir.exists() && old_dir != *new_dir {
            if let Ok(entries) = fs::read_dir(&old_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|value| value.to_str()) != Some("preset") {
                        continue;
                    }
                    if let Ok(preset) = read_preset_file(&path) {
                        if let Ok(json) = serde_json::to_string_pretty(&preset) {
                            let _ = fs::write(preset_path_for(new_dir, &preset), json);
                        }
                    }
                }
            }
        }
    }
    let _ = fs::write(marker, "");
}

// The file for a preset is named after the preset (so it's readable in Finder and git),
// disambiguated only when a different preset already owns that filename.
fn preset_path_for(directory: &Path, preset: &Preset) -> PathBuf {
    let mut base = sanitize_filename(preset.name.trim());
    if base.is_empty() {
        base = sanitize_file_stem(&preset.id);
    }
    let candidate = directory.join(format!("{base}.preset"));
    if let Ok(existing) = read_preset_file(&candidate) {
        if existing.id != preset.id {
            let suffix: String = preset
                .id
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .take(6)
                .collect();
            return directory.join(format!("{base}_{suffix}.preset"));
        }
    }
    candidate
}

fn find_preset_file_by_id(app: &AppHandle, id: &str) -> Result<Option<PathBuf>, String> {
    let directory = preset_directory(app)?;
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("preset") {
            continue;
        }
        if let Ok(preset) = read_preset_file(&path) {
            if preset.id == id {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

fn folder_node_from_path(path: &Path, ids: &mut HashSet<String>) -> Result<FolderNode, String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Imported Folder")
        .to_string();
    let id = unique_folder_id(&name, ids);
    let mut child_paths = Vec::new();

    for entry in fs::read_dir(path).map_err(|error| format!("{}: {error}", path.display()))? {
        let entry = entry.map_err(|error| error.to_string())?;
        let child_path = entry.path();
        if child_path.is_dir() {
            child_paths.push(child_path);
        }
    }

    child_paths.sort_by(|left, right| {
        left.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_lowercase()
            .cmp(
                &right
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_lowercase(),
            )
    });

    let children = child_paths
        .iter()
        .map(|child_path| folder_node_from_path(child_path, ids))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(FolderNode {
        id,
        name_pattern: name,
        is_footage_destination: false,
        children,
        template_files: Vec::new(),
        condition: None,
        role: None,
    })
}

fn unique_folder_id(name: &str, ids: &mut HashSet<String>) -> String {
    let base = format!("folder_{}", sanitize_file_stem(&name.to_lowercase()))
        .trim_end_matches('_')
        .to_string();
    let base = if base == "folder" || base.is_empty() {
        "folder_imported".to_string()
    } else {
        base
    };
    let mut candidate = base.clone();
    let mut index = 2;

    while !ids.insert(candidate.clone()) {
        candidate = format!("{base}_{index}");
        index += 1;
    }

    candidate
}

fn read_preset_file(path: &Path) -> Result<Preset, String> {
    let json = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&json).map_err(|error| format!("{}: {error}", path.display()))
}

fn validate_preset(preset: &Preset) -> Result<(), String> {
    if preset.schema_version != 1 {
        return Err("Only preset schema version 1 is supported.".to_string());
    }
    if preset.id.trim().is_empty() {
        return Err("Preset id is required.".to_string());
    }
    if preset.name.trim().is_empty() {
        return Err("Preset name is required.".to_string());
    }
    if preset.root_folder_pattern.trim().is_empty() {
        return Err("Root folder pattern is required.".to_string());
    }
    if preset.file_rename_pattern.trim().is_empty() {
        return Err("File rename pattern is required.".to_string());
    }
    validate_variables(preset)?;
    validate_folder_tree(preset)?;

    Ok(())
}

fn validate_variables(preset: &Preset) -> Result<(), String> {
    let mut ids = HashSet::new();
    for variable in &preset.variables {
        if variable.id.trim().is_empty() {
            return Err(format!("Variable '{}' needs a token id.", variable.name));
        }
        if !ids.insert(variable.id.as_str()) {
            return Err(format!(
                "Duplicate variable token id '{{{}}}'.",
                variable.id
            ));
        }
        if variable.name.trim().is_empty() {
            return Err(format!("Variable '{}' needs a display name.", variable.id));
        }
    }

    Ok(())
}

fn validate_folder_tree(preset: &Preset) -> Result<(), String> {
    let mut ids = HashSet::new();
    let mut footage_destinations = 0;
    for folder in &preset.folder_tree {
        validate_folder_node(folder, &mut ids, &mut footage_destinations)?;
    }

    if !preset.folder_tree.is_empty() && footage_destinations == 0 {
        return Err("At least one folder must be marked as a footage destination.".to_string());
    }

    Ok(())
}

fn validate_folder_node(
    folder: &FolderNode,
    ids: &mut HashSet<String>,
    footage_destinations: &mut usize,
) -> Result<(), String> {
    if folder.id.trim().is_empty() {
        return Err("Folder id is required.".to_string());
    }
    if !ids.insert(folder.id.clone()) {
        return Err(format!("Duplicate folder id '{}'.", folder.id));
    }
    if folder.name_pattern.trim().is_empty() {
        return Err(format!("Folder '{}' needs a name pattern.", folder.id));
    }
    if folder.is_footage_destination {
        *footage_destinations += 1;
    }

    for child in &folder.children {
        validate_folder_node(child, ids, footage_destinations)?;
    }

    Ok(())
}

fn make_unique_preset(app: &AppHandle, mut preset: Preset) -> Result<Preset, String> {
    let original_name = preset.name.clone();
    let mut index = 1;
    while find_preset_file_by_id(app, &preset.id)?.is_some() {
        index += 1;
        let suffix = now_millis();
        preset.id = format!("{}_copy_{}", sanitize_file_stem(&preset.id), suffix);
        preset.name = format!("{original_name} Copy");
    }

    if index > 1 {
        preset.updated_at = chrono::Utc::now().to_rfc3339();
    }

    Ok(preset)
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn sanitize_file_stem(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect()
}

// Readable, filesystem-safe filename (keeps spaces) for the human-named preset files.
fn sanitize_filename(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || character == '-'
                || character == '_'
                || character == ' '
            {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}
