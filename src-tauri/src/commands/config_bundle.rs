// Export/import the whole app config as one portable file so a setup can move to a
// second machine (or be backed up) without re-typing everything. Bundles settings,
// presets, metadata presets, and the naming catalog. iconik credentials are stripped
// from the export for safety and the local connection is kept on import.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use tauri::AppHandle;

use crate::commands::settings::AppSettings;
use crate::core::metadata_preset::MetadataPreset;
use crate::core::preset::Preset;

#[derive(Debug, Serialize, Deserialize)]
pub struct ConfigBundle {
    pub version: u32,
    pub settings: AppSettings,
    #[serde(default)]
    pub presets: Vec<Preset>,
    #[serde(default)]
    pub metadata_presets: Vec<MetadataPreset>,
    #[serde(default)]
    pub naming_catalog: Option<Value>,
}

#[tauri::command]
pub fn export_config_bundle(app: AppHandle, path: String) -> Result<(), String> {
    let mut settings = crate::commands::settings::get_settings(app.clone())?;
    // Never write iconik credentials into a file that gets shared/backed up.
    settings.iconik.app_id.clear();
    settings.iconik.auth_token.clear();

    let mut presets = Vec::new();
    for summary in crate::commands::presets::list_presets(app.clone())? {
        if let Some(preset) = crate::commands::presets::get_preset(app.clone(), summary.id)? {
            presets.push(preset);
        }
    }

    let mut metadata_presets = Vec::new();
    for summary in crate::commands::metadata_presets::list_metadata_presets(app.clone())? {
        if let Some(preset) =
            crate::commands::metadata_presets::get_metadata_preset(app.clone(), summary.id)?
        {
            metadata_presets.push(preset);
        }
    }

    let naming_catalog = crate::commands::naming_catalog::get_naming_catalog(app.clone())?;

    let bundle = ConfigBundle {
        version: 1,
        settings,
        presets,
        metadata_presets,
        naming_catalog,
    };
    let json = serde_json::to_string_pretty(&bundle).map_err(|error| error.to_string())?;
    fs::write(&path, json).map_err(|error| format!("{path}: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn import_config_bundle(app: AppHandle, path: String) -> Result<(), String> {
    let json = fs::read_to_string(&path).map_err(|error| format!("{path}: {error}"))?;
    let bundle: ConfigBundle =
        serde_json::from_str(&json).map_err(|error| format!("Not a valid Ingest Pilot config file: {error}"))?;

    // Keep the local iconik connection (credentials were stripped on export) so an
    // import doesn't wipe the machine's own connection.
    let mut settings = bundle.settings;
    if settings.iconik.app_id.trim().is_empty() && settings.iconik.auth_token.trim().is_empty() {
        if let Ok(existing) = crate::commands::settings::get_settings(app.clone()) {
            settings.iconik = existing.iconik;
        }
    }
    crate::commands::settings::save_settings(app.clone(), settings)?;

    for preset in bundle.presets {
        let _ = crate::commands::presets::save_preset(app.clone(), preset);
    }
    for preset in bundle.metadata_presets {
        let _ = crate::commands::metadata_presets::save_metadata_preset(app.clone(), preset);
    }
    if let Some(catalog) = bundle.naming_catalog {
        let _ = crate::commands::naming_catalog::save_naming_catalog(app.clone(), catalog);
    }
    Ok(())
}
