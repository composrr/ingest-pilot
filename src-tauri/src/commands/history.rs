use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IngestHistoryJob {
    pub id: String,
    #[serde(default)]
    pub preset_id: String,
    pub preset_name: String,
    #[serde(default)]
    pub variable_values: BTreeMap<String, String>,
    pub status: String,
    pub started_at: String,
    pub completed_at: String,
    pub source_paths: Vec<String>,
    pub destination_paths: Vec<String>,
    pub root_path: String,
    pub report_path: String,
    pub mhl_path: String,
    pub files_copied: usize,
    pub verified_files: usize,
    pub verification_failed: usize,
    pub bytes_copied: u64,
    #[serde(default)]
    pub sidecars_deleted: usize,
}

#[tauri::command]
pub fn list_history(app: AppHandle) -> Result<Vec<IngestHistoryJob>, String> {
    let path = history_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }

    let json = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str(&json).map_err(|error| format!("{}: {error}", path.display()))
}

#[tauri::command]
pub fn save_history_job(
    app: AppHandle,
    job: IngestHistoryJob,
) -> Result<Vec<IngestHistoryJob>, String> {
    let mut jobs = list_history(app.clone())?;
    jobs.retain(|current| current.id != job.id);
    jobs.insert(0, job);
    jobs.truncate(250);
    write_history(&app, &jobs)?;
    Ok(jobs)
}

#[tauri::command]
pub fn clear_history(app: AppHandle) -> Result<(), String> {
    let path = history_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn write_history(app: &AppHandle, jobs: &[IngestHistoryJob]) -> Result<(), String> {
    let path = history_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let json = serde_json::to_string_pretty(jobs).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())
}

fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::core::storage::app_data_root(app)?.join("history.json"))
}
