use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

// The naming catalog (ministry codes, campuses, signifiers, and deliverable
// templates that encode the team's naming SOP) is stored as a single JSON file in
// the visible Documents library so it can be edited, versioned, and synced across
// machines like the presets. The frontend owns the shape and seeds the defaults on
// first run; the backend just persists whatever it's given.
fn catalog_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::core::storage::library_root(app)?.join("Naming");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("catalog.json"))
}

#[tauri::command]
pub fn get_naming_catalog(app: AppHandle) -> Result<Option<Value>, String> {
    let path = catalog_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let json = fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    let value = serde_json::from_str(&json).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(Some(value))
}

#[tauri::command]
pub fn save_naming_catalog(app: AppHandle, catalog: Value) -> Result<(), String> {
    let path = catalog_path(&app)?;
    let json = serde_json::to_string_pretty(&catalog).map_err(|error| error.to_string())?;
    fs::write(&path, json).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(())
}
