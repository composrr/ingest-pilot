use crate::core::preset::PresetVariable;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub global_parameters: Vec<PresetVariable>,
    #[serde(default)]
    pub ingest_defaults: IngestDefaults,
    #[serde(default)]
    pub report_defaults: ReportDefaults,
    #[serde(default)]
    pub camera_watcher: CameraWatcherSettings,
    #[serde(default)]
    pub file_selector: FileSelectorSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IngestDefaults {
    #[serde(default = "default_true")]
    pub auto_scan_sources: bool,
    #[serde(default = "default_true")]
    pub rename_files: bool,
    #[serde(default)]
    pub delete_sidecars: bool,
    #[serde(default = "default_copy_mode")]
    pub destination_mode: String,
    #[serde(default = "default_true")]
    pub open_folder_when_done: bool,
}

impl Default for IngestDefaults {
    fn default() -> Self {
        Self {
            auto_scan_sources: true,
            rename_files: true,
            delete_sidecars: false,
            destination_mode: default_copy_mode(),
            open_folder_when_done: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReportDefaults {
    #[serde(default = "default_true")]
    pub include_thumbnails: bool,
    #[serde(default = "default_true")]
    pub write_html_report: bool,
    #[serde(default)]
    pub open_report_when_done: bool,
    #[serde(default)]
    pub notes_template: String,
}

impl Default for ReportDefaults {
    fn default() -> Self {
        Self {
            include_thumbnails: true,
            write_html_report: true,
            open_report_when_done: false,
            notes_template: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CameraWatcherSettings {
    #[serde(default = "default_true")]
    pub auto_detect_cards: bool,
    #[serde(default)]
    pub prompt_on_card_detected: bool,
    #[serde(default)]
    pub tray_mode: bool,
}

impl Default for CameraWatcherSettings {
    fn default() -> Self {
        Self {
            auto_detect_cards: true,
            prompt_on_card_detected: false,
            tray_mode: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FileSelectorSettings {
    #[serde(default = "default_selector_view")]
    pub default_view: String,
    #[serde(default = "default_thumbnail_size")]
    pub thumbnail_size: u16,
    #[serde(default = "default_true")]
    pub group_by_date: bool,
}

impl Default for FileSelectorSettings {
    fn default() -> Self {
        Self {
            default_view: default_selector_view(),
            thumbnail_size: default_thumbnail_size(),
            group_by_date: true,
        }
    }
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }

    let json = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str(&json).map_err(|error| format!("{}: {error}", path.display()))
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: AppSettings) -> Result<AppSettings, String> {
    validate_settings(&settings)?;
    let path = settings_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let json = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())?;

    Ok(settings)
}

fn validate_settings(settings: &AppSettings) -> Result<(), String> {
    let mut ids = HashSet::new();
    for parameter in &settings.global_parameters {
        if parameter.id.trim().is_empty() {
            return Err(format!(
                "Global parameter '{}' needs a token id.",
                parameter.name
            ));
        }
        if parameter.name.trim().is_empty() {
            return Err(format!("Global parameter '{}' needs a name.", parameter.id));
        }
        if !ids.insert(parameter.id.as_str()) {
            return Err(format!("Duplicate global token '{{{}}}'.", parameter.id));
        }
    }

    if !matches!(
        settings.ingest_defaults.destination_mode.as_str(),
        "create_new" | "existing_root"
    ) {
        return Err("Default destination mode must be create_new or existing_root.".to_string());
    }
    if !matches!(
        settings.file_selector.default_view.as_str(),
        "list" | "thumbs"
    ) {
        return Err("Default file selector view must be list or thumbs.".to_string());
    }
    if !(80..=260).contains(&settings.file_selector.thumbnail_size) {
        return Err("Default thumbnail size must be between 80 and 260.".to_string());
    }

    Ok(())
}

fn default_true() -> bool {
    true
}

fn default_copy_mode() -> String {
    "create_new".to_string()
}

fn default_selector_view() -> String {
    "list".to_string()
}

fn default_thumbnail_size() -> u16 {
    142
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|error| error.to_string())?;
    Ok(documents.join("IngestPilot").join("settings.json"))
}
